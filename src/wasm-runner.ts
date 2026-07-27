// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { WorkUnit, WorkUnitResult } from './types';

export class WasmRunner {
  static async run(unit: WorkUnit): Promise<WorkUnitResult> {
    const startTime = performance.now();
    let memoryBytes = 0;
    
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
        const memory = new WebAssembly.Memory({ initial: 10, maximum: 100 });
        const instance = await WebAssembly.instantiate(module, {
          env: { memory }
        });

        // Write input data to WASM linear memory if provided
        let inputLen = 0;
        if (unit.input instanceof ArrayBuffer) {
          inputLen = unit.input.byteLength;
          const inputView = new Uint8Array(unit.input);
          const memView = new Uint8Array(memory.buffer);
          memView.set(inputView, 0); // Write at offset 0
        }

        let output = null;
        if (instance.exports && typeof instance.exports.run === 'function') {
           // @ts-ignore
           const outputLen = instance.exports.run(inputLen);
           if (typeof outputLen === 'number') {
             output = memory.buffer.slice(0, outputLen);
           }
        }

        memoryBytes = memory.buffer.byteLength;
        const durationMs = performance.now() - startTime;

        if (!isDone) {
          isDone = true;
          clearTimeout(timeout);
          resolve({
            workUnitId: unit.id,
            taskId: unit.taskId,
            result: {
              output: output as ArrayBuffer,
              metrics: {
                durationMs,
                memoryBytes
              }
            },
            executionTimeMs: durationMs
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
