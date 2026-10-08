import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { SwarmCompute, PeerTransport, WasmRunner, CoordinatorClient } = createRequire(import.meta.url)('../dist/index.js');

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const observe = promise => {
  const state = { status: 'pending' };
  promise.then(value => Object.assign(state, { status: 'fulfilled', value }),
    error => Object.assign(state, { status: 'rejected', error }));
  return state;
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function harness(t) {
  const timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', callback => {
    timers.set(++timerId, callback);
    return timerId;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  class Socket {
    static OPEN = 1;
    static instances = [];
    readyState = 0;
    sent = [];
    closeCalls = 0;
    constructor(url) {
      if (Socket.failNext) { Socket.failNext = false; throw new Error('socket constructor failed'); }
      this.url = url; Socket.instances.push(this);
    }
    open() { this.readyState = 1; this.onopen?.({}); }
    send(data) { this.sent.push(JSON.parse(data)); }
    message(data) { return this.onmessage?.({ data: JSON.stringify(data) }); }
    close() { this.closeCalls++; this.readyState = 3; this.onclose?.({}); }
  }
  class Channel {
    readyState = 'open';
    bufferedAmount = 0;
    sent = [];
    closeCalls = 0;
    listeners = new Set();
    send(data) { this.sent.push(data); }
    close() { this.closeCalls++; this.readyState = 'closed'; }
    addEventListener(type, callback) { assert.equal(type, 'bufferedamountlow'); this.listeners.add(callback); }
    removeEventListener(type, callback) { this.listeners.delete(callback); }
    message(data) { this.onmessage?.({ data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) }); }
  }
  class Peer {
    static instances = [];
    iceConnectionState = 'new';
    closeCalls = 0;
    constructor() { Peer.instances.push(this); }
    createDataChannel() { return this.channel = new Channel(); }
    async createOffer() { return this.offerWait ? this.offerWait.promise : { type: 'offer', sdp: '' }; }
    async setLocalDescription() { this.localDescriptions = (this.localDescriptions || 0) + 1; }
    async setRemoteDescription() { if (this.remoteWait) await this.remoteWait.promise; }
    async createAnswer() { return { type: 'answer', sdp: '' }; }
    async addIceCandidate() {}
    close() { this.closeCalls++; }
    channelArrives() { const channel = new Channel(); this.ondatachannel?.({ channel }); return channel; }
  }
  for (const [key, value] of Object.entries({ WebSocket: Socket, RTCPeerConnection: Peer,
    RTCSessionDescription: class { constructor(data) { Object.assign(this, data); } },
    RTCIceCandidate: class { constructor(data) { Object.assign(this, data); } } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const swarm = new SwarmCompute();
  t.after(() => swarm.leaveSwarm());
  const join = async () => {
    const pending = swarm.joinSwarm();
    const [coordinator, signaling] = Socket.instances.slice(-2);
    coordinator.open(); signaling.open();
    await pending;
    return { coordinator, signaling };
  };
  const peer = async (signaling, id = 'peer') => {
    const pending = signaling.message({ type: 'offer', from: id, offer: { type: 'offer', sdp: '' } });
    const pc = Peer.instances.at(-1);
    const channel = pc.channelArrives();
    await pending;
    return { pc, channel };
  };
  return { swarm, join, peer, timers, Socket, Peer, Channel };
}

function taskIdFromFrame(frame) {
  const view = new DataView(frame);
  return new TextDecoder().decode(new Uint8Array(frame, 10, view.getUint8(9)));
}

describe('SwarmCompute disconnect lifecycle', () => {
  test('leave closes sockets, cancels coordinator requests once and resets worker state', async t => {
    const h = harness(t);
    const { coordinator, signaling } = await h.join();
    coordinator.message({ type: 'worker_count', count: 4 });
    const request = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    assert.equal(h.timers.size, 1);
    const delayedTimers = [...h.timers.values()];
    await h.swarm.leaveSwarm();
    await flush();
    assert.equal(request.status, 'rejected');
    assert.match(request.error.message, /left|disconnect|cancel/i);
    assert.equal(h.timers.size, 0);
    assert.equal(h.swarm.workerCount, 0);
    assert.equal(coordinator.closeCalls, 1);
    assert.equal(signaling.closeCalls, 1);
    assert.equal(coordinator.onmessage, null);
    for (const callback of delayedTimers) callback();
    await h.swarm.leaveSwarm();
    assert.equal(coordinator.closeCalls, 1);
    assert.equal(request.status, 'rejected');
  });

  test('leave cancels P2P submissions, closes channels/peers and removes buffered-send listeners', async t => {
    const h = harness(t);
    const { signaling } = await h.join();
    const { pc, channel } = await h.peer(signaling);
    channel.bufferedAmount = 70000;
    const request = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    assert.equal(channel.listeners.size, 1);
    const lateBufferCallback = [...channel.listeners][0];
    const lateMessage = channel.onmessage;
    await h.swarm.leaveSwarm();
    await flush();
    assert.equal(request.status, 'rejected');
    assert.equal(h.timers.size, 0);
    assert.equal(channel.listeners.size, 0);
    assert.equal(channel.closeCalls, 1);
    assert.equal(pc.closeCalls, 1);
    assert.equal(channel.onmessage, null);
    channel.readyState = 'open'; // Even an already queued callback is stale.
    lateBufferCallback();
    lateMessage({ data: JSON.stringify({ type: 'task_result', result: { taskId: 'old' } }) });
    assert.equal(channel.sent.length, 0);
  });
});

describe('SwarmCompute session isolation', () => {
  test('submissions before join and after leave fail without creating timers or sockets', async t => {
    const h = harness(t);
    await assert.rejects(h.swarm.submitTask(new ArrayBuffer(0), null), /joinSwarm/);
    assert.equal(h.Socket.instances.length, 0);
    await h.join();
    await h.swarm.leaveSwarm();
    await assert.rejects(h.swarm.submitTask(new ArrayBuffer(0), null), /joinSwarm/);
    assert.equal(h.timers.size, 0);
    assert.equal(h.Socket.instances.length, 2);
  });

  test('leave during connect rejects join and stale socket callbacks cannot touch a rejoin', async t => {
    const h = harness(t);
    const joining = observe(h.swarm.joinSwarm());
    const [oldCoordinator, oldSignaling] = h.Socket.instances;
    const oldOpen = oldCoordinator.onopen;
    const oldSignalOpen = oldSignaling.onopen;
    const oldMessage = oldCoordinator.onmessage;
    const oldSignalMessage = oldSignaling.onmessage;
    const submitted = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    await h.swarm.leaveSwarm();
    const current = await h.join();
    oldOpen({}); oldSignalOpen({});
    oldMessage({ data: JSON.stringify({ type: 'worker_count', count: 99 }) });
    await oldSignalMessage({ data: JSON.stringify({ type: 'offer', from: 'old', offer: {} }) });
    await flush();
    assert.equal(joining.status, 'rejected');
    assert.equal(submitted.status, 'rejected');
    assert.equal(h.swarm.workerCount, 0);
    assert.deepEqual(current.coordinator.sent.map(message => message.type), ['register']);
    assert.equal(h.Peer.instances.length, 0);
    assert.equal(h.timers.size, 0);
  });

  test('repeated joins share connection work and coordinator round trips work after rejoin', async t => {
    const h = harness(t);
    const first = h.swarm.joinSwarm();
    const second = h.swarm.joinSwarm();
    assert.equal(h.Socket.instances.length, 2);
    h.Socket.instances.forEach(socket => socket.open());
    await Promise.all([first, second]);
    await h.swarm.joinSwarm();
    assert.equal(h.Socket.instances.length, 2);
    const oldCoordinator = h.Socket.instances[0];
    const oldMessage = oldCoordinator.onmessage;
    const success = h.swarm.submitTask(new ArrayBuffer(0), null);
    const taskId = oldCoordinator.sent.at(-1).task.id;
    oldCoordinator.message({ type: 'task_result', result: { taskId, result: 1 } });
    assert.equal((await success).result, 1);
    assert.equal(h.timers.size, 0);
    await h.swarm.leaveSwarm();
    const { coordinator } = await h.join();
    const next = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    const nextId = coordinator.sent.at(-1).task.id;
    oldMessage({ data: JSON.stringify({ type: 'task_result', result: { taskId: nextId, result: 'stale' } }) });
    await flush();
    assert.equal(next.status, 'pending');
    coordinator.message({ type: 'task_result', result: { taskId: nextId, result: 2 } });
    await flush();
    assert.equal(next.value.result, 2);
    assert.equal(h.timers.size, 0);
  });

  test('P2P round trip rejects other-peer and old-session replies and survives rejoin', async t => {
    const h = harness(t);
    const completed = [];
    h.swarm.on('task_complete', result => completed.push(result));
    const { signaling } = await h.join();
    const { channel } = await h.peer(signaling);
    const { channel: other } = await h.peer(signaling, 'other');
    const oldMessage = channel.onmessage;
    const first = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    const taskId = taskIdFromFrame(channel.sent.at(-1));
    other.message({ type: 'task_result', result: { taskId, result: 'wrong peer' } });
    await flush();
    assert.equal(first.status, 'pending');
    assert.equal(completed.length, 0);
    channel.message({ type: 'task_result', result: { taskId, result: 1 } });
    await flush();
    assert.equal(first.value.result, 1);
    assert.equal(h.timers.size, 0);
    await h.swarm.leaveSwarm();
    const current = await h.join();
    const { channel: fresh } = await h.peer(current.signaling);
    const second = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    const nextId = taskIdFromFrame(fresh.sent.at(-1));
    oldMessage({ data: JSON.stringify({ type: 'task_result', result: { taskId: nextId, result: 'old session' } }) });
    await flush();
    assert.equal(second.status, 'pending');
    assert.equal(completed.length, 1);
    fresh.message({ type: 'task_result', result: { taskId: nextId, result: 2 } });
    await flush();
    assert.equal(second.value.result, 2);
    assert.equal(completed.length, 2);
  });

  test('a late incoming data channel is closed and a late offer cannot signal through a new session', async t => {
    const h = harness(t);
    const gate = deferred();
    t.mock.method(h.Peer.prototype, 'setRemoteDescription', () => gate.promise);
    const { signaling } = await h.join();
    const offer = signaling.message({ type: 'offer', from: 'peer', offer: {} });
    const pc = h.Peer.instances.at(-1);
    const onDataChannel = pc.ondatachannel;
    const onIce = pc.onicecandidate;
    const onIceState = pc.oniceconnectionstatechange;
    await h.swarm.leaveSwarm();
    const current = await h.join();
    const late = new h.Channel();
    onDataChannel({ channel: late });
    onIce({ candidate: { candidate: 'old' } });
    pc.iceConnectionState = 'failed';
    onIceState();
    gate.resolve();
    await offer;
    assert.equal(late.closeCalls, 1);
    assert.equal(pc.closeCalls, 1);
    assert.equal(pc.localDescriptions, undefined);
    assert.equal(current.signaling.sent.length, 0);
    const { channel } = await h.peer(current.signaling);
    const task = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    onIceState(); // Cannot remove the replacement peer with the same id.
    channel.message({ type: 'task_result', result: { taskId: taskIdFromFrame(channel.sent.at(-1)), result: 3 } });
    await flush();
    assert.equal(task.value.result, 3);
  });
});

describe('SwarmCompute cancellation races', () => {
  test('a rejected P2P send falls back once, with only the coordinator timer remaining', async t => {
    const h = harness(t);
    const { coordinator, signaling } = await h.join();
    const { channel } = await h.peer(signaling);
    h.swarm.on('route_decision', route => {
      if (route.route === 'p2p') channel.readyState = 'closed';
    });
    const pending = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    await flush();
    assert.equal(h.timers.size, 1);
    const submissions = coordinator.sent.filter(message => message.type === 'submit_task');
    assert.equal(submissions.length, 1);
    coordinator.message({ type: 'task_result', result: { taskId: submissions[0].task.id, result: 4 } });
    await flush();
    assert.equal(pending.value.result, 4);
    assert.equal(h.timers.size, 0);
  });

  test('leave before an async send rejection prevents fallback into the next session', async t => {
    const h = harness(t);
    const { signaling } = await h.join();
    const { channel } = await h.peer(signaling);
    h.swarm.on('route_decision', route => {
      if (route.route === 'p2p') channel.readyState = 'closed';
    });
    const task = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    const leaving = h.swarm.leaveSwarm();
    const current = await h.join();
    await leaving;
    await flush();
    assert.equal(task.status, 'rejected');
    assert.deepEqual(current.coordinator.sent.map(message => message.type), ['register']);
    assert.equal(h.timers.size, 0);
  });

  for (const route of ['coordinator', 'p2p']) {
    test(`leave inside the ${route} route callback cannot enqueue work afterward`, async t => {
      const h = harness(t);
      const { coordinator, signaling } = await h.join();
      if (route === 'p2p') await h.peer(signaling);
      h.swarm.on('route_decision', () => { void h.swarm.leaveSwarm(); });
      await assert.rejects(h.swarm.submitTask(new ArrayBuffer(0), null), /disconnect/i);
      assert.equal(h.timers.size, 0);
      assert.deepEqual(coordinator.sent.map(message => message.type), ['register']);
    });
  }

  test('coordinator send errors remove the pending timer and result listener', async t => {
    const h = harness(t);
    const { coordinator } = await h.join();
    t.mock.method(coordinator, 'send', () => { throw new Error('socket failed'); });
    await assert.rejects(h.swarm.submitTask(new ArrayBuffer(0), null), /socket failed/);
    assert.equal(h.timers.size, 0);
    // Two permanent internal listeners remain; the per-task listener is gone.
    assert.equal(h.swarm.client.listeners.message.length, 2);
  });

  test('disconnect also invalidates an outgoing offer waiting on the browser', async t => {
    const h = harness(t);
    const transport = new PeerTransport();
    const gate = deferred();
    t.mock.method(h.Peer.prototype, 'createOffer', () => gate.promise);
    const connecting = transport.connect('ws://fake-signaling');
    h.Socket.instances.at(-1).open();
    await connecting;
    const offer = transport.connectToPeer('peer');
    const pc = h.Peer.instances.at(-1);
    transport.disconnect();
    const reconnecting = transport.connect('ws://fake-signaling');
    const current = h.Socket.instances.at(-1);
    current.open();
    await reconnecting;
    gate.resolve({ type: 'offer', sdp: 'stale' });
    await offer;
    assert.equal(pc.localDescriptions, undefined);
    assert.equal(current.sent.length, 0);
    assert.equal(pc.closeCalls, 1);
    transport.disconnect();
  });
});

const ECHO_WASM = Uint8Array.from(Buffer.from('AGFzbQEAAAABBgFgAX8BfwIPAQNlbnYGbWVtb3J5AgAKAwIBAAcHAQNydW4AAAoTAREAQQBBAC0AAEEBajoAACAACw==', 'base64')).buffer;
const ECHO_BASE64 = Buffer.from(ECHO_WASM).toString('base64');

describe('owned worker execution cancellation', () => {
  test('leave during coordinator compilation clears its timer and cannot execute or publish after rejoin', async t => {
    const h = harness(t);
    const module = await WebAssembly.compile(ECHO_WASM);
    const gate = deferred();
    const compile = t.mock.method(WebAssembly, 'compile', () => gate.promise);
    const instantiate = t.mock.method(WebAssembly, 'instantiate', async () => { throw new Error('must not instantiate'); });
    const { coordinator } = await h.join();
    let completed = 0;
    h.swarm.on('task_complete', () => completed++);
    coordinator.message({ type: 'task_assigned', task: { id: 'old', wasmModule: ECHO_BASE64, input: null } });
    assert.equal(compile.mock.callCount(), 1);
    assert.equal(h.timers.size, 1);
    await h.swarm.leaveSwarm();
    assert.equal(h.timers.size, 0);
    const current = await h.join();
    gate.resolve(module);
    await flush();
    assert.equal(instantiate.mock.callCount(), 0);
    assert.equal(completed, 0);
    assert.deepEqual(current.coordinator.sent.map(message => message.type), ['register']);
  });

  test('leave during P2P instantiation prevents run and any reply to a replacement channel', async t => {
    const h = harness(t);
    const module = await WebAssembly.compile(ECHO_WASM);
    t.mock.method(WebAssembly, 'compile', async () => module);
    const gate = deferred();
    t.mock.method(WebAssembly, 'instantiate', () => gate.promise);
    const { signaling } = await h.join();
    const { channel } = await h.peer(signaling);
    // Generate a real V2 frame through the SDK, then deliver it as peer work.
    const submission = observe(h.swarm.submitTask(ECHO_WASM, new ArrayBuffer(0)));
    channel.message(channel.sent[0]);
    await flush();
    assert.equal(h.timers.size, 2);
    await h.swarm.leaveSwarm();
    assert.equal(h.timers.size, 0);
    const current = await h.join();
    const { channel: fresh } = await h.peer(current.signaling);
    let calls = 0;
    gate.resolve({ exports: { run: () => { calls++; return 0; } } });
    await flush();
    assert.equal(submission.status, 'rejected');
    assert.equal(calls, 0);
    assert.equal(fresh.sent.length, 0);
  });

  test('a pre-aborted runner request never starts compilation and releases its timer', async t => {
    const h = harness(t);
    const controller = new AbortController();
    controller.abort();
    const compile = t.mock.method(WebAssembly, 'compile', () => { throw new Error('must not compile'); });
    const result = await WasmRunner.run({ id: 'work', taskId: 'task', wasmModule: ECHO_WASM, input: null }, controller.signal);
    assert.match(result.error, /cancel/i);
    assert.equal(compile.mock.callCount(), 0);
    assert.equal(h.timers.size, 0);
  });
});

describe('explicit recovery after terminal connections', () => {
  test('coordinator close cancels owned work and a new join reconnects', async t => {
    const h = harness(t);
    const { coordinator } = await h.join();
    const pending = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    coordinator.readyState = 3;
    coordinator.onclose({});
    await flush();
    assert.equal(pending.status, 'rejected');
    assert.equal(h.timers.size, 0);
    await h.join();
    assert.equal(h.Socket.instances.length, 4);
  });

  test('a closed signaling connection remains coordinator-only until an explicit retry', async t => {
    const h = harness(t);
    const { coordinator, signaling } = await h.join();
    signaling.readyState = 3;
    signaling.onclose({});
    const task = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
    const taskId = coordinator.sent.at(-1).task.id;
    coordinator.message({ type: 'task_result', result: { taskId, result: 5 } });
    await flush();
    assert.equal(task.value.result, 5);
    await h.join();
    assert.equal(h.Socket.instances.length, 4);
    assert.equal(coordinator.closeCalls, 1);
  });

  test('signaling error while connecting settles join with coordinator fallback and permits retry', async t => {
    const h = harness(t);
    const joining = observe(h.swarm.joinSwarm());
    const [coordinator, signaling] = h.Socket.instances;
    coordinator.open();
    signaling.onerror({});
    await flush();
    assert.equal(joining.status, 'fulfilled');
    assert.equal(signaling.onmessage, null);
    await h.join();
    assert.equal(h.Socket.instances.length, 4);
  });
});

test('signaling loss preserves healthy P2P channels and their pending requests', async t => {
  const h = harness(t);
  const { signaling } = await h.join();
  const { pc, channel } = await h.peer(signaling);
  const pending = observe(h.swarm.submitTask(new ArrayBuffer(0), null));
  const taskId = taskIdFromFrame(channel.sent.at(-1));
  signaling.readyState = 3;
  signaling.onclose({});
  assert.equal(pc.closeCalls, 0);
  assert.equal(channel.closeCalls, 0);
  channel.message({ type: 'task_result', result: { taskId, result: 6 } });
  await flush();
  assert.equal(pending.value.result, 6);
  assert.equal(h.timers.size, 0);
  await h.swarm.leaveSwarm();
  assert.equal(pc.closeCalls, 1);
  assert.equal(channel.closeCalls, 1);
});

test('coordinator error before open rejects join and a later join recovers', async t => {
  const h = harness(t);
  const joining = observe(h.swarm.joinSwarm());
  h.Socket.instances[0].onerror({});
  await flush();
  assert.equal(joining.status, 'rejected');
  assert.equal(h.Socket.instances[1].closeCalls, 1);
  await h.join();
  assert.equal(h.Socket.instances.length, 4);
});

test('a throwing socket constructor does not leave the SDK stuck joining', async t => {
  const h = harness(t);
  h.Socket.failNext = true;
  await assert.rejects(h.swarm.joinSwarm(), /constructor failed/);
  assert.equal(h.timers.size, 0);
  await h.join();
  assert.equal(h.Socket.instances.length, 2);
});

test('standalone CoordinatorClient reconnects after a remote close', async t => {
  const h = harness(t);
  const client = new CoordinatorClient('ws://fake-coordinator');
  client.connect();
  h.Socket.instances[0].open();
  client.connect();
  assert.equal(h.Socket.instances.length, 1);
  h.Socket.instances[0].readyState = 3;
  h.Socket.instances[0].onclose({});
  client.connect();
  assert.equal(h.Socket.instances.length, 2);
  client.disconnect();
});

for (const route of ['coordinator', 'p2p']) {
  test(`leave inside the ${route} worker event prevents compilation`, async t => {
    const h = harness(t);
    const compile = t.mock.method(WebAssembly, 'compile', () => { throw new Error('must not compile'); });
    const { coordinator, signaling } = await h.join();
    h.swarm.on(route === 'coordinator' ? 'task_assigned' : 'task_routed_p2p', () => { void h.swarm.leaveSwarm(); });
    if (route === 'coordinator') {
      coordinator.message({ type: 'task_assigned', task: { id: 'old', wasmModule: ECHO_BASE64, input: null } });
    } else {
      const { channel } = await h.peer(signaling);
      const task = observe(h.swarm.submitTask(ECHO_WASM, null));
      channel.message(channel.sent[0]);
      await flush();
      assert.equal(task.status, 'rejected');
    }
    assert.equal(compile.mock.callCount(), 0);
    assert.equal(h.timers.size, 0);
  });
}
