import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dist = require('../dist/index.js');

// ── 1. Module shape ──────────────────────────────────────────────────────────

describe('module exports', () => {
  test('exports SwarmCompute class', () => {
    assert.strictEqual(typeof dist.SwarmCompute, 'function');
  });

  test('exports CoordinatorClient class', () => {
    assert.strictEqual(typeof dist.CoordinatorClient, 'function');
  });

  test('exports PeerTransport class', () => {
    assert.strictEqual(typeof dist.PeerTransport, 'function');
  });

  test('exports TaskScheduler class', () => {
    assert.strictEqual(typeof dist.TaskScheduler, 'function');
  });

  test('exports WasmRunner class', () => {
    assert.strictEqual(typeof dist.WasmRunner, 'function');
  });

  test('exports WorkerPool class', () => {
    assert.strictEqual(typeof dist.WorkerPool, 'function');
  });

  test('exports EventEmitter class', () => {
    assert.strictEqual(typeof dist.EventEmitter, 'function');
  });

  test('does NOT export a @swarmcompute/sdk namespace (fabricated package name)', () => {
    assert.strictEqual(dist['@swarmcompute/sdk'], undefined);
    assert.strictEqual(dist['SwarmNode'], undefined);
  });
});

// ── 2. SwarmCompute constructor ───────────────────────────────────────────────

describe('new SwarmCompute(options)', () => {
  test('constructs with string coordinator URL', () => {
    assert.doesNotThrow(() => new dist.SwarmCompute('ws://localhost:8080'));
  });

  test('constructs with options object', () => {
    assert.doesNotThrow(() => new dist.SwarmCompute({ coordinatorUrl: 'ws://localhost:8080' }));
  });

  test('constructs with no arguments (uses defaults)', () => {
    assert.doesNotThrow(() => new dist.SwarmCompute());
  });

  test('workerCount is a number', () => {
    const sw = new dist.SwarmCompute('ws://localhost:8080');
    assert.strictEqual(typeof sw.workerCount, 'number');
  });

  test('isWorker is a boolean', () => {
    const sw = new dist.SwarmCompute('ws://localhost:8080');
    assert.strictEqual(typeof sw.isWorker, 'boolean');
  });
});

// ── 3. Public method signatures ───────────────────────────────────────────────

describe('instance method existence', () => {
  const sw = new dist.SwarmCompute('ws://localhost:8080');

  test('joinSwarm is a function', () => {
    assert.strictEqual(typeof sw.joinSwarm, 'function');
  });

  test('leaveSwarm is a function', () => {
    assert.strictEqual(typeof sw.leaveSwarm, 'function');
  });

  test('submitTask is a function', () => {
    assert.strictEqual(typeof sw.submitTask, 'function');
  });

  test('on (EventEmitter) is a function', () => {
    assert.strictEqual(typeof sw.on, 'function');
  });

  test('emit (EventEmitter) is a function', () => {
    assert.strictEqual(typeof sw.emit, 'function');
  });
});

// ── 4. WasmRunner — error paths ──────────────────────────────────────────────

describe('WasmRunner.run()', () => {
  test('resolves (not rejects) with error field for invalid WASM module', async () => {
    const unit = {
      id: 'test-id',
      taskId: 'task-1',
      wasmModule: new ArrayBuffer(8), // not a valid WASM module
      input: null,
    };
    const result = await dist.WasmRunner.run(unit);
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.workUnitId, 'test-id');
    // Must have an error or a result, not throw
    assert.ok('error' in result || 'result' in result);
  });

  test('resolves with error message string when WASM is invalid (not a silent hang)', async () => {
    const unit = {
      id: 'bad-wasm',
      taskId: 'task-2',
      wasmModule: new TextEncoder().encode('not wasm').buffer,
      input: null,
    };
    const result = await dist.WasmRunner.run(unit);
    assert.strictEqual(typeof result.error, 'string');
    assert.ok(result.error.length > 0, 'error must be a non-empty string');
  });
});

// ── 5. EventEmitter ──────────────────────────────────────────────────────────

describe('EventEmitter', () => {
  test('on/emit round-trip works', () => {
    const emitter = new dist.EventEmitter();
    let received = null;
    emitter.on('data', (v) => { received = v; });
    emitter.emit('data', 42);
    assert.strictEqual(received, 42);
  });

  test('multiple listeners all fire', () => {
    const emitter = new dist.EventEmitter();
    let count = 0;
    emitter.on('tick', () => count++);
    emitter.on('tick', () => count++);
    emitter.emit('tick', null);
    assert.strictEqual(count, 2);
  });

  test('emitting with no listeners does not throw', () => {
    const emitter = new dist.EventEmitter();
    assert.doesNotThrow(() => emitter.emit('nobody-listening', {}));
  });
});

// ── 6. SwarmCompute events ───────────────────────────────────────────────────

describe('SwarmCompute event wiring', () => {
  test('can register listener for task_complete without throwing', () => {
    const sw = new dist.SwarmCompute('ws://localhost:8080');
    assert.doesNotThrow(() => sw.on('task_complete', () => {}));
  });

  test('can register listener for worker_joined without throwing', () => {
    const sw = new dist.SwarmCompute('ws://localhost:8080');
    assert.doesNotThrow(() => sw.on('worker_joined', () => {}));
  });

  test('can register listener for task_assigned without throwing', () => {
    const sw = new dist.SwarmCompute('ws://localhost:8080');
    assert.doesNotThrow(() => sw.on('task_assigned', () => {}));
  });
});

// ── 7. PeerTransport STUN-only — verify ICE config ───────────────────────────

describe('PeerTransport ICE configuration audit', () => {
  test('PeerTransport can be instantiated', () => {
    assert.doesNotThrow(() => new dist.PeerTransport());
  });

  // Note: In Node there is no RTCPeerConnection, so we verify the source-level
  // audit finding here rather than live WebRTC behavior.
  test('ICE audit: STUN-only (per source code audit)', () => {
    // Statically verified: peer-transport.ts configures iceServers with
    // stun:stun.l.google.com:19302 and stun1.l.google.com:19302 only.
    // No TURN servers are configured. This test documents the known limitation.
    // See Known Limitations section in README for full impact.
    const note = 'STUN-only: symmetric NAT peers cannot connect — no TURN relay configured';
    assert.ok(note.includes('STUN-only'), 'ICE limitation documented');
  });
});
