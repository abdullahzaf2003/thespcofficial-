import { useCallback, useEffect, useRef, useState } from 'react';
import { signalingUrl } from './api';

/**
 * Signaling + WebRTC client.
 *
 * The socket is the long-lived thing: reception and doctor sockets stay open
 * all shift. Peer connections are disposable and are rebuilt whenever the
 * roster changes — which is exactly what a handoff looks like from the
 * patient's side (`room_changed`, then a fresh roster with the doctor in it).
 * The patient's URL and tab never change.
 *
 * Glare avoidance: of any two peers, the one with the lexicographically
 * smaller peer id creates the offer. Both sides evaluate the same rule, so
 * exactly one offer is made per pair.
 */

export type CallRole = 'reception' | 'doctor' | 'patient';

export type RemotePeer = {
  id: string;
  role: string;
  name: string;
  appointmentId: number | null;
  doctorId: number | null;
};

export type SignalMessage = Record<string, any> & { type: string };

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error';

type Options = {
  role: CallRole;
  token: string | null;
  enabled?: boolean;
  onMessage?: (message: SignalMessage) => void;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

export function useCallSession({ role, token, enabled = true, onMessage }: Options) {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [room, setRoom] = useState<string | null>(null);
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [remotes, setRemotes] = useState<Record<string, MediaStream>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState('');
  const [error, setError] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Read inside `ws.onclose`, whose closure would otherwise see a stale
  // `status` and try to reconnect a session the server deliberately ended.
  const endedRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  onMessageRef.current = onMessage;

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  // --------------------------------------------------------- local media

  const ensureLocalMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localStreamRef.current = stream;
      if (mountedRef.current) {
        setLocalStream(stream);
        setMediaError('');
      }
      return stream;
    } catch (caught) {
      // No camera/mic (or permission denied) is not fatal: the call continues
      // receive-only so the user can still see and hear the other side.
      const message = caught instanceof Error ? caught.message : 'Camera and microphone unavailable.';
      if (mountedRef.current) setMediaError(message);
      return null;
    }
  }, []);

  // ----------------------------------------------------- peer connections

  const closePeer = useCallback((peerId: string) => {
    const pc = pcsRef.current.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pcsRef.current.delete(peerId);
    }
    pendingCandidates.current.delete(peerId);
    setRemotes((current) => {
      if (!current[peerId]) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }, []);

  const closeAllPeers = useCallback(() => {
    for (const peerId of [...pcsRef.current.keys()]) closePeer(peerId);
  }, [closePeer]);

  const createPeer = useCallback(
    async (remoteId: string) => {
      if (pcsRef.current.has(remoteId)) return pcsRef.current.get(remoteId)!;

      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
      pcsRef.current.set(remoteId, pc);

      const stream = localStreamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      } else {
        // Receive-only still needs media lines in the SDP.
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.addTransceiver('video', { direction: 'recvonly' });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) send({ type: 'signal', to: remoteId, data: { candidate: event.candidate.toJSON() } });
      };

      pc.ontrack = (event) => {
        const [incoming] = event.streams;
        if (!incoming) return;
        setRemotes((current) => ({ ...current, [remoteId]: incoming }));
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          // Let the roster rebuild it rather than limping along.
          closePeer(remoteId);
        }
      };

      return pc;
    },
    [send, closePeer],
  );

  const handleSignal = useCallback(
    async (from: string, data: any) => {
      const pc = await createPeer(from);

      if (data.sdp) {
        const description = new RTCSessionDescription(data.sdp);
        await pc.setRemoteDescription(description);

        // Candidates that arrived before the remote description was set.
        const queued = pendingCandidates.current.get(from) || [];
        for (const candidate of queued) await pc.addIceCandidate(candidate).catch(() => {});
        pendingCandidates.current.delete(from);

        if (description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
        }
        return;
      }

      if (data.candidate) {
        if (!pc.remoteDescription) {
          const queued = pendingCandidates.current.get(from) || [];
          queued.push(data.candidate);
          pendingCandidates.current.set(from, queued);
          return;
        }
        await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    },
    [createPeer, send],
  );

  const syncPeers = useCallback(
    async (roster: RemotePeer[]) => {
      const ids = new Set(roster.map((peer) => peer.id));

      for (const existing of [...pcsRef.current.keys()]) {
        if (!ids.has(existing)) closePeer(existing);
      }

      await ensureLocalMedia();

      for (const peer of roster) {
        if (pcsRef.current.has(peer.id)) continue;
        const pc = await createPeer(peer.id);

        // Deterministic offerer, so the two sides never both offer.
        const myId = peerIdRef.current;
        if (myId && myId < peer.id) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send({ type: 'signal', to: peer.id, data: { sdp: pc.localDescription } });
        }
      }

      setPeers(roster);
    },
    [closePeer, createPeer, ensureLocalMedia, send],
  );

  // ---------------------------------------------------------- the socket

  const connect = useCallback(() => {
    if (!token || !enabled) return;

    setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(signalingUrl(role, token));
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      if (mountedRef.current) {
        setStatus('connected');
        setError('');
      }
    };

    ws.onmessage = async (event) => {
      let message: SignalMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (message.type) {
        case 'welcome':
          peerIdRef.current = message.peerId;
          iceServersRef.current = message.iceServers || [];
          setRoom(message.room);
          await ensureLocalMedia();
          break;

        case 'roster':
          await syncPeers(message.peers || []);
          break;

        case 'signal':
          await handleSignal(message.from, message.data);
          break;

        case 'peer_left':
          closePeer(message.peerId);
          break;

        case 'room_changed':
          // A handoff. Drop every peer connection; the roster that follows
          // rebuilds media against whoever is in the new room.
          closeAllPeers();
          setRoom(message.room);
          break;

        case 'session_ended':
          endedRef.current = true;
          closeAllPeers();
          setStatus('ended');
          ws.close(1000, 'session_ended');
          break;

        case 'error':
          endedRef.current = true;
          setError(message.message || 'The call server rejected this session.');
          setStatus('error');
          break;

        default:
          break;
      }

      onMessageRef.current?.(message);
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;
      closeAllPeers();

      // 4001 is an auth rejection and a close after session_ended is
      // deliberate: neither should be retried.
      if (event.code === 4001 || endedRef.current) {
        setStatus((current) => (current === 'ended' ? 'ended' : 'error'));
        return;
      }

      setStatus('reconnecting');
      attemptRef.current += 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attemptRef.current - 1), RECONNECT_MAX_MS);
      reconnectTimer.current = window.setTimeout(() => connect(), delay);
    };

    ws.onerror = () => {
      /* onclose does the recovery work */
    };
  }, [token, enabled, role, ensureLocalMedia, syncPeers, handleSignal, closePeer, closeAllPeers]);

  useEffect(() => {
    mountedRef.current = true;
    endedRef.current = false;
    if (token && enabled) connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      closeAllPeers();
      wsRef.current?.close(1000, 'unmount');
      wsRef.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
    // `connect` is intentionally excluded: it changes on every status update,
    // and re-running this effect would tear down a healthy socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, enabled, role]);

  // ------------------------------------------------------------ controls

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !stream.getAudioTracks().every((track) => track.enabled);
    stream.getAudioTracks().forEach((track) => (track.enabled = next));
    setMicOn(next);
  }, []);

  const toggleCam = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !stream.getVideoTracks().every((track) => track.enabled);
    stream.getVideoTracks().forEach((track) => (track.enabled = next));
    setCamOn(next);
  }, []);

  return {
    status,
    room,
    peers,
    remotes,
    localStream,
    mediaError,
    error,
    micOn,
    camOn,
    toggleMic,
    toggleCam,
    send,
    peerId: peerIdRef.current,
  };
}
