import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { buildAssessmentWindows, mergeAssessment } from './assessment-windows';
import {
  type AnalysisFactor,
  type AntifraudAnalysis,
  type TranscriptSegment,
} from '../calls/calls.types';

interface AsrResponse {
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker_id?: string | null;
  }>;
}

interface LlmFactor {
  title: string;
  description: string;
  confidence: number;
  segment_index: number;
  quote: string;
}

interface LlmTimelinePoint {
  segment_index: number;
  score: number;
}

interface LlmSpeakerRole {
  speaker: string;
  role: 'client' | 'operator' | 'unknown';
}

interface LlmSegmentRole {
  segment_index: number;
  role: 'client' | 'operator' | 'unknown';
}

interface LlmResponse {
  score: number;
  factors_for: LlmFactor[];
  factors_against: LlmFactor[];
  timeline: LlmTimelinePoint[];
  speaker_roles: LlmSpeakerRole[];
  segment_roles: LlmSegmentRole[];
  model_version: string;
  summary: string;
}

interface WindowContext {
  score: number;
  summary: string;
  last_turns: Array<{ role: 'operator' | 'client' | 'unknown'; text: string }>;
}

type ProgressCallback = (
  analysis: AntifraudAnalysis,
  processed: number,
  total: number,
) => Promise<void>;

@Injectable()
export class ProcessingClients {
  constructor(private readonly config: AppConfig) {}

