// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

import { EventEmitter } from './events';

export class CoordinatorClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private isMobile: boolean;

  constructor(url: string) {
    super();
    this.url = url;
    this.isMobile = /Mobi|Android/i.test(navigator.userAgent);
  }

  connect() {
    let wsUrl = this.url;
    if (wsUrl.startsWith('http')) {
      wsUrl = wsUrl.replace('http', 'ws');
    }
    this.ws = new WebSocket(`${wsUrl}/ws`);
    
    this.ws.onopen = () => {
      this.ws?.send(JSON.stringify({ type: 'register', isMobile: this.isMobile }));
    };
    
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.emit('message', msg);
      } catch (e) {
        // Handle binary or non-json message
      }
    };
  }
  
  send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  getIsMobile() {
    return this.isMobile;
  }
}
