export interface Task {
  id: string;
  wasmModule: ArrayBuffer;
  input: any;
  timeoutMs: number;
}

export interface WorkUnit {
  id: string;
  taskId: string;
  wasmModule: ArrayBuffer;
  input: any;
}

export interface TaskResult {
  taskId: string;
  result: any;
  error?: string;
  executionTimeMs: number;
}

export interface WorkUnitResult {
  workUnitId: string;
  taskId: string;
  result: any;
  error?: string;
  executionTimeMs: number;
}
