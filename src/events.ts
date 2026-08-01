// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

type Callback = (...args: any[]) => void;

export class EventEmitter {
  private listeners: Record<string, Callback[]> = {};

  on(event: string, cb: Callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }

  emit(event: string, ...args: any[]) {
    const registered = this.listeners[event];
    if (!registered) return;
    // Iterate a copy so a listener that calls on()/off() during dispatch
    // cannot mutate the list being walked.
    for (const cb of registered.slice()) {
      try {
        cb(...args);
      } catch (err) {
        // A throwing listener must not prevent the remaining listeners from
        // running. Internal listeners are registered before caller-supplied
        // ones (e.g. TaskScheduler's per-submission result handler), so letting
        // an exception escape here stalls every in-flight task submission.
        console.error(`SwarmCompute: listener for "${event}" threw`, err);
      }
    }
  }

  off(event: string, cb: Callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(listener => listener !== cb);
    }
  }
}
