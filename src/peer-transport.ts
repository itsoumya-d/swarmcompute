export class PeerTransport {
  private peerConnection: RTCPeerConnection;
  private dataChannel: RTCDataChannel;
  
  constructor() {
    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    
    this.dataChannel = this.peerConnection.createDataChannel('swarm-data');
    this.dataChannel.binaryType = 'arraybuffer';
    
    this.peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection.iceConnectionState === 'failed') {
        this.peerConnection.restartIce();
      }
    };
  }

  async createOffer() {
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }
}
