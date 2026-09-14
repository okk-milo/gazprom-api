import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  type AntifraudAnalysis,
  type CallHistoryItem,
  type CallSnapshot,
  type CallState,
  type Deal,
  type Employee,
  type TranscriptSegment,
} from './calls.types';

const CALL_HISTORY_PAGE_SIZE = 5;

interface EmployeeRow extends QueryResultRow {
  id: string;
  name: string;
}

interface DealRow extends QueryResultRow {
  id: string;
  title: string;
  employee_id: string;
}

interface CallRow extends QueryResultRow {
  id: string;
  deal_id: string;
  employee_id: string;
  file_name: string;
  source_key: string;
  state: CallState;
  revision: number;
  progress: number;
  transcript: unknown;
  analysis: unknown;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CallHistoryRow extends QueryResultRow {
  id: string;
  file_name: string;
  state: CallState;
  progress: number;
  score: number | null;
  deal_title: string;
  employee_name: string;
  created_at: Date;
}

interface CallHistoryCountRow extends QueryResultRow {
  total: number;
}

interface DatabaseClient {
  query<TRow extends QueryResultRow>(text: string, values?: unknown[]): Promise<TRow[]>;
}

@Injectable()
export class CallsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseClient) {}

  async ensureDemoData(): Promise<void> {
    const employees = await this.database.query<EmployeeRow>(
      'SELECT id, name FROM employees LIMIT 1',
    );

    if (employees.length > 0) {
      return;
    }

    const employeeId = randomUUID();
    const dealId = randomUUID();
    await this.database.query('INSERT INTO employees (id, name) VALUES ($1, $2)', [
      employeeId,
      'Сотрудник 1',
    ]);
    await this.database.query('INSERT INTO deals (id, title, employee_id) VALUES ($1, $2, $3)', [
      dealId,
      'Демонстрационная сделка',
      employeeId,
    ]);
  }

  async listEmployees(): Promise<Employee[]> {
    const rows = await this.database.query<EmployeeRow>(
      'SELECT id, name FROM employees ORDER BY created_at',
    );
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  async createEmployee(name?: string): Promise<Employee> {
    const defaultName = `Сотрудник ${(await this.listEmployees()).length + 1}`;
    const employee: Employee = { id: randomUUID(), name: name?.trim() || defaultName };
    await this.database.query('INSERT INTO employees (id, name) VALUES ($1, $2)', [
      employee.id,
      employee.name,
    ]);
    return employee;
  }

  async deleteEmployee(employeeId: string): Promise<'deleted' | 'not_found' | 'in_use'> {
    const deleted = await this.database.query<EmployeeRow>(
      `DELETE FROM employees
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM deals WHERE employee_id = $1)
         AND NOT EXISTS (SELECT 1 FROM calls WHERE employee_id = $1)
       RETURNING id, name`,
      [employeeId],
    );

    if (deleted[0]) {
      return 'deleted';
    }

    const existing = await this.database.query<Pick<EmployeeRow, 'id'>>(
      'SELECT id FROM employees WHERE id = $1',
      [employeeId],
    );

    return existing[0] ? 'in_use' : 'not_found';
  }

  async listDeals(): Promise<Deal[]> {
    const rows = await this.database.query<DealRow>(
      'SELECT id, title, employee_id FROM deals ORDER BY created_at',
    );
    return rows.map((row) => ({ id: row.id, title: row.title, employeeId: row.employee_id }));
  }

  async createDeal(employeeId: string, title: string): Promise<Deal> {
    const deal: Deal = { id: randomUUID(), title: title.trim(), employeeId };
    await this.database.query('INSERT INTO deals (id, title, employee_id) VALUES ($1, $2, $3)', [
      deal.id,
      deal.title,
      deal.employeeId,
    ]);
    return deal;
  }

  async createCall(
    dealId: string,
    employeeId: string,
    fileName: string,
    contentType: string,
    sourceKey: string,
  ): Promise<CallSnapshot> {
    const id = randomUUID();
    const rows = await this.database.query<CallRow>(
      `INSERT INTO calls (id, deal_id, employee_id, file_name, content_type, source_key, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'upload_pending')
       RETURNING *`,
      [id, dealId, employeeId, fileName, contentType, sourceKey],
    );
    return this.toSnapshot(this.requireRow(rows, id));
  }

  async markUploaded(callId: string): Promise<CallSnapshot | null> {
    return this.updateSnapshot(
      callId,
      `state = 'uploaded', progress = 5, analysis = NULL, revision = revision + 1, updated_at = now(), error_message = NULL`,
    );
  }

  async claimNextCall(): Promise<CallSnapshot | null> {
    const rows = await this.database.query<CallRow>(
      `WITH next_call AS (
        SELECT id FROM calls WHERE state = 'uploaded' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE calls SET state = 'transcribing', progress = 15, revision = revision + 1, updated_at = now()
      WHERE id IN (SELECT id FROM next_call)
      RETURNING *`,
    );
    return rows[0] ? this.toSnapshot(rows[0]) : null;
  }

  async saveTranscript(
    callId: string,
    transcript: TranscriptSegment[],
  ): Promise<CallSnapshot | null> {
    return this.updateSnapshot(
      callId,
      `state = 'analysing', progress = 65, transcript = $1::jsonb, revision = revision + 1, updated_at = now()`,
      [JSON.stringify(transcript)],
    );
  }

  async complete(callId: string, analysis: AntifraudAnalysis): Promise<CallSnapshot | null> {
    return this.updateSnapshot(
      callId,
      `state = 'completed', progress = 100, analysis = $1::jsonb, revision = revision + 1, updated_at = now()`,
      [JSON.stringify(analysis)],
    );
  }

  async saveAnalysisProgress(
    callId: string,
    transcript: TranscriptSegment[],
    analysis: AntifraudAnalysis,
    progress: number,
  ): Promise<CallSnapshot | null> {
    return this.updateSnapshot(
      callId,
      `state = 'analysing', transcript = $1::jsonb, analysis = $2::jsonb, progress = $3, revision = revision + 1, updated_at = now()`,
      [
        JSON.stringify(transcript),
        JSON.stringify(analysis),
        Math.min(99, Math.max(65, Math.round(progress))),
      ],
    );
  }

  async completeWithoutSpeech(
    callId: string,
    transcript: TranscriptSegment[],
  ): Promise<CallSnapshot | null> {
    return this.updateSnapshot(
      callId,
      `state = 'no_speech', progress = 100, transcript = $1::jsonb, analysis = NULL, error_message = NULL, revision = revision + 1, updated_at = now()`,
      [JSON.stringify(transcript)],
    );
  }

  async fail(callId: string, error: string): Promise<CallSnapshot | null> {
    return this.updateSnapshot(
      callId,
      `state = 'failed', progress = 100, analysis = NULL, error_message = $1, revision = revision + 1, updated_at = now()`,
      [error.slice(0, 500)],
    );
  }

  async getCall(callId: string): Promise<CallSnapshot | null> {
    const rows = await this.database.query<CallRow>('SELECT * FROM calls WHERE id = $1', [callId]);
    return rows[0] ? this.toSnapshot(rows[0]) : null;
  }

  async listCallHistory(page: number): Promise<{ items: CallHistoryItem[]; total: number }> {
    const countRows = await this.database.query<CallHistoryCountRow>(
      'SELECT count(*)::integer AS total FROM calls',
    );
    const rows = await this.database.query<CallHistoryRow>(
      `SELECT calls.id,
              calls.file_name,
              calls.state,
              calls.progress,
              (calls.analysis ->> 'score')::double precision AS score,
              deals.title AS deal_title,
              employees.name AS employee_name,
              calls.created_at
       FROM calls
       JOIN deals ON deals.id = calls.deal_id
       JOIN employees ON employees.id = calls.employee_id
       ORDER BY calls.created_at DESC
       LIMIT $1
       OFFSET $2`,
      [CALL_HISTORY_PAGE_SIZE, (page - 1) * CALL_HISTORY_PAGE_SIZE],
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        fileName: row.file_name,
        state: row.state,
        progress: row.progress,
        score: row.score,
        dealTitle: row.deal_title,
        employeeName: row.employee_name,
        createdAt: row.created_at.toISOString(),
      })),
      total: countRows[0]?.total ?? 0,
    };
  }

  async getSourceKey(callId: string): Promise<string | null> {
    const rows = await this.database.query<Pick<CallRow, 'source_key'>>(
      'SELECT source_key FROM calls WHERE id = $1',
      [callId],
    );
    return rows[0]?.source_key ?? null;
  }

  private async updateSnapshot(
    callId: string,
    assignments: string,
    values: readonly unknown[] = [],
  ): Promise<CallSnapshot | null> {
    const rows = await this.database.query<CallRow>(
      `UPDATE calls SET ${assignments} WHERE id = $${values.length + 1} RETURNING *`,
      [...values, callId],
    );
    return rows[0] ? this.toSnapshot(rows[0]) : null;
  }

  private requireRow(rows: CallRow[], callId: string): CallRow {
    const row = rows[0];

    if (!row) {
      throw new Error(`Unable to create call ${callId}`);
    }

    return row;
  }

  private toSnapshot(row: CallRow): CallSnapshot {
    return {
      id: row.id,
      dealId: row.deal_id,
      employeeId: row.employee_id,
      fileName: row.file_name,
      state: row.state,
      revision: row.revision,
      progress: row.progress,
      transcript: this.readTranscript(row.transcript),
      analysis: this.readAnalysis(row.analysis),
      error: row.error_message,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private readTranscript(value: unknown): TranscriptSegment[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((segment) => {
      if (!this.isRecord(segment)) {
        return [];
      }

      const id = this.readString(segment.id);
      const startMs = this.readFiniteNumber(segment.startMs);
      const endMs = this.readFiniteNumber(segment.endMs);
      const speaker = this.readString(segment.speaker);
      const text = this.readString(segment.text);
      const highlightRanges = this.readHighlightRanges(segment.highlightRanges);

      if (!id || startMs === null || endMs === null || endMs < startMs || !speaker || !text) {
        return [];
      }

      return [{ id, startMs, endMs, speaker, text, highlightRanges }];
    });
  }

  private readAnalysis(value: unknown): AntifraudAnalysis | null {
    if (!this.isRecord(value)) {
      return null;
    }

    const score = this.readScore(value.score);
    const factorsFor = this.readFactors(value.factorsFor);
    const factorsAgainst = this.readFactors(value.factorsAgainst);
    const timeline = this.readTimeline(value.timeline);
    const modelVersion = this.readString(value.modelVersion);

    if (
      score === null ||
      factorsFor === null ||
      factorsAgainst === null ||
      timeline === null ||
      !modelVersion
    ) {
      return null;
    }

    return { score, factorsFor, factorsAgainst, timeline, modelVersion };
  }

  private readFactors(value: unknown): AntifraudAnalysis['factorsFor'] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const factors: AntifraudAnalysis['factorsFor'] = [];

    for (const factor of value) {
      if (!this.isRecord(factor)) {
        return null;
      }

      const id = this.readString(factor.id);
      const title = this.readString(factor.title);
      const description = this.readString(factor.description);
      const confidence = this.readConfidence(factor.confidence);
      const segmentId = this.readString(factor.segmentId);

      if (!id || !title || !description || confidence === null || !segmentId) {
        return null;
      }

      factors.push({ id, title, description, confidence, segmentId });
    }

    return factors;
  }

  private readTimeline(value: unknown): AntifraudAnalysis['timeline'] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const points: AntifraudAnalysis['timeline'] = [];

    for (const point of value) {
      if (!this.isRecord(point)) {
        return null;
      }

      const timestampMs = this.readFiniteNumber(point.timestampMs);
      const score = this.readScore(point.score);
      if (timestampMs === null || timestampMs < 0 || score === null) {
        return null;
      }

      points.push({ timestampMs, score });
    }

    return points;
  }

  private readHighlightRanges(value: unknown): TranscriptSegment['highlightRanges'] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((range) => {
      if (!this.isRecord(range)) {
        return [];
      }

      const startOffset = this.readFiniteNumber(range.startOffset);
      const endOffset = this.readFiniteNumber(range.endOffset);
      const kind = range.kind;

      if (
        startOffset === null ||
        endOffset === null ||
        startOffset < 0 ||
        endOffset < startOffset ||
        (kind !== 'risk' && kind !== 'counter')
      ) {
        return [];
      }

      return [{ startOffset, endOffset, kind }];
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readScore(value: unknown): number | null {
    const score = this.readFiniteNumber(value);
    return score !== null && score >= 0 && score <= 100 ? score : null;
  }

  private readConfidence(value: unknown): number | null {
    const confidence = this.readFiniteNumber(value);
    return confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : null;
  }
}
