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
  private taskResultCallback?: (result: any, peerId: string) => void;
  private taskCallback?: (
    peerId: string,
    wasmBinary: ArrayBuffer,
    inputData: ArrayBuffer,
    taskId: string
  ) => void;

  constructor() {}

  async connect(signalingUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.signalingWs = new WebSocket(signalingUrl);
      this.signalingWs.onopen = () => resolve();
      this.signalingWs.onerror = (e) => reject(e);
      this.signalingWs.onmessage = async (msg) => {
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
          console.error("Signaling error", e);
        }
      };
    });
  }

  async connectToPeer(peerId: string): Promise<void> {
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
      if (event.candidate && this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'ice-candidate', to: peerId, candidate: event.candidate }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this.disconnectPeer(peerId);
      }
    };

    this.peers.set(peerId, { pc, dc });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (this.signalingWs?.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify({ type: 'offer', to: peerId, offer }));
    }
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
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
      dc.binaryType = 'arraybuffer';
      this.peers.set(peerId, { pc, dc });
      this.setupDataChannel(dc, peerId);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && this.signalingWs?.readyState === WebSocket.OPEN) {
        this.signalingWs.send(JSON.stringify({ type: 'ice-candidate', to: peerId, candidate: event.candidate }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this.disconnectPeer(peerId);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

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
        dc.addEventListener('bufferedamountlow', () => {
          try { dc.send(data as any); } catch {}
        }, { once: true });
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

  private disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      // dc is null when ICE fails before the data channel is established.
      // Calling .close() on it threw a TypeError out of the
      // oniceconnectionstatechange handler, leaving the peer in the map with a
      // null dc — after which getConnectedPeers(), and therefore every
      // submitTask() call, threw for the remaining lifetime of the page.
      try { peer.dc?.close(); } catch {}
      try { peer.pc.close(); } catch {}
      this.peers.delete(peerId);
    }
  }

  getConnectedPeers(): string[] {
      return Array.from(this.peers.entries())
          .filter(([_, peer]) => peer.dc?.readyState === 'open')
          .map(([id, _]) => id);
  }
}
