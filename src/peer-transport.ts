// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

export class PeerTransport {
  private peers = new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel }>();
  private signalingWs?: WebSocket;
  private taskResultCallback?: (result: any) => void;
  private taskCallback?: (peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer) => void;

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
        const view = new DataView(event.data);
        const type = view.getUint8(0);
        
        if (type === 1) { // Task
          const wasmLength = view.getUint32(1);
          const inputLength = view.getUint32(5);
          const wasmBinary = event.data.slice(9, 9 + wasmLength);
          const inputData = event.data.slice(9 + wasmLength, 9 + wasmLength + inputLength);
          if (this.taskCallback) {
            this.taskCallback(peerId, wasmBinary, inputData);
          }
        }
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'task_result' && this.taskResultCallback) {
            this.taskResultCallback(msg.result);
          }
        } catch (e) {
          console.error("Failed to parse string message on data channel", e);
        }
      }
    };
  }

  async sendTask(peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || peer.dc.readyState !== 'open') {
      throw new Error(`Peer ${peerId} not connected`);
    }

    const headerSize = 1 + 4 + 4;
    const buffer = new ArrayBuffer(headerSize + wasmBinary.byteLength + inputData.byteLength);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    
    view.setUint8(0, 1);
    view.setUint32(1, wasmBinary.byteLength);
    view.setUint32(5, inputData.byteLength);
    
    u8.set(new Uint8Array(wasmBinary), headerSize);
    u8.set(new Uint8Array(inputData), headerSize + wasmBinary.byteLength);
    
    peer.dc.send(buffer);
  }
  
  sendTaskResult(peerId: string, result: any): void {
    const peer = this.peers.get(peerId);
    if (peer && peer.dc.readyState === 'open') {
        peer.dc.send(JSON.stringify({ type: 'task_result', result }));
    }
  }

  onTaskResult(callback: (result: any) => void): void {
    this.taskResultCallback = callback;
  }
  
  onTask(callback: (peerId: string, wasmBinary: ArrayBuffer, inputData: ArrayBuffer) => void): void {
    this.taskCallback = callback;
  }

  private disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dc.close();
      peer.pc.close();
      this.peers.delete(peerId);
    }
  }
  
  getConnectedPeers(): string[] {
      return Array.from(this.peers.entries())
          .filter(([_, peer]) => peer.dc.readyState === 'open')
          .map(([id, _]) => id);
  }
}
