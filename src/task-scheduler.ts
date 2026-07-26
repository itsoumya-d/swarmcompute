import { Task, TaskResult } from './types';
import { CoordinatorClient } from './coordinator-client';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
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
       const handler = (msg: any) => {
         if (msg.type === 'task_result' && msg.result.taskId === task.id) {
            this.client.off('message', handler);
            resolve({
              taskId: task.id,
              result: msg.result.result,
              executionTimeMs: msg.result.executionTimeMs || 0
            });
         }
       };
       this.client.on('message', handler);
       
       this.client.send({
         type: 'submit_task',
         task: {
           id: task.id,
           input: task.input,
           wasmModule: arrayBufferToBase64(task.wasmModule)
         }
       });
    });
  }
}
