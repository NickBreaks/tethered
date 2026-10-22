export interface OutputEntry {
  type: 'log' | 'warn' | 'error' | 'result' | 'system';
  content: string;
  timestamp: number;
}

export interface ExecutionResult {
  success: boolean;
  output: OutputEntry[];
  error?: string;
  timedOut: boolean;
  durationMs: number;
}
