// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { WorkUnit, WorkUnitResult } from './types';

export class WasmRunner {
  static async run(unit: WorkUnit): Promise<WorkUnitResult> {
    const startTime = performance.now();
    
    return new Promise(async (resolve) => {
      let isDone = false;
      
      const timeout = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          resolve({
            workUnitId: unit.id,
            taskId: unit.taskId,
            result: null,
            error: 'Timeout exceeded (30 seconds)',
            executionTimeMs: performance.now() - startTime
          });
        }
      }, 30000);

      try {
        const module = await WebAssembly.compile(unit.wasmModule);
        const instance = await WebAssembly.instantiate(module, {
          env: {}
        });

        let output = null;
        if (instance.exports && typeof instance.exports.run === 'function') {
           // @ts-ignore
           output = instance.exports.run();
        }

        if (!isDone) {
          isDone = true;
          clearTimeout(timeout);
          resolve({
            workUnitId: unit.id,
            taskId: unit.taskId,
            result: output,
            executionTimeMs: performance.now() - startTime
          });
        }
      } catch (err: any) {
        if (!isDone) {
          isDone = true;
          clearTimeout(timeout);
          resolve({
            workUnitId: unit.id,
            taskId: unit.taskId,
            result: null,
            error: err.message,
            executionTimeMs: performance.now() - startTime
          });
        }
      }
    });
  }
}
