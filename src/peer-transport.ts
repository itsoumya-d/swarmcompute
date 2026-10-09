// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1619@gmail.com

/**
 * P2P task frame layout (binary, sent over the RTCDataChannel).
 *
 *   FRAME_TASK_V1 = 1   [type:u8][wasmLen:u32][inputLen:u32][wasm][input]
 *   FRAME_TASK_V2 = 2   [type:u8][wasmLen:u32][inputLen:u32][idLen:u8][id][wasm][input]
 *
 * V1 carries no task identifier, so a peer executing a V1 frame cannot tell the
 * submitter which task its reply belongs to. V2 adds the submitter's task id so
 * replies can be correlated. V1 is still parsed for compatibility.
 */
const FRAME_TASK_V1 = 1;
const FRAME_TASK_V2 = 2;

export class PeerTransport {
  private peers = new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel | null }>();
  private signalingWs?: WebSocket;
  private generation = 0;
  private active = true;
  private cancelConnecting?: (reason: Error) => void;
  private bufferedSends = new Map<RTCDataChannel, Set<() => void>>();
  private taskResultCallback?: (result: any, peerId: string) => void;
  private taskCallback?: (
    peerId: string,
    wasmBinary: ArrayBuffer,
    inputData: ArrayBuffer,
    taskId: string
  ) => void;

  constructor() {}

  async connect(signalingUrl: string): Promise<void> {
    this.disconnect();
    this.active = true;
    const generation = this.generation;
    return new Promise<void>((resolve, reject) => {
      const ws = this.signalingWs = new WebSocket(signalingUrl);
      const current = () => this.active && this.generation === generation && this.signalingWs === ws;
      this.cancelConnecting = reject;
      ws.onopen = () => {
        if (!current()) return;
        this.cancelConnecting = undefined;
        resolve();
      };
      ws.onerror = () => {
        if (current()) this.disconnectSignaling(new Error('SwarmCompute: peer signaling connection failed.'));
      };
      ws.onclose = () => {
        if (current()) this.disconnectSignaling(new Error('SwarmCompute: peer signaling connection closed.'));
      };
      ws.onmessage = async (msg) => {
        if (!current()) return;
        try {
          const data = JSON.parse(msg.data);
          if (data.type === 'offer') {
            await this.handleOffer(data.from, data.offer);
          } else if (data.type === 'answer') {
            await this.handleAnswer(data.from, data.answer);
          } else if (data.type === 'ice-candidate') {
            await this.handleIceCandidate(data.from, data.candidate);
          }
        } catch (e) {
          if (current()) console.error('Signaling error', e);
        }
      };
    });
  }

  hasConnection(): boolean {
    return !!this.signalingWs && (this.signalingWs.readyState === 0 || this.signalingWs.readyState === WebSocket.OPEN);
  }

  disconnect(reason = new Error('SwarmCompute: peer transport disconnected.')): void {
    this.active = false;
    this.generation++;
    this.disconnectSignaling(reason);
    for (const peerId of [...this.peers.keys()]) this.disconnectPeer(peerId);
  }

  private disconnectSignaling(reason: Error): void {
    // An established RTC channel does not depend on the signaling socket.
    // Keep healthy peers alive when only the signaling server goes away.
    const cancel = this.cancelConnecting;
    this.cancelConnecting = undefined;
    cancel?.(reason);
    const ws = this.signalingWs;
    this.signalingWs = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch {}
    }
  }

  private isCurrentPeer(peerId: string, pc: RTCPeerConnection, generation: number): boolean {
    return this.active && this.generation === generation && this.peers.get(peerId)?.pc === pc;
  }

  async connectToPeer(peerId: string): Promise<void> {
    if (!this.active) throw new Error('SwarmCompute: peer transport disconnected.');
    const generation = this.generation;
    this.disconnectPeer(peerId);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    const dc = pc.createDataChannel('swarm-data');
    dc.binaryType = 'arraybuffer';
    this.setupDataChannel(dc, peerId);

    pc.onicecandidate = (event) => {
      if (this.isCurrentPeer(peerId, pc, generation) && event.candidate && this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'ice-candidate', to: peerId, candidate: event.candidate }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.isCurrentPeer(peerId, pc, generation) &&
          (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) {
        this.disconnectPeer(peerId);
      }
    };

    this.peers.set(peerId, { pc, dc });

    const offer = await pc.createOffer();
    if (!this.isCurrentPeer(peerId, pc, generation)) return;
    await pc.setLocalDescription(offer);
    if (!this.isCurrentPeer(peerId, pc, generation)) return;

    if (this.signalingWs?.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify({ type: 'offer', to: peerId, offer }));
    }
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.active) return;
    const generation = this.generation;
    this.disconnectPeer(peerId);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Register peer IMMEDIATELY so ICE candidates arriving before ondatachannel aren't dropped.
    // NOTE: dc is null until ondatachannel fires. Every read of peer.dc must tolerate null —
    // if ICE fails before the channel arrives (the normal outcome behind symmetric NAT with no
    // TURN relay) the cleanup path runs while dc is still null.
    this.peers.set(peerId, { pc, dc: null });

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      if (!this.isCurrentPeer(peerId, pc, generation)) {
        this.closeDataChannel(dc);
        return;
      }
      const oldChannel = this.peers.get(peerId)?.dc;
      if (oldChannel && oldChannel !== dc) this.closeDataChannel(oldChannel);
      dc.binaryType = 'arraybuffer';
      this.peers.set(peerId, { pc, dc });
      this.setupDataChannel(dc, peerId);
    };

    pc.onicecandidate = (event) => {
      if (this.isCurrentPeer(peerId, pc, generation) && event.candidate && this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'ice-candidate', to: peerId, candidate: event.candidate }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (this.isCurrentPeer(peerId, pc, generation) &&
          (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) {
        this.disconnectPeer(peerId);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    if (!this.isCurrentPeer(peerId, pc, generation)) return;
    const answer = await pc.createAnswer();
    if (!this.isCurrentPeer(peerId, pc, generation)) return;
    await pc.setLocalDescription(answer);
    if (!this.isCurrentPeer(peerId, pc, generation)) return;

    if (this.signalingWs?.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify({ type: 'answer', to: peerId, answer }));
    }
  }

  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const peer = this.peers.get(peerId);
    if (peer) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  private async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(peerId);
    if (peer) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private setupDataChannel(dc: RTCDataChannel, peerId: string): void {
    dc.onmessage = (event) => {
      if (!this.active || this.peers.get(peerId)?.dc !== dc) return;
      if (event.data instanceof ArrayBuffer) {
        const data: ArrayBuffer = event.data;
        if (data.byteLength < 9) return; // minimum header size
        const view = new DataView(data);
        const type = view.getUint8(0);
        if (type !== FRAME_TASK_V1 && type !== FRAME_TASK_V2) return;

        const wasmLength = view.getUint32(1);
        const inputLength = view.getUint32(5);

        let bodyOffset = 9;
        let taskId = 'p2p-task'; // V1 frames carry no id; preserve the historical value
        if (type === FRAME_TASK_V2) {
          if (data.byteLength < 10) return;
          const idLength = view.getUint8(9);
          bodyOffset = 10 + idLength;
          if (data.byteLength < bodyOffset) {
            console.warn('SwarmCompute: Malformed P2P task payload length');
            return;
          }
          taskId = new TextDecoder().decode(new Uint8Array(data, 10, idLength));
        }

        if (data.byteLength < bodyOffset + wasmLength + inputLength) {
          console.warn('SwarmCompute: Malformed P2P task payload length');
          return;
        }
        const wasmBinary = data.slice(bodyOffset, bodyOffset + wasmLength);
        const inputData = data.slice(bodyOffset + wasmLength, bodyOffset + wasmLength + inputLength);
        if (this.taskCallback) {
          this.taskCallback(peerId, wasmBinary, inputData, taskId);
        }
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'task_result' && this.taskResultCallback) {
            // Pass the sending peer so the caller can reject results from a
            // peer the task was never dispatched to.
            this.taskResultCallback(msg.result, peerId);
          }
        } catch (e) {
          console.error("Failed to parse string message on data channel", e);
        }
      }
    };
  }

  private safeSend(dc: RTCDataChannel, data: ArrayBuffer | string): void {
    try {
      if (dc.readyState !== 'open') return;
      if (dc.bufferedAmount > 65536) {
        dc.bufferedAmountLowThreshold = 16384;
        let callbacks = this.bufferedSends.get(dc);
        if (!callbacks) this.bufferedSends.set(dc, callbacks = new Set());
        const send = () => {
          if (!callbacks.delete(send)) return;
          if (!callbacks.size) this.bufferedSends.delete(dc);
          if (!this.active || dc.readyState !== 'open') return;
          try { dc.send(data as any); } catch {}
        };
        callbacks.add(send);
        dc.addEventListener('bufferedamountlow', send, { once: true });
        return;
      }
      dc.send(data as any);
    } catch {}
  }

  async sendTask(
    peerId: string,
    wasmBinary: ArrayBuffer,
    inputData: ArrayBuffer,
    taskId?: string
  ): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') {
      throw new Error(`Peer ${peerId} not connected`);
    }

    // Emit a V2 frame when a task id is supplied so the remote peer can label
    // its reply; fall back to the V1 layout otherwise.
    const idBytes = taskId ? new TextEncoder().encode(taskId) : new Uint8Array(0);
    if (idBytes.byteLength > 255) {
      throw new Error(`Task id must encode to 255 bytes or fewer (got ${idBytes.byteLength})`);
    }
    const useV2 = idBytes.byteLength > 0;
    const headerSize = useV2 ? 10 + idBytes.byteLength : 9;

    const buffer = new ArrayBuffer(headerSize + wasmBinary.byteLength + inputData.byteLength);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);

    view.setUint8(0, useV2 ? FRAME_TASK_V2 : FRAME_TASK_V1);
    view.setUint32(1, wasmBinary.byteLength);
    view.setUint32(5, inputData.byteLength);
    if (useV2) {
      view.setUint8(9, idBytes.byteLength);
      u8.set(idBytes, 10);
    }

    u8.set(new Uint8Array(wasmBinary), headerSize);
    u8.set(new Uint8Array(inputData), headerSize + wasmBinary.byteLength);

    this.safeSend(peer.dc, buffer);
  }

  sendTaskResult(peerId: string, result: any): void {
    const peer = this.peers.get(peerId);
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      this.safeSend(peer.dc, JSON.stringify({ type: 'task_result', result }));
    }
  }

  onTaskResult(callback: (result: any, peerId: string) => void): void {
    this.taskResultCallback = callback;
  }

  onTask(
    callback: (peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer, taskId: string) => void
  ): void {
    this.taskCallback = callback;
  }

  private closeDataChannel(dc: RTCDataChannel): void {
    dc.onmessage = null;
    const callbacks = this.bufferedSends.get(dc);
    if (callbacks) {
      for (const callback of callbacks) dc.removeEventListener('bufferedamountlow', callback);
      callbacks.clear();
      this.bufferedSends.delete(dc);
    }
    try { dc.close(); } catch {}
  }

  private disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      // dc is null when ICE fails before the data channel is established.
      // Calling .close() on it threw a TypeError out of the
      // oniceconnectionstatechange handler, leaving the peer in the map with a
      // null dc — after which getConnectedPeers(), and therefore every
      // submitTask() call, threw for the remaining lifetime of the page.
      this.peers.delete(peerId);
      peer.pc.ondatachannel = peer.pc.onicecandidate = peer.pc.oniceconnectionstatechange = null;
      if (peer.dc) this.closeDataChannel(peer.dc);
      try { peer.pc.close(); } catch {}
    }
  }

  getConnectedPeers(): string[] {
      return Array.from(this.peers.entries())
          .filter(([_, peer]) => peer.dc?.readyState === 'open')
          .map(([id, _]) => id);
  }
}
