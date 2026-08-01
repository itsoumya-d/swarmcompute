// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

import { WorkUnit, WorkUnitResult } from './types';

/** Pages of WASM linear memory granted to a work unit (1 page = 64 KiB). */
const MEMORY_INITIAL_PAGES = 10;
const MEMORY_MAXIMUM_PAGES = 50;

/**
 * Wall-clock budget for the *asynchronous* phase of a work unit (compile and
 * instantiate).
 *
 * IMPORTANT — this timer does NOT preempt the guest.  A WebAssembly call is
 * synchronous: while `exports.run()` is on the stack the JavaScript event loop
 * cannot run, so this `setTimeout` callback cannot fire.  A guest containing an
 * unbounded loop will occupy the calling thread indefinitely and no timeout
 * here can stop it.
 *
 * Bounding guest CPU requires running the guest off-thread (a dedicated
 * `Worker`) and calling `Worker.terminate()` when the budget expires.  That is
 * the only mechanism the platform offers.  `WasmRunner` runs the guest on the
 * caller's thread, so callers must treat submitted modules as trusted.
 */
const ASYNC_PHASE_TIMEOUT_MS = 30000;

export class WasmRunner {
  static async run(unit: WorkUnit): Promise<WorkUnitResult> {
    const startTime = performance.now();

    return new Promise((resolve) => {
      let isDone = false;

      const settle = (fields: Partial<WorkUnitResult>) => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timeout);
        resolve({
          workUnitId: unit.id,
          taskId: unit.taskId,
          result: null,
          executionTimeMs: performance.now() - startTime,
          ...fields
        } as WorkUnitResult);
      };

      const timeout = setTimeout(() => {
        settle({
          error:
            `Timed out after ${ASYNC_PHASE_TIMEOUT_MS}ms while compiling or ` +
            `instantiating the module. Note: this timeout cannot interrupt a ` +
            `module that is already executing.`
        });
      }, ASYNC_PHASE_TIMEOUT_MS);

      (async () => {
        try {
          const module = await WebAssembly.compile(unit.wasmModule);

          // The host supplies the linear memory so that it can (a) bound the
          // allocation and (b) read the result back out afterwards.  A module
          // that declares its own memory instead of importing ours is not
          // executable under this contract: the host would read its own, unused
          // buffer and hand the caller silently-zeroed output, and the page cap
          // below would not apply to the module's own allocation.  Reject it.
          const importsHostMemory = WebAssembly.Module.imports(module).some(
            (i) => i.module === 'env' && i.name === 'memory' && i.kind === 'memory'
          );
          if (!importsHostMemory) {
            settle({
              error:
                'Module must import its linear memory as (import "env" "memory"). ' +
                'Modules that declare their own memory are rejected because the host ' +
                'cannot read their output or bound their allocation.'
            });
            return;
          }

          const memory = new WebAssembly.Memory({
            initial: MEMORY_INITIAL_PAGES,
            maximum: MEMORY_MAXIMUM_PAGES
          });
          const instance = await WebAssembly.instantiate(module, { env: { memory } });

          const run = instance.exports?.run;
          if (typeof run !== 'function') {
            settle({
              error: 'Module does not export a callable run() function.'
            });
            return;
          }

          // Write input into linear memory at offset 0.
          let inputLen = 0;
          if (unit.input instanceof ArrayBuffer) {
            inputLen = unit.input.byteLength;
            if (inputLen > memory.buffer.byteLength) {
              settle({
                error:
                  `Input of ${inputLen} bytes exceeds the ${memory.buffer.byteLength} ` +
                  `bytes of linear memory available to a work unit.`
              });
              return;
            }
            new Uint8Array(memory.buffer).set(new Uint8Array(unit.input), 0);
          }

          const returned = (run as (n: number) => unknown)(inputLen);

          // The guest controls this value; treat it as untrusted.  Re-read
          // memory.buffer first, since a memory.grow() inside the guest
          // detaches the previous ArrayBuffer.
          const buffer = memory.buffer;
          let output: ArrayBuffer | null = null;
          if (typeof returned === 'number') {
            if (!Number.isInteger(returned) || returned < 0 || returned > buffer.byteLength) {
              settle({
                error:
                  `run() returned an invalid output length (${returned}); expected an ` +
                  `integer between 0 and ${buffer.byteLength}.`
              });
              return;
            }
            output = buffer.slice(0, returned);
          }

          const durationMs = performance.now() - startTime;
          settle({
            result: { output, metrics: { durationMs, memoryBytes: buffer.byteLength } },
            executionTimeMs: durationMs
          });
        } catch (err: any) {
          settle({ error: err?.message ?? String(err) });
        }
      })();
    });
  }
}
