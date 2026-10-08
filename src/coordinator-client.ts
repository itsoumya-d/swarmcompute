// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

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
    if (this.hasConnection()) return;
    this.disconnect();
    const ws = this.ws = new WebSocket(`${wsUrl}/ws`);
    
    this.ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ type: 'register', isMobile: this.isMobile }));
    };
    
    const disconnected = () => {
      if (this.ws !== ws) return;
      this.disconnect();
      this.emit('disconnect');
    };
    ws.onclose = disconnected;
    ws.onerror = disconnected;

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
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

  hasConnection(): boolean {
    return this.ws !== null && (this.ws.readyState === 0 || this.ws.readyState === WebSocket.OPEN);
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch {}
  }

  getIsMobile() {
    return this.isMobile;
  }
}
