export type CallState =
  | 'upload_pending'
  | 'uploaded'
  | 'transcribing'
  | 'analysing'
  | 'completed'
  | 'no_speech'
  | 'failed';

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
  highlightRanges: Array<{ startOffset: number; endOffset: number; kind: 'risk' | 'counter' }>;
}

export interface RiskPoint {
  timestampMs: number;
  score: number;
}

export interface AnalysisFactor {
  id: string;
  title: string;
  description: string;
  confidence: number;
  segmentId: string;
}

export interface AntifraudAnalysis {
  score: number;
  factorsFor: AnalysisFactor[];
  factorsAgainst: AnalysisFactor[];
  timeline: RiskPoint[];
  modelVersion: string;
}

export interface CallSnapshot {
  id: string;
  dealId: string;
  employeeId: string;
  fileName: string;
  state: CallState;
  revision: number;
  progress: number;
  transcript: TranscriptSegment[];
  analysis: AntifraudAnalysis | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallHistoryItem {
  id: string;
  fileName: string;
  state: CallState;
  progress: number;
  score: number | null;
  dealTitle: string;
  employeeName: string;
  createdAt: string;
}

export interface Employee {
  id: string;
  name: string;
}

export interface Deal {
  id: string;
  title: string;
  employeeId: string;
}
