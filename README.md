<!--
// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Dual-licensed: AGPL-3.0-or-later (free, see LICENSE) OR a commercial licence
// (see COMMERCIAL_LICENSE.md) if you cannot meet the AGPL's source-disclosure terms.
// Contact: soumyadebnath1619@gmail.com
-->

# SwarmCompute

<div align="center">
  <p><strong>SwarmCompute spreads WebAssembly tasks across visitors' idle browser tabs, turning existing page traffic into compute capacity instead of a serverless bill.</strong></p>

  [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
  [![Status](https://img.shields.io/badge/status-pre--release-orange.svg)]()
</div>

---

> **Pre-release software. Not published to npm. No production adopters yet. See [Known Limitations](#known-limitations).**

---

## What is SwarmCompute?

SwarmCompute is a TypeScript library and Go coordinator server that distributes WebAssembly tasks across connected browser tabs using WebSockets (coordinator relay) and WebRTC DataChannels (peer-to-peer). Desktop browsers act as worker nodes; mobile browsers submit tasks only.

Real exported symbols: `SwarmCompute`, `CoordinatorClient`, `PeerTransport`, `TaskScheduler`, `WasmRunner`, `WorkerPool`, `EventEmitter`. Nothing is published under `@swarmcompute/sdk`. The class `SwarmNode` does not exist.

---

## Installation

SwarmCompute is **not published on npm**. `npm install swarmcompute` will fail. Install from source:

**Option 1 — jsDelivr CDN (no build step):**
```html
<script type="module">
  import { SwarmCompute } from 'https://cdn.jsdelivr.net/gh/itsoumya-d/swarmcompute@main/dist/index.mjs';
</script>
```

**Option 2 — Clone and build:**
```bash
git clone https://github.com/itsoumya-d/swarmcompute.git
cd swarmcompute
npm install
npm run build
```
Then import from `./dist/index.mjs` or `./dist/index.js`.

---

## Quick Start

```typescript
import { SwarmCompute } from './dist/index.mjs';

// 1. Connect to your coordinator server
const swarm = new SwarmCompute('wss://your-coordinator.example.com');
await swarm.joinSwarm();

console.log(`Worker count: ${swarm.workerCount}`);
console.log(`Is worker: ${swarm.isWorker}`);

// 2. Fetch and submit a WASM task
const response = await fetch('/my_computation.wasm');
const wasmBuffer = await response.arrayBuffer();

const result = await swarm.submitTask(wasmBuffer, { operation: 'sum', n: 1000 });
console.log(`Result in ${result.executionTimeMs}ms:`, result.result);

// 3. Listen for events
swarm.on('worker_joined', (count) => console.log(`Workers: ${count}`));
swarm.on('task_complete', (result) => console.log('Task done:', result));
```

---

## API Reference

### `SwarmCompute` Class

#### `constructor(options?: string | { coordinatorUrl?: string })`
Accepts a WebSocket URL string or an options object. Defaults to `ws://localhost:8080`.

#### `async joinSwarm(): Promise<void>`
Opens a WebSocket connection to the coordinator. Also attempts a P2P signaling WebSocket on port 8081. If P2P signaling fails, it logs a warning and continues with coordinator relay only.

#### `leaveSwarm(): void`
Disconnects from the swarm.

#### `async submitTask(wasmModule: ArrayBuffer, input: any): Promise<TaskResult>`
Submits a WASM task. If P2P peers are connected, the task is sent directly via WebRTC DataChannel. Otherwise it falls back to the coordinator relay. Returns `{ taskId, result, executionTimeMs }`.

#### `get workerCount(): number`
Current number of known active workers (from coordinator messages).

#### `get isWorker(): boolean`
`true` if the current node is classified as a desktop (non-mobile) browser capable of processing tasks.

#### Events: `worker_joined`, `task_assigned`, `task_complete`, `route_decision`, `task_routed_p2p`

### `WasmRunner`

#### `static async run(unit: WorkUnit): Promise<WorkUnitResult>`
Compiles and instantiates a WASM module **on the calling thread**. Calls the exported `run()` function with input data written to linear memory. Returns `{ workUnitId, taskId, result, error?, executionTimeMs }` — it resolves rather than rejects; errors appear in the `error` field.

The module must import its linear memory as `(import "env" "memory" (memory 10))`. Modules that declare their own memory are rejected: the host cannot read their output (it would hand back silently-zeroed bytes) and the host page cap would not apply to their private allocation. Modules with no callable `run()` export, and `run()` return values outside the memory bounds, are also rejected with an error rather than reported as success.

The 30-second timer bounds only `compile()` and `instantiate()`. **It does not bound guest CPU** — see [Guest isolation](#guest-isolation-what-is-and-is-not-enforced).

---

## How It Works

1. **Task submission**: `submitTask()` tries P2P first (WebRTC DataChannel), falls back to coordinator WebSocket relay.
2. **P2P transport**: `PeerTransport` uses two STUN servers (`stun.l.google.com:19302`, `stun1.l.google.com:19302`) for ICE. There are no TURN servers.
3. **WASM execution**: Worker nodes receive a base64-encoded WASM module, decode it, call `WebAssembly.compile()` + `WebAssembly.instantiate()`, and invoke the `run()` export.
4. **Result routing**: Results are sent back through the same channel (P2P or coordinator) to the submitter.

The coordinator does **not** partition work or assign it to a particular node. `submit_task` is relabelled `task_assigned` and broadcast to every connected client, so every non-mobile node runs the whole task. With N workers that is N× the CPU spend and no parallel speedup, and the submitter executes its own task too. The N independent answers that result are never compared with one another.

---

## Guest isolation — what is and is not enforced

SwarmCompute runs WebAssembly supplied by other participants on a volunteer's machine. Be precise about what that does and does not protect.

**Enforced:**
- **No ambient authority.** A work unit is instantiated with exactly one import, `env.memory`. A module that imports anything else — a function to reach `fetch`, the DOM, storage — fails to instantiate and the work unit returns an error. WebAssembly grants no capability that is not imported, so a guest cannot reach the network, the DOM, cookies or storage on its own.
- **Bounded linear memory,** because the host supplies the memory (10 pages initial / 50 maximum) and rejects modules that would allocate their own.
- **Bounded output length,** validated against the memory size before the result is copied out.

**Not enforced:**
- **Guest CPU time is not bounded.** A WebAssembly call is synchronous. While `run()` is on the stack the JavaScript event loop cannot turn, so no `setTimeout` can fire and no code can intervene. A module containing an unbounded loop occupies the thread until the tab is closed. `WasmRunner` runs the guest on the **calling thread** — in a browser that freezes the page, including its UI. `WorkerPool` does not create a `Worker`; it only tracks a count reported by the coordinator. Bounding guest CPU requires running the guest in a dedicated `Worker` and calling `Worker.terminate()` when a deadline expires; that is not implemented.
- **Result values are not verified.** There is no redundant execution with N-of-M agreement, no spot-checking against known answers, and no verifiable-computation scheme. A single peer's return value is accepted as the answer. The P2P path at least requires the reply to come from the peer the task was dispatched to; the coordinator path has no such check, because the coordinator broadcasts every result to every client and authenticates nobody.

**Therefore:** only submit modules you compiled yourself and would be willing to run on your own users' devices, and treat every returned value as unverified input.

---

## Known Limitations

- **Pre-release, no npm package.** Use jsDelivr or clone from source.
- **No TURN relay — connections fail behind symmetric or carrier-grade NAT.** The ICE configuration uses only public STUN servers (`stun.l.google.com`). STUN cannot traverse symmetric NAT (common on corporate networks) or many mobile carrier-grade NAT deployments; those peers cannot connect at all. There is currently no relay fallback. The failure is also **not clearly surfaced** — a failed ICE negotiation triggers `disconnectPeer()` via the `iceConnectionState === 'failed'` handler, which is reported the same way as a peer disconnecting, so callers cannot distinguish "unreachable network" from "peer left". If you need reliable connectivity across arbitrary networks, supply your own TURN server.
- **P2P signaling is hardcoded to port 8081.** `joinSwarm()` always tries `ws://localhost:8081` for P2P signaling. In production this must be reconfigured.
- **WASM modules must export a `run()` function and import `env.memory`.** Modules that do not are rejected with an error. There is no schema validation of input or output payloads.
- **A malicious module can hang the volunteer's thread indefinitely.** The 30-second timer cannot interrupt executing WebAssembly, and there is no `Worker` boundary. See [Guest isolation](#guest-isolation-what-is-and-is-not-enforced).
- **Results are not verified.** Any client can send a forged `task_result` for any task id it has seen, and the coordinator broadcasts every task to every client, so every client sees every task id. There is no redundancy, quorum, or spot-checking. Critical workloads must verify results independently.
- **No work partitioning and no task reassignment.** Each task is broadcast whole to every worker (N× redundant CPU, no speedup). If the answering peer disappears the submission rejects on timeout; it is not retried or reassigned.
- **The coordinator accepts WebSocket upgrades from any origin and authenticates nobody.** `CheckOrigin` returns `true` unconditionally and there is no read size limit on incoming frames. Do not expose it on the public internet without an authenticating proxy.
- **`isWorker` uses User-Agent detection.** Mobile UA strings cause a node to be classified as submitter-only. This heuristic is imprecise and does not reflect actual device capability.
- **No production adopters yet.** APIs may change without notice.
- **Performance benchmark (from original README) is unverifiable.** The claim of 220 tasks/second at 100 concurrent desktop browsers requires a live swarm to measure. It has been removed from the main README body. If you run your own benchmark, open a PR with methodology, hardware specs, and coordinator spec.

---

## Coordinator Server (Go)

Deploy the Go coordinator for WebSocket relay:

```bash
cd coordinator
docker build -t swarmcompute-coordinator .
docker run -p 8080:8080 swarmcompute-coordinator
```

Place behind an Nginx/Caddy reverse proxy with TLS for `wss://` support in production.

---

## Comparison

| Feature | SwarmCompute | AWS Lambda | Cloudflare Workers |
|---|---|---|---|
| Cost | $0 (BYO users + coordinator) | Pay per ms | Pay per ms/req |
| Environment | User browsers | VMs | V8 Isolates |
| Language | Any → WASM | Many | JS/WASM |
| Scaling limit | Your DAU count | Quota limits | Quota limits |
| NAT traversal | STUN-only (TURN required for reliability) | N/A | N/A |
| npm availability | Not published | N/A | N/A |
| Production-ready | Pre-release | Yes | Yes |

---

## 📄 License

**Dual-licensed — choose either:**

1. **[AGPL-3.0-or-later](LICENSE)** — free for any purpose, including commercial and production
   use. No payment, no permission, no key required. The obligation it carries: if you modify this
   software and let users interact with it over a network, you must offer those users your modified
   source under the same licence.

2. **[Commercial licence](COMMERCIAL_LICENSE.md)** — for organisations that cannot or prefer not to
   meet the AGPL's source-disclosure obligation. This buys an exception, not access.

Contributions are accepted under AGPL-3.0-or-later. Full terms: [LICENSING.md](LICENSING.md).

