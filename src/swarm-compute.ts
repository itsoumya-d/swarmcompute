import { LicenseValidator } from "./license-validator";
// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

import { Task, TaskResult, WorkUnit } from './types';
import { EventEmitter } from './events';
import { CoordinatorClient } from './coordinator-client';
import { WorkerPool } from './worker-pool';
import { TaskScheduler } from './task-scheduler';
import { WasmRunner } from './wasm-runner';
import { PeerTransport } from './peer-transport';

const DEFAULT_TASK_TIMEOUT_MS = 30000;

interface PendingP2PTask {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  peerId: string;
  timer: ReturnType<typeof setTimeout>;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export class SwarmCompute extends EventEmitter {
  private client: CoordinatorClient;
  private workerPool: WorkerPool;
  private taskScheduler: TaskScheduler;
  private peerTransport: PeerTransport;
  private session: AbortController | null = null;
  private joining: Promise<void> | null = null;
  private p2pTaskResolvers = new Map<string, PendingP2PTask>();

  constructor(options?: any) {
    LicenseValidator.validate(options);
    super();
    // Maintain backwards compatibility for tests/imports
    let coordinatorUrl = typeof options === 'string' ? options : (options?.coordinatorUrl || 'ws://localhost:8080');
    this.client = new CoordinatorClient(coordinatorUrl);
    this.workerPool = new WorkerPool(this.client);
    this.taskScheduler = new TaskScheduler(this.client);
    this.peerTransport = new PeerTransport();

    this.peerTransport.onTask(async (peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer, taskId: string) => {
        const session = this.session;
        if (!this.isCurrentSession(session)) return;
        this.emit('task_routed_p2p', { peerId, taskId });
        if (!this.isCurrentSession(session)) return;
        const unit: WorkUnit = {
            id: crypto.randomUUID(),
            // Echo back the submitter's task id so the reply can be correlated.
            // This was previously the constant 'p2p-task', which never matched
            // the submitter's generated id, so the P2P promise never settled.
            taskId,
            wasmModule: wasmBinary,
            input: inputData
        };
        const result = await WasmRunner.run(unit, session.signal);
        if (this.isCurrentSession(session)) this.peerTransport.sendTaskResult(peerId, result);
    });

    this.peerTransport.onTaskResult((result: any, peerId?: string) => {
        if (!this.session || !result || !result.taskId) return;
        const pending = this.p2pTaskResolvers.get(result.taskId);
        if (!pending) return;
        // Only the peer the task was actually dispatched to may answer it.
        // Result *values* are still not verified in any way — see the
        // "Known Limitations" section of the README.
        if (peerId !== undefined && peerId !== pending.peerId) {
            console.warn(
              `SwarmCompute: discarding a result for task ${result.taskId} from peer ${peerId}; ` +
              `the task was dispatched to ${pending.peerId}.`
            );
            return;
        }
        clearTimeout(pending.timer);
        this.p2pTaskResolvers.delete(result.taskId);
        pending.resolve(result);
        this.emit('task_complete', result);
    });

    this.client.on('disconnect', () => { void this.leaveSwarm(); });

    this.client.on('message', (msg: any) => {
      const session = this.session;
      if (!this.isCurrentSession(session)) return;
      if (msg?.type === 'task_assigned') {
        this.emit('task_assigned', msg.task);
        if (!this.isCurrentSession(session)) return;
        if (this.workerPool.getIsWorker()) {
           if (!msg.task || typeof msg.task.wasmModule !== 'string') {
             console.warn('SwarmCompute: ignoring task_assigned with no wasmModule payload');
             return;
           }
           let wasmModule: ArrayBuffer;
           try {
             // atob() throws on malformed base64. Left unguarded, that exception
             // escaped the WebSocket onmessage handler and prevented every
             // listener registered after this one from running, stalling all
             // in-flight submitTask() calls.
             wasmModule = base64ToArrayBuffer(msg.task.wasmModule);
           } catch (err) {
             console.warn('SwarmCompute: ignoring task_assigned with undecodable wasmModule', err);
             return;
           }
           // A WorkUnit needs `taskId` (the submitter's task id) as well as its
           // own `id`. Passing the coordinator's Task straight through left
           // taskId undefined, so every result was published with taskId ""
           // and no submitter could ever match it to its pending request.
           this.processTask({
             id: crypto.randomUUID(),
             taskId: msg.task.id,
             wasmModule,
             input: msg.task.input
           }, session);
        }
      } else if (msg?.type === 'worker_count') {
        this.emit('worker_joined', msg.count);
      }
    });
  }

  async submitTask(wasmModule: ArrayBuffer, input: any): Promise<TaskResult> {
    const session = this.session;
    if (!this.isCurrentSession(session)) throw this.disconnectedError();
    const task: Task = {
      id: crypto.randomUUID(),
      wasmModule,
      input,
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS
    };

    // try P2P first
    const peers = this.peerTransport.getConnectedPeers();
    if (peers.length > 0) {
      const peerId = peers[0];
      this.emit('route_decision', { route: 'p2p', peerId });
      if (!this.isCurrentSession(session)) throw this.disconnectedError();

      return new Promise<TaskResult>((resolve, reject) => {
          // A peer that never answers (left mid-task, or simply chose not to
          // reply) must not leave this promise pending forever, nor leave an
          // entry behind in p2pTaskResolvers. The task is not reassigned.
          const timer = setTimeout(() => {
            if (this.p2pTaskResolvers.get(task.id) !== pending) return;
            this.p2pTaskResolvers.delete(task.id);
            reject(new Error(
              `SwarmCompute: peer ${peerId} did not return a result for task ${task.id} ` +
              `within ${task.timeoutMs}ms. The task is not reassigned to another peer.`
            ));
          }, task.timeoutMs);

          const pending = { resolve: resolve as any, reject, peerId, timer };
          this.p2pTaskResolvers.set(task.id, pending);
          const fallback = () => {
            // A rejected async send can arrive after leave/rejoin. It must not
            // submit the old task on the new coordinator connection.
            if (this.p2pTaskResolvers.get(task.id) !== pending) return;
            clearTimeout(timer);
            this.p2pTaskResolvers.delete(task.id);
            this.emit('route_decision', { route: 'coordinator', fallback: true });
            if (!this.isCurrentSession(session)) {
              reject(this.disconnectedError());
              return;
            }
            this.taskScheduler.submitTask(task).then(resolve, reject);
          };
          try {
            // make sure input is ArrayBuffer
            let inputBuffer = input;
            if (!(inputBuffer instanceof ArrayBuffer)) {
                inputBuffer = new TextEncoder().encode(JSON.stringify(input)).buffer;
            }
            this.peerTransport.sendTask(peerId, wasmModule, inputBuffer, task.id).catch(fallback);
          } catch(e) {
            fallback();
          }
      });
    }

    this.emit('route_decision', { route: 'coordinator' });
    if (!this.isCurrentSession(session)) throw this.disconnectedError();
    return this.taskScheduler.submitTask(task);
  }

  joinSwarm(): Promise<void> {
    if (this.session) {
      if (this.joining) return this.joining;
      if (this.client.hasConnection() && this.peerTransport.hasConnection()) return Promise.resolve();
      // An explicit join after a terminal connection failure starts a clean
      // session rather than pretending the disconnected session is usable.
      void this.leaveSwarm();
    }
    const session = this.session = new AbortController();
    this.joining = (async () => {
      try {
        this.client.connect();
        // Signaling still uses the existing localhost endpoint.
        try {
          await this.peerTransport.connect('ws://localhost:8081');
        } catch (error) {
          if (!this.isCurrentSession(session)) throw this.disconnectedError();
          console.warn('Peer signaling connection failed', error);
        }
        if (!this.isCurrentSession(session)) throw this.disconnectedError();
      } catch (error) {
        if (this.isCurrentSession(session)) await this.leaveSwarm();
        throw error;
      } finally {
        if (this.isCurrentSession(session)) this.joining = null;
      }
    })();
    return this.joining;
  }

  async leaveSwarm(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.joining = null;
    session?.abort();
    const error = this.disconnectedError();
    this.taskScheduler.cancelAll(error);
    for (const pending of this.p2pTaskResolvers.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.p2pTaskResolvers.clear();
    this.client.disconnect();
    this.peerTransport.disconnect();
    this.workerPool.reset();
  }

  private isCurrentSession(session: AbortController | null): session is AbortController {
    return session !== null && this.session === session && !session.signal.aborted;
  }

  private disconnectedError(): Error {
    return new Error('SwarmCompute: disconnected from the swarm. Call joinSwarm() before submitting tasks.');
  }

  private async processTask(unit: WorkUnit, session: AbortController) {
    const result = await WasmRunner.run(unit, session.signal);
    if (!this.isCurrentSession(session)) return;
    this.emit('task_complete', result);
    if (this.isCurrentSession(session)) this.client.send({ type: 'task_result', result });
  }

  get workerCount(): number {
    return this.workerPool.getWorkerCount();
  }

  get isWorker(): boolean {
    return this.workerPool.getIsWorker();
  }
}
