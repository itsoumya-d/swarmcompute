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

  // Note: In Node there is no RTCPeerConnection, so assert against the ICE
  // configuration the code really builds rather than live WebRTC behaviour.
  test('ICE audit: STUN-only, zero TURN servers configured', () => {
    const seen = [];
    const priorRTC = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = class {
      constructor(config) {
        seen.push(config);
        this.iceConnectionState = 'new';
      }
      createDataChannel() { return { binaryType: '', readyState: 'connecting', close() {} }; }
      async createOffer() { return { type: 'offer', sdp: '' }; }
      async setLocalDescription() {}
      close() {}
    };
    try {
      new dist.PeerTransport().connectToPeer('peer-1');
    } finally {
      globalThis.RTCPeerConnection = priorRTC;
    }
    assert.strictEqual(seen.length, 1, 'connectToPeer must construct one RTCPeerConnection');
    const urls = seen[0].iceServers.map((s) => String(s.urls));
    assert.ok(urls.every((u) => u.startsWith('stun:')), 'only STUN URLs are configured');
    assert.strictEqual(
      urls.filter((u) => u.startsWith('turn:') || u.startsWith('turns:')).length,
      0,
      'no TURN relay is configured — symmetric-NAT peers cannot connect'
    );
    assert.strictEqual(seen[0].iceTransportPolicy, undefined);
    assert.strictEqual(seen[0].iceCandidatePoolSize, undefined);
  });
});

// ── 8. WasmRunner — guest isolation contract ─────────────────────────────────
// Minimal modules compiled from WAT ahead of time so the suite stays dependency-free.
const WASM = {
  // (import "env" "memory") + run(len) -> len, increments byte 0
  ECHO: 'AGFzbQEAAAABBgFgAX8BfwIPAQNlbnYGbWVtb3J5AgAKAwIBAAcHAQNydW4AAAoTAREAQQBBAC0AAEEBajoAACAACw==',
  // declares its OWN memory instead of importing the host's
  OWN_MEMORY: 'AGFzbQEAAAABBgFgAX8BfwMCAQAFAwEAAQcHAQNydW4AAAoGAQQAQQML',
  // imports host memory but exports no run()
  NO_RUN: 'AGFzbQEAAAABBQFgAAF/Ag8BA2VudgZtZW1vcnkCAAoDAgEABwkBBW90aGVyAAAKBgEEAEEFCw==',
  // run() returns -1, an out-of-range output length
  BAD_LEN: 'AGFzbQEAAAABBgFgAX8BfwIPAQNlbnYGbWVtb3J5AgAKAwIBAAcHAQNydW4AAAoGAQQAQX8L',
};
const wasmOf = (k) => Uint8Array.from(Buffer.from(WASM[k], 'base64')).buffer;
const unit = (k, input = null) => ({ id: 'u', taskId: 't', wasmModule: wasmOf(k), input });

describe('WasmRunner guest contract', () => {
  test('a well-formed module computes a real result', async () => {
    const input = new Uint8Array([7, 8, 9]);
    const r = await dist.WasmRunner.run(unit('ECHO', input.buffer.slice(0)));
    assert.strictEqual(r.error, undefined);
    assert.deepStrictEqual([...new Uint8Array(r.result.output)], [8, 8, 9]);
    assert.strictEqual(r.taskId, 't');
  });

  test('rejects a module that declares its own memory instead of importing the host memory', async () => {
    // Such a module used to "succeed" with silently zeroed output, because the
    // host read back its own unused buffer, and the host page cap did not apply
    // to the module's private allocation.
    const r = await dist.WasmRunner.run(unit('OWN_MEMORY'));
    assert.match(r.error, /must import its linear memory/i);
    assert.strictEqual(r.result, null);
  });

  test('rejects a module with no callable run() export instead of reporting success', async () => {
    const r = await dist.WasmRunner.run(unit('NO_RUN'));
    assert.match(r.error, /does not export a callable run/i);
    assert.strictEqual(r.result, null);
  });

  test('rejects a guest-supplied output length outside the memory bounds', async () => {
    const r = await dist.WasmRunner.run(unit('BAD_LEN'));
    assert.match(r.error, /invalid output length/i);
    assert.strictEqual(r.result, null);
  });

  test('rejects input larger than the linear memory granted to a work unit', async () => {
    const r = await dist.WasmRunner.run(unit('ECHO', new ArrayBuffer(5 * 1024 * 1024)));
    assert.match(r.error, /exceeds the .* bytes of linear memory/i);
  });

  test('propagates the submitter taskId onto the result so it can be correlated', async () => {
    const r = await dist.WasmRunner.run({
      id: 'work-unit-1', taskId: 'submitter-task-1', wasmModule: wasmOf('ECHO'), input: null,
    });
    assert.strictEqual(r.workUnitId, 'work-unit-1');
    assert.strictEqual(r.taskId, 'submitter-task-1');
  });
});

// ── 9. EventEmitter — a throwing listener must not stall the rest ────────────

describe('EventEmitter fault isolation', () => {
  test('a listener that throws does not prevent later listeners from running', () => {
    const emitter = new dist.EventEmitter();
    const ran = [];
    emitter.on('message', () => { throw new Error('boom'); });
    emitter.on('message', () => { ran.push('second'); });
    assert.doesNotThrow(() => emitter.emit('message', {}));
    assert.deepStrictEqual(ran, ['second']);
  });

  test('off() during dispatch does not skip a listener', () => {
    const emitter = new dist.EventEmitter();
    const ran = [];
    const a = () => { ran.push('a'); emitter.off('e', a); };
    const b = () => ran.push('b');
    emitter.on('e', a); emitter.on('e', b);
    emitter.emit('e');
    assert.deepStrictEqual(ran, ['a', 'b']);
  });
});
