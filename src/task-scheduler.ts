// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

import { Task, TaskResult } from './types';
import { CoordinatorClient } from './coordinator-client';

const DEFAULT_TASK_TIMEOUT_MS = 30000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[]
    );
  }
  return btoa(binary);
}

export class TaskScheduler {
  private client: CoordinatorClient;

  constructor(client: CoordinatorClient) {
    this.client = client;
  }

  async submitTask(task: Task): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      const timeoutMs = task.timeoutMs > 0 ? task.timeoutMs : DEFAULT_TASK_TIMEOUT_MS;

      const cleanup = () => {
        clearTimeout(timer);
        this.client.off('message', handler);
      };

      const handler = (msg: any) => {
        // msg.result arrives from the network and may be absent; reading
        // .taskId off undefined would throw out of the WebSocket onmessage
        // handler and stall every other in-flight submission.
        if (msg?.type !== 'task_result' || !msg.result) return;
        if (msg.result.taskId !== task.id) return;
        cleanup();
        resolve({
          taskId: task.id,
          result: msg.result.result,
          error: msg.result.error,
          executionTimeMs: msg.result.executionTimeMs || 0
        });
      };

      // Without this the promise never settles when no worker answers, and the
      // listener stays registered for the lifetime of the page (one leaked
      // listener plus one retained task closure per submitTask call).
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `SwarmCompute: task ${task.id} was not answered within ${timeoutMs}ms. ` +
              `Results are relayed by the coordinator and are NOT verified: a task can go ` +
              `unanswered because no worker is connected, because the worker left mid-task, ` +
              `or because its reply was malformed. There is no reassignment or retry.`
          )
        );
      }, timeoutMs);

      this.client.on('message', handler);

      this.client.send({
        type: 'submit_task',
        task: {
          id: task.id,
          input: task.input,
          timeoutMs,
          wasmModule: arrayBufferToBase64(task.wasmModule)
        }
      });
    });
  }
}
