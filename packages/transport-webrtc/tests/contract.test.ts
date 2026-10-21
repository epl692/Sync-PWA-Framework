// T072: the WebRTC transport against the shared contract suite, using the mock RTCPeerConnection.
import { MockRtc, transportContract, type RemoteEnd } from '@sync/testkit';
import { createWebRtcTransport } from '../src/index';

transportContract('webrtc (mock RTCPeerConnection)', {
  largeMessageBytes: 512 * 1024,
  async create() {
    const rtc = new MockRtc(16 * 1024); // real data channels interoperate at about 16 KiB per message
    const transport = createWebRtcTransport({ RTCPeerConnection: rtc.RTCPeerConnection });
    const far = createWebRtcTransport({ RTCPeerConnection: rtc.RTCPeerConnection });
    await far.start();
    let farPeer = '';
    far.on('peerConnected', (p) => void (farPeer = p.id));
    const listeners: ((b: Uint8Array) => void)[] = [];
    far.on('message', (_p, b) => listeners.forEach((l) => l(b)));
    (transport as unknown as { __pair: () => Promise<void> }).__pair = async () => {
      const offer = await (transport as typeof far).createOffer();
      const answer = await far.acceptOffer(offer.code);
      await (transport as typeof far).acceptAnswer(offer.sessionId, answer.code);
    };
    const remote: RemoteEnd = {
      send: (bytes) => far.send(farPeer, bytes),
      onMessage: (cb) => void listeners.push(cb),
      disconnect: () => far.stop(),
      // a raw, unframed blob straight onto the data channel: not a valid frame
      injectCorrupt: () => {
        const ch = rtc.pcs[1]!.channels[0]!;
        ch.send(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
      },
    };
    return { transport, remote, teardown: async () => void (await transport.stop(), await far.stop()) };
  },
  async afterStart(t) {
    await (t as unknown as { __pair: () => Promise<void> }).__pair();
  },
  createUnsupported: () => createWebRtcTransport({ RTCPeerConnection: null }),
});
