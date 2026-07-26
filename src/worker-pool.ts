// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

import { CoordinatorClient } from './coordinator-client';

export class WorkerPool {
  private client: CoordinatorClient;
  private workerCount: number = 0;
  private isWorkerNode: boolean = false;

  constructor(client: CoordinatorClient) {
    this.client = client;
    this.isWorkerNode = !client.getIsMobile(); // Mobile browsers are submitters only

    this.client.on('message', (msg: any) => {
      if (msg.type === 'worker_count') {
        this.workerCount = msg.count;
      }
    });
  }

  getWorkerCount(): number {
    return this.workerCount;
  }

  getIsWorker(): boolean {
    return this.isWorkerNode;
  }
}
