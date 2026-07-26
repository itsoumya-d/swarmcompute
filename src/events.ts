// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

type Callback = (...args: any[]) => void;

export class EventEmitter {
  private listeners: Record<string, Callback[]> = {};

  on(event: string, cb: Callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }

  emit(event: string, ...args: any[]) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(...args));
    }
  }

  off(event: string, cb: Callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(listener => listener !== cb);
    }
  }
}
