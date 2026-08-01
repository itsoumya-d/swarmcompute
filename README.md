<!--
// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617
-->

# SwarmCompute

<div align="center">
  <p><strong>Distributed Browser WebAssembly Compute Mesh</strong></p>

  [![License: BSL 1.1](https://img.shields.io/badge/License-BSL_1.1-red.svg)](https://mariadb.com/bsl11/)
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
Compiles and instantiates a WASM module in the current environment. Calls the exported `run()` function with input data written to linear memory. A 30-second timeout hard-caps execution. Returns `{ workUnitId, taskId, result, error?, executionTimeMs }` — it resolves rather than rejects; errors appear in the `error` field.

---

## How It Works

1. **Task submission**: `submitTask()` tries P2P first (WebRTC DataChannel), falls back to coordinator WebSocket relay.
2. **P2P transport**: `PeerTransport` uses two STUN servers (`stun.l.google.com:19302`, `stun1.l.google.com:19302`) for ICE. There are no TURN servers.
3. **WASM execution**: Worker nodes receive a base64-encoded WASM module, decode it, call `WebAssembly.compile()` + `WebAssembly.instantiate()`, and invoke the `run()` export.
4. **Result routing**: Results are sent back through the same channel (P2P or coordinator) to the submitter.

---

## Known Limitations

- **Pre-release, no npm package.** Use jsDelivr or clone from source.
- **No TURN relay — connections fail behind symmetric or carrier-grade NAT.** The ICE configuration uses only public STUN servers (`stun.l.google.com`). STUN cannot traverse symmetric NAT (common on corporate networks) or many mobile carrier-grade NAT deployments; those peers cannot connect at all. There is currently no relay fallback. The failure is also **not clearly surfaced** — a failed ICE negotiation triggers `disconnectPeer()` via the `iceConnectionState === 'failed'` handler, which is reported the same way as a peer disconnecting, so callers cannot distinguish "unreachable network" from "peer left". If you need reliable connectivity across arbitrary networks, supply your own TURN server.
- **P2P signaling is hardcoded to port 8081.** `joinSwarm()` always tries `ws://localhost:8081` for P2P signaling. In production this must be reconfigured.
- **WASM modules must export a `run()` function.** Modules without this export silently return `null` output. There is no schema validation.
- **Task broadcast is untrusted.** Any modified client can send a forged `task_result`. Critical workloads must verify results independently.
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

## License — Business Source License 1.1

> **Source-available, NOT open-source. Production use requires a paid license.**

| Tier | Price | For |
|---|---|---|
| Indie | $399/year | Solo developer, <$100K revenue |
| Startup | $2,999/year | Up to 10-25 devs, <$5M revenue |
| Enterprise | $14,999/year | Unlimited seats, unlimited revenue |
| OEM / White-Label | $29,999/year | Embed in your product |

**Free use:** Personal evaluation, academic research, open-source contribution.

Contact: soumyadebnath1661@gmail.com | +91 7031648617 | github.com/itsoumya-d

© 2024-2026 Soumya Debnath. All Rights Reserved.
