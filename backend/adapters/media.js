import { config } from '../config.js';

/**
 * Media transport adapter.
 *
 * Contract:
 *   mode                       — 'p2p' | 'sfu', read by the client to pick a strategy
 *   getJoinConfig(context)     — everything a client needs to establish media
 *   onRoomChanged(context)     — server-side hook fired during a handoff
 *
 * The shipped implementation is peer-to-peer mesh: the signaling server brokers
 * offers/answers directly between two browsers and no media touches the server.
 * Section 8.2 of the requirements recommends an SFU instead, because on handoff
 * a P2P client must tear down its RTCPeerConnection and negotiate a fresh one
 * with the doctor. That renegotiation is invisible to the patient — the URL and
 * the tab are unchanged — so the stated requirement ("links reset per patient,
 * sockets stay up") holds either way.
 *
 * To move to mediasoup/LiveKit: implement SfuMediaAdapter with the same two
 * methods, returning a router/room token from getJoinConfig, and re-point the
 * `media` export. The signaling protocol in realtime/signaling.js stays as-is;
 * only the client's media negotiation changes.
 */

class P2PMediaAdapter {
  constructor() {
    this.mode = 'p2p';
  }

  getJoinConfig() {
    return {
      mode: this.mode,
      iceServers: config.iceServers,
      // No TURN is configured by default, so symmetric-NAT peers may fail to
      // connect. Set ICE_SERVERS with a TURN entry for production.
      hasTurn: config.iceServers.some((server) =>
        [].concat(server.urls || []).some((url) => String(url).startsWith('turn:')),
      ),
    };
  }

  async onRoomChanged({ appointmentId, fromRoom, toRoom }) {
    // P2P needs no server-side media work: the signaling layer tells the
    // patient to renegotiate. An SFU implementation would re-pipe the
    // producer here instead.
    console.log(`[media:p2p] appointment ${appointmentId} moved ${fromRoom} -> ${toRoom}`);
  }
}

export const media = new P2PMediaAdapter();
