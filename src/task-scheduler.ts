import { Task, TaskResult, WorkUnit } from './types';
import { CoordinatorClient } from './coordinator-client';

export class TaskScheduler {
  private client: CoordinatorClient;
  
  constructor(client: CoordinatorClient) {
    this.client = client;
  }

  async submitTask(task: Task): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
       const handler = (msg: any) => {
         if (msg.type === 'task_complete' && msg.taskId === task.id) {
            resolve({
              taskId: task.id,
              result: msg.result,
              executionTimeMs: msg.executionTimeMs || 0
            });
         }
       };
       this.client.on('message', handler);
       
       this.client.send({
         type: 'submit_task',
         task: {
           id: task.id,
           input: task.input
         }
       });
    });
  }
}
