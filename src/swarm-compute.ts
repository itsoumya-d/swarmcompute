import { LicenseValidator } from "./license-validator";
// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { Task, TaskResult, WorkUnit } from './types';
import { EventEmitter } from './events';
import { CoordinatorClient } from './coordinator-client';
import { WorkerPool } from './worker-pool';
import { TaskScheduler } from './task-scheduler';
import { WasmRunner } from './wasm-runner';
import { PeerTransport } from './peer-transport';

export class SwarmCompute extends EventEmitter {
  private client: CoordinatorClient;
  private workerPool: WorkerPool;
  private taskScheduler: TaskScheduler;
  private peerTransport: PeerTransport;
  private p2pTaskResolvers = new Map<string, (res: any) => void>();

  constructor(options?: any) {
    LicenseValidator.validate(options);
    super();
    // Maintain backwards compatibility for tests/imports
    let coordinatorUrl = typeof options === 'string' ? options : (options?.coordinatorUrl || 'ws://localhost:8080');
    this.client = new CoordinatorClient(coordinatorUrl);
    this.workerPool = new WorkerPool(this.client);
    this.taskScheduler = new TaskScheduler(this.client);
    this.peerTransport = new PeerTransport();

    this.peerTransport.onTask(async (peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer) => {
        this.emit('task_routed_p2p', { peerId });
        const unit: WorkUnit = {
            id: crypto.randomUUID(),
            taskId: 'p2p-task',
            wasmModule: wasmBinary,
            input: inputData
        };
        const result = await WasmRunner.run(unit);
        this.peerTransport.sendTaskResult(peerId, result);
    });

    this.peerTransport.onTaskResult((result: any) => {
        this.emit('task_complete', result);
        if (result && result.taskId) {
            const resolver = this.p2pTaskResolvers.get(result.taskId);
            if (resolver) {
                resolver(result);
                this.p2pTaskResolvers.delete(result.taskId);
            }
        }
    });

    this.client.on('message', (msg: any) => {
      if (msg.type === 'task_assigned') {
        this.emit('task_assigned', msg.task);
        if (this.workerPool.getIsWorker()) {
           const wasmModuleBase64 = msg.task.wasmModule;
           const binaryString = atob(wasmModuleBase64);
           const bytes = new Uint8Array(binaryString.length);
           for (let i = 0; i < binaryString.length; i++) {
               bytes[i] = binaryString.charCodeAt(i);
           }
           msg.task.wasmModule = bytes.buffer;
           this.processTask(msg.task);
        }
      } else if (msg.type === 'worker_count') {
        this.emit('worker_joined', msg.count);
      }
    });
  }
  
  async submitTask(wasmModule: ArrayBuffer, input: any): Promise<TaskResult> {
    const task: Task = {
      id: crypto.randomUUID(),
      wasmModule,
      input,
      timeoutMs: 30000
    };
    
    // try P2P first
    const peers = this.peerTransport.getConnectedPeers();
    if (peers.length > 0) {
      const peerId = peers[0];
      this.emit('route_decision', { route: 'p2p', peerId });
      
      return new Promise<TaskResult>((resolve, reject) => {
          this.p2pTaskResolvers.set(task.id, resolve as any);
          try {
            // make sure input is ArrayBuffer
            let inputBuffer = input;
            if (!(inputBuffer instanceof ArrayBuffer)) {
                inputBuffer = new TextEncoder().encode(JSON.stringify(input)).buffer;
            }
            this.peerTransport.sendTask(peerId, wasmModule, inputBuffer);
          } catch(e) {
            this.emit('route_decision', { route: 'coordinator', fallback: true });
            this.p2pTaskResolvers.delete(task.id);
            this.taskScheduler.submitTask(task).then(resolve).catch(reject);
          }
      });
    }

    this.emit('route_decision', { route: 'coordinator' });
    return this.taskScheduler.submitTask(task);
  }
  
  async joinSwarm(): Promise<void> {
    this.client.connect();
    // Attempt P2P signaling connection to a signaling endpoint.
    // For now we assume the signaling runs on the same host but port 8081.
    try {
        await this.peerTransport.connect('ws://localhost:8081');
    } catch (e) {
        console.warn("Peer signaling connection failed", e);
    }
  }
  
  async leaveSwarm(): Promise<void> {
    // Disconnect
  }

  private async processTask(unit: WorkUnit) {
    const result = await WasmRunner.run(unit);
    this.emit('task_complete', result);
    this.client.send({ type: 'task_result', result });
  }
  
  get workerCount(): number {
    return this.workerPool.getWorkerCount();
  }
  
  get isWorker(): boolean {
    return this.workerPool.getIsWorker();
  }
}
