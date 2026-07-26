import { Task, TaskResult, WorkUnit } from './types';
import { EventEmitter } from './events';
import { CoordinatorClient } from './coordinator-client';
import { WorkerPool } from './worker-pool';
import { TaskScheduler } from './task-scheduler';
import { WasmRunner } from './wasm-runner';

export class SwarmCompute extends EventEmitter {
  private client: CoordinatorClient;
  private workerPool: WorkerPool;
  private taskScheduler: TaskScheduler;

  constructor(coordinatorUrl: string) {
    super();
    this.client = new CoordinatorClient(coordinatorUrl);
    this.workerPool = new WorkerPool(this.client);
    this.taskScheduler = new TaskScheduler(this.client);

    this.client.on('message', (msg: any) => {
      if (msg.type === 'task_assigned') {
        this.emit('task_assigned', msg.task);
        if (this.workerPool.getIsWorker()) {
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
    return this.taskScheduler.submitTask(task);
  }
  
  async joinSwarm(): Promise<void> {
    this.client.connect();
  }
  
  async leaveSwarm(): void {
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
