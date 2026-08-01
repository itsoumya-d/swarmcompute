// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

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