  async transcribe(sourceUrl: string): Promise<TranscriptSegment[]> {
    if (this.config.mockProcessingEnabled) {
      return this.mockTranscript();
    }

    if (!this.config.asrInternalUrl) {
      throw new Error('ASR_INTERNAL_URL is not configured');
    }

    const response = await this.requestAsr(sourceUrl);
    const payload = this.readAsrResponse(await response.json());
    return payload.segments.map((segment) => ({
      id: randomUUID(),
      startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000),
      speaker: segment.speaker_id?.trim() || 'Неизвестный',
      text: segment.text.trim(),
      highlightRanges: [],
    }));
  }

  async assess(
    transcript: TranscriptSegment[],
    onProgress?: ProgressCallback,
  ): Promise<AntifraudAnalysis> {
    if (this.config.mockProcessingEnabled) {
      return this.mockAnalysis(transcript);
    }

    if (!this.config.llmInternalUrl) {
      throw new Error('LLM_INTERNAL_URL is not configured');
    }

    let previous: WindowContext | undefined;
    let analysis: AntifraudAnalysis | null = null;
    let processed = 0;
    for (const window of buildAssessmentWindows(transcript)) {
      const response = await this.requestLlm(window, previous);
      const result = this.readLlmResponse(await response.json());
      const current = this.toAnalysis(result, window);
      analysis = mergeAssessment(analysis, current);
      previous = {
        score: result.score,
        summary: result.summary,
        last_turns: window.slice(-2).map((segment) => ({
          role:
            segment.speaker === 'Оператор'
              ? 'operator'
              : segment.speaker === 'Клиент'
                ? 'client'
                : 'unknown',
          text: segment.text.slice(-400),
        })),
      };
      processed += window.length;
      await onProgress?.(analysis, processed, transcript.length);
    }
    if (!analysis) throw new Error('Cannot assess an empty transcript');
    return analysis;
  }

  private internalHeaders(token: string | undefined): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async requestAsr(sourceUrl: string): Promise<Response> {
    if (!this.config.asrInternalUrl) {
      throw new Error('ASR_INTERNAL_URL is not configured');
    }

    for (let attempt = 1; attempt <= this.config.asrTranscriptionRetryAttempts; attempt += 1) {
      const response = await fetch(this.config.asrInternalUrl, {
        method: 'POST',
        headers: this.internalHeaders(this.config.asrInternalToken),
        body: JSON.stringify({ source_url: sourceUrl, profile: 'fast' }),
      });

      if (response.ok) {
        return response;
      }

      if (response.status !== 503 || attempt === this.config.asrTranscriptionRetryAttempts) {
        throw new Error(`ASR request failed with HTTP ${response.status}`);
      }

      await this.wait(this.config.asrTranscriptionRetryDelayMs);
    }

    throw new Error('ASR request could not be completed');
  }

  private async requestLlm(
    transcript: TranscriptSegment[],
    previous?: WindowContext,
  ): Promise<Response> {
    if (!this.config.llmInternalUrl) {
      throw new Error('LLM_INTERNAL_URL is not configured');
    }

    const body = JSON.stringify({
      ...(previous ? { previous } : {}),
      transcript: transcript.map((segment) => ({
        start_ms: segment.startMs,
        end_ms: segment.endMs,
        speaker: segment.speaker,
        text: segment.text,
      })),
    });

    for (let attempt = 1; attempt <= this.config.llmAssessmentRetryAttempts; attempt += 1) {
      const response = await fetch(`${this.config.llmInternalUrl.replace(/\/$/, '')}/windows`, {
        method: 'POST',
        headers: this.internalHeaders(this.config.llmInternalToken),
        body,
      });

      if (response.ok) {
        return response;
      }

      if (response.status !== 503 || attempt === this.config.llmAssessmentRetryAttempts) {
        throw new Error(`LLM request failed with HTTP ${response.status}`);
      }

      await this.wait(this.config.llmAssessmentRetryDelayMs);
    }

    throw new Error('LLM request could not be completed');
  }

  private async wait(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  private readAsrResponse(value: unknown): AsrResponse {
    const record = this.readRecord(value, 'Invalid ASR response');
    const segments = record.segments;

    if (!Array.isArray(segments)) {
      throw new Error('ASR response does not contain segments');
    }

    return {
      segments: segments.map((segment) => {
        const item = this.readRecord(segment, 'Invalid ASR segment');
        const speakerId = item.speaker_id;
        return {
          start: this.readNumber(item.start, 'Invalid ASR segment start'),
          end: this.readNumber(item.end, 'Invalid ASR segment end'),
          text: this.readString(item.text, 'Invalid ASR segment text'),
          speaker_id:
            speakerId === undefined || speakerId === null
              ? null
              : this.readString(speakerId, 'Invalid ASR speaker'),
        };
      }),
    };
  }

  private readLlmResponse(value: unknown): LlmResponse {
    const record = this.readRecord(value, 'Invalid LLM response');
    return {
      score: this.readScore(record.score),
      factors_for: this.readFactors(record.factors_for, 'factors_for'),
      factors_against: this.readFactors(record.factors_against, 'factors_against'),
      timeline: this.readTimeline(record.timeline),
      speaker_roles: this.readSpeakerRoles(record.speaker_roles),
      segment_roles: this.readSegmentRoles(record.segment_roles),
      model_version: this.readString(record.model_version, 'Invalid LLM model version'),
      summary: this.readString(record.summary, 'Invalid LLM context summary'),
    };
  }

  private readFactors(value: unknown, fieldName: string): LlmFactor[] {
    if (!Array.isArray(value)) {
      throw new Error(`LLM response ${fieldName} must be an array`);
    }

    return value.map((factor) => {
      const item = this.readRecord(factor, `Invalid LLM ${fieldName} factor`);
      return {
        title: this.readString(item.title, `Invalid LLM ${fieldName} title`),
        description: this.readString(item.description, `Invalid LLM ${fieldName} description`),
        confidence: this.readConfidence(item.confidence),
        segment_index: this.readIndex(item.segment_index),
        quote: this.readString(item.quote, 'Invalid evidence quote'),
      };
    });
  }

  private toAnalysis(response: LlmResponse, transcript: TranscriptSegment[]): AntifraudAnalysis {
    const rolesByIndex = new Map(
      response.segment_roles.map((role) => [role.segment_index, role.role]),
    );
    if (
      rolesByIndex.size !== transcript.length ||
      transcript.some((_, index) => !rolesByIndex.has(index))
    ) {
      throw new Error('LLM returned incomplete segment roles');
    }
    for (const factor of [...response.factors_for, ...response.factors_against]) {
      if (!transcript[factor.segment_index]?.text.includes(factor.quote)) {
        throw new Error('LLM evidence quote is not present in the referenced segment');
      }
    }
    this.applySpeakerRoles(transcript, response.speaker_roles, response.segment_roles);
    this.applyHighlights(transcript, response.factors_for, 'risk');
    this.applyHighlights(transcript, response.factors_against, 'counter');

    return {
      score: response.score,
      factorsFor: this.toFactors(response.factors_for, transcript),
      factorsAgainst: this.toFactors(response.factors_against, transcript),
      timeline: this.toTimeline(response, transcript),
      modelVersion: response.model_version,
    };
  }

  private readTimeline(value: unknown): LlmTimelinePoint[] {
    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error('LLM response timeline must be an array');
    }

    return value.map((point) => {
      const item = this.readRecord(point, 'Invalid LLM timeline point');
      return {
        segment_index: this.readIndex(item.segment_index),
        score: this.readScore(item.score),
      };
    });
  }

  private readSpeakerRoles(value: unknown): LlmSpeakerRole[] {
    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error('LLM response speaker_roles must be an array');
    }

    return value.flatMap((item) => {
      const role = this.readRecord(item, 'Invalid LLM speaker role');
      const value = this.readString(role.role, 'Invalid LLM speaker role value');

      if (value !== 'client' && value !== 'operator' && value !== 'unknown') {
        throw new Error('Invalid LLM speaker role value');
      }

      return [{ speaker: this.readString(role.speaker, 'Invalid LLM speaker id'), role: value }];
    });
  }

  private readSegmentRoles(value: unknown): LlmSegmentRole[] {
    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error('LLM response segment_roles must be an array');
    }

    return value.map((item) => {
      const role = this.readRecord(item, 'Invalid LLM segment role');
      const value = this.readString(role.role, 'Invalid LLM segment role value');

      if (value !== 'client' && value !== 'operator' && value !== 'unknown') {
        throw new Error('Invalid LLM segment role value');
      }

      return { segment_index: this.readIndex(role.segment_index), role: value };
    });
  }

  private toTimeline(
    response: LlmResponse,
    transcript: TranscriptSegment[],
  ): AntifraudAnalysis['timeline'] {
    // One real assessment of the prefix ending at this window, never fabricated variation.
    const lastSegment = transcript[transcript.length - 1];
    return lastSegment ? [{ timestampMs: lastSegment.endMs, score: response.score }] : [];
  }

  private applySpeakerRoles(
    transcript: TranscriptSegment[],
    speakerRoles: LlmSpeakerRole[],
    segmentRoles: LlmSegmentRole[],
  ): void {
    const roleBySpeaker = new Map(speakerRoles.map((role) => [role.speaker, role.role]));
    const roleBySegment = new Map(segmentRoles.map((role) => [role.segment_index, role.role]));
    const aliases = new Map<string, string>();

    for (const [index, segment] of transcript.entries()) {
      const role = roleBySegment.get(index) ?? roleBySpeaker.get(segment.speaker);

      if (role === 'client') {
        segment.speaker = 'Клиент';
      } else if (role === 'operator') {
        segment.speaker = 'Оператор';
      } else if (role === 'unknown') {
        segment.speaker = 'Неизвестный';
      } else if (segment.speaker !== 'Неизвестный' && !this.isDisplaySpeaker(segment.speaker)) {
        const alias = aliases.get(segment.speaker) ?? `Собеседник ${aliases.size + 1}`;
        aliases.set(segment.speaker, alias);
        segment.speaker = alias;
      }
    }
  }

  private isDisplaySpeaker(value: string): boolean {
    return value === 'Клиент' || value === 'Оператор' || value === 'Автоответчик';
  }

  private toFactors(factors: LlmFactor[], transcript: TranscriptSegment[]): AnalysisFactor[] {
    return factors.flatMap((factor) => {
      const segment = transcript[factor.segment_index];

      if (!segment) {
        return [];
      }

      return [
        {
          id: randomUUID(),
          title: factor.title,
          description: factor.description,
          confidence: factor.confidence,
          segmentId: segment.id,
        },
      ];
    });
  }

  private applyHighlights(
    transcript: TranscriptSegment[],
    factors: LlmFactor[],
    kind: 'risk' | 'counter',
  ): void {
    for (const factor of factors) {
      const segment = transcript[factor.segment_index];

      if (!segment || segment.text.length === 0) {
        continue;
      }

      const startOffset = segment.text.indexOf(factor.quote);
      if (startOffset >= 0)
        segment.highlightRanges.push({
          startOffset,
          endOffset: startOffset + factor.quote.length,
          kind,
        });
    }
  }

  private mockTranscript(): TranscriptSegment[] {
    return [
      {
        id: randomUUID(),
        startMs: 9000,
        endMs: 14000,
        speaker: 'Клиент',
        text: 'Мне срочно нужно снять блокировку, мне уже звонила служба безопасности.',
        highlightRanges: [{ startOffset: 3, endOffset: 9, kind: 'risk' }],
      },
      {
        id: randomUUID(),
        startMs: 15000,
        endMs: 23000,
        speaker: 'Клиент',
        text: 'Мне сказали перевести деньги на резервный счёт, чтобы их не списали.',
        highlightRanges: [{ startOffset: 31, endOffset: 47, kind: 'risk' }],
      },
      {
        id: randomUUID(),
        startMs: 28000,
        endMs: 35000,
        speaker: 'Оператор',
        text: 'Банк не просит переводить средства на резервные счета. Я уточню детали операции.',
        highlightRanges: [],
      },
    ];
  }

  private mockAnalysis(transcript: TranscriptSegment[]): AntifraudAnalysis {
    const riskSegment = transcript[1] ?? transcript[0];
    const counterSegment = transcript[2] ?? transcript[0];

    if (!riskSegment || !counterSegment) {
      throw new Error('Mock transcript is unexpectedly empty');
    }

    return {
      score: 72,
      factorsFor: [
        {
          id: randomUUID(),
          title: 'Упоминание резервного счёта',
          description: 'Клиент сообщил о переводе на резервный счёт по инструкции третьих лиц.',
          confidence: 0.94,
          segmentId: riskSegment.id,
        },
        {
          id: randomUUID(),
          title: 'Давление срочностью',
          description: 'Клиент подчёркивает срочность разблокировки операции.',
          confidence: 0.88,
          segmentId: transcript[0]?.id ?? riskSegment.id,
        },
      ],
      factorsAgainst: [
        {
          id: randomUUID(),
          title: 'Корректировка оператором',
          description:
            'Оператор объяснил, что банк не просит переводить средства на резервные счета.',
          confidence: 0.77,
          segmentId: counterSegment.id,
        },
      ],
      timeline: [
        { timestampMs: 14000, score: 38 },
        { timestampMs: 23000, score: 72 },
        { timestampMs: 35000, score: 64 },
      ],
      modelVersion: 'mock-antifraud-v1',
    };
  }

  private readRecord(value: unknown, message: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(message);
    }

    return value as Record<string, unknown>;
  }

  private readString(value: unknown, message: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(message);
    }

    return value;
  }

  private readNumber(value: unknown, message: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(message);
    }

    return value;
  }

  private readIndex(value: unknown): number {
    const index = this.readNumber(value, 'Invalid LLM segment index');

    if (!Number.isInteger(index) || index < 0) {
      throw new Error('Invalid LLM segment index');
    }

    return index;
  }

  private readScore(value: unknown): number {
    const score = this.readNumber(value, 'Invalid LLM score');

    if (score < 0 || score > 100) {
      throw new Error('LLM score must be in range 0..100');
    }

    return score;
  }

  private readConfidence(value: unknown): number {
    const confidence = this.readNumber(value, 'Invalid LLM confidence');

    if (confidence < 0 || confidence > 1) {
      throw new Error('LLM confidence must be in range 0..1');
    }

    return confidence;
  }
}
