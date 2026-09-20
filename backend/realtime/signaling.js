import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { get, run } from '../db/sqlite.js';
import { verifyAccessToken, resolveMeetingToken } from '../domain/tokens.js';
import { transitionStatus } from '../domain/booking.js';
import { media } from '../adapters/media.js';
import { config, isProduction } from '../config.js';

/**
 * WebRTC signaling hub (Section 8.2).
 *
 * Rooms:
 *   reception          — one persistent room, live whenever a receptionist is on shift
 *   doctor:{doctorId}  — one persistent room per doctor
 *
 * A patient connects with their meeting token and is placed in `reception`.
 * A handoff re-points that patient's room to `doctor:{id}`; the patient's
 * socket, tab and URL never change. Reception and doctor rooms outlive every
 * patient session — only per-patient state resets.
 *
 * Media itself never touches this server: it relays SDP/ICE between peers and
 * lets the browsers connect directly (see adapters/media.js).
 */

export const RECEPTION_ROOM = 'reception';
export const doctorRoom = (doctorId) => `doctor:${doctorId}`;

class SignalingHub {
  constructor() {
    this.peers = new Map(); // peerId -> peer
    this.rooms = new Map(); // roomId -> Set<peerId>
  }

  // ------------------------------------------------------------ registry

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    this.joinRoom(peer.id, peer.room);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    this.leaveRoom(peerId, peer.room);
    this.peers.delete(peerId);
    return peer;
  }

  joinRoom(peerId, roomId) {
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set());
    this.rooms.get(roomId).add(peerId);
  }

  leaveRoom(peerId, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.delete(peerId);
    // Reception and doctor rooms are persistent concepts, but the in-memory
    // Set is disposable — it is recreated on the next join.
    if (room.size === 0) this.rooms.delete(roomId);
  }

  peersIn(roomId) {
    return [...(this.rooms.get(roomId) || [])].map((id) => this.peers.get(id)).filter(Boolean);
  }

  peerByAppointment(appointmentId) {
    for (const peer of this.peers.values()) {
      if (peer.role === 'patient' && peer.appointmentId === appointmentId) return peer;
    }
    return null;
  }

  onlineDoctors() {
    const seen = new Map();
    for (const peer of this.peers.values()) {
      if (peer.role === 'doctor') seen.set(peer.doctorId, { id: peer.doctorId, name: peer.name, online: true });
    }
    return [...seen.values()];
  }

  // -------------------------------------------------------------- sending

  send(peer, message) {
    if (!peer || peer.ws.readyState !== peer.ws.OPEN) return;
    peer.ws.send(JSON.stringify(message));
  }

  broadcast(roomId, message, { except } = {}) {
    for (const peer of this.peersIn(roomId)) {
      if (except && peer.id === except) continue;
      this.send(peer, message);
    }
  }

  /** Staff dashboards everywhere get presence updates, not just one room. */
  broadcastPresence() {
    const doctors = this.onlineDoctors();
    const message = { type: 'presence', doctors };
    for (const peer of this.peers.values()) {
      if (peer.role === 'reception' || peer.role === 'doctor') this.send(peer, message);
    }
  }

  publicPeer(peer) {
    return {
      id: peer.id,
      role: peer.role,
      name: peer.name,
      appointmentId: peer.appointmentId || null,
      doctorId: peer.doctorId || null,
    };
  }

  /** Tells everyone in a room who else is there, so WebRTC can start. */
  syncRoom(roomId) {
    const peers = this.peersIn(roomId);
    for (const peer of peers) {
      this.send(peer, {
        type: 'roster',
        room: roomId,
        peers: peers.filter((other) => other.id !== peer.id).map((other) => this.publicPeer(other)),
      });
    }
  }

  // -------------------------------------------------------------- handoff

  /**
   * Re-points a patient's session at a doctor's room. The patient keeps the
   * same socket and the same URL; their client renegotiates media with the
   * new peer (Section 8.1).
   */
  async handoff({ appointmentId, doctorId, byName }) {
    const appointment = await get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
    if (!appointment) throw new Error('Appointment not found.');

    const doctor = await get('SELECT id, name FROM doctors WHERE id = ?', [doctorId]);
    if (!doctor) throw new Error('Doctor not found.');

    const target = doctorRoom(doctor.id);
    const patient = this.peerByAppointment(appointmentId);

    await transitionStatus(appointmentId, 'with_doctor', { current_room: target });
    await media.onRoomChanged({ appointmentId, fromRoom: appointment.current_room, toRoom: target });

    if (patient) {
      const previousRoom = patient.room;
      this.leaveRoom(patient.id, previousRoom);
      patient.room = target;
      this.joinRoom(patient.id, target);

      // Old room: drop the peer connection.
      this.broadcast(previousRoom, { type: 'peer_left', peerId: patient.id, reason: 'handoff' });
      // Patient: tear down and renegotiate against the doctor.
      this.send(patient, {
        type: 'room_changed',
        room: target,
        doctor: { id: doctor.id, name: doctor.name },
        message: `Connecting you to ${doctor.name}…`,
      });
      this.syncRoom(previousRoom);
      this.syncRoom(target);
    }

    this.broadcast(target, {
      type: 'patient_joined',
      appointment: await get('SELECT * FROM appointments WHERE id = ?', [appointmentId]),
      handedOffBy: byName || 'Reception',
      online: Boolean(patient),
    });

    this.broadcast(RECEPTION_ROOM, { type: 'patient_handed_off', appointmentId, doctorId: doctor.id });

    return { appointmentId, room: target, patientOnline: Boolean(patient) };
  }

  /** Ends one patient session and invalidates their token. Rooms stay alive. */
  async completeSession(appointmentId, { notes } = {}) {
    const extra = { current_room: null, meeting_token_used_at: new Date().toISOString() };
    if (typeof notes === 'string') extra.doctor_notes = notes;

    const appointment = await transitionStatus(appointmentId, 'completed', extra);
    // Burn the token so a copied link cannot be reused (Section 8.1).
    await run('UPDATE appointments SET meeting_token = NULL WHERE id = ?', [appointmentId]);

    const patient = this.peerByAppointment(appointmentId);
    if (patient) {
      const room = patient.room;
      this.send(patient, { type: 'session_ended', reason: 'completed', message: 'Your consultation has ended.' });
      this.removePeer(patient.id);
      setTimeout(() => patient.ws.close(1000, 'session_completed'), 250);
      this.broadcast(room, { type: 'peer_left', peerId: patient.id, reason: 'completed' });
      this.syncRoom(room);
    }

    this.broadcast(RECEPTION_ROOM, { type: 'appointment_updated', appointment });
    if (appointment.doctor_id) {
      this.broadcast(doctorRoom(appointment.doctor_id), { type: 'appointment_updated', appointment });
    }
    return appointment;
  }

  /** Sends the patient back to reception (e.g. wrong doctor picked). */
  async returnToReception(appointmentId) {
    const appointment = await transitionStatus(appointmentId, 'in_reception', { current_room: RECEPTION_ROOM });
    const patient = this.peerByAppointment(appointmentId);

    if (patient) {
      const previousRoom = patient.room;
      this.leaveRoom(patient.id, previousRoom);
      patient.room = RECEPTION_ROOM;
      this.joinRoom(patient.id, RECEPTION_ROOM);
      this.broadcast(previousRoom, { type: 'peer_left', peerId: patient.id, reason: 'returned' });
      this.send(patient, { type: 'room_changed', room: RECEPTION_ROOM, message: 'Returning you to reception…' });
      this.syncRoom(previousRoom);
      this.syncRoom(RECEPTION_ROOM);
    }

    this.broadcast(RECEPTION_ROOM, { type: 'patient_joined', appointment, online: Boolean(patient) });
    return appointment;
  }

  notifyPaymentVerified(appointment) {
    const patient = this.peerByAppointment(appointment.id);
    if (patient) this.send(patient, { type: 'payment_verified', appointment: { id: appointment.id } });
    this.broadcast(RECEPTION_ROOM, { type: 'appointment_updated', appointment });
  }
}

export const hub = new SignalingHub();

// --------------------------------------------------------------- server

async function authenticate(url) {
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');
  if (!token) return { error: 'A token is required.' };

  if (role === 'patient') {
    const result = await resolveMeetingToken(token);
    if (!result.ok) return { error: result.message, reason: result.reason };

    const appointment = result.appointment;
    return {
      role: 'patient',
      name: appointment.patient_name,
      appointmentId: appointment.id,
      doctorId: appointment.doctor_id,
      // A patient always lands in reception first, even if a previous handoff
      // set current_room — the receptionist re-verifies on every session.
      room: appointment.status === 'with_doctor' ? appointment.current_room || RECEPTION_ROOM : RECEPTION_ROOM,
      appointment,
    };
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    return { error: 'Your session has expired.' };
  }

  if (claims.role === 'doctor') {
    const doctor = await get('SELECT id, name, socket_room_id FROM doctors WHERE id = ?', [Number(claims.sub)]);
    if (!doctor) return { error: 'Doctor not found.' };
    return { role: 'doctor', name: doctor.name, doctorId: doctor.id, room: doctorRoom(doctor.id) };
  }

  if (claims.role === 'admin' || claims.role === 'receptionist') {
    return { role: 'reception', name: claims.name || 'Reception', staffId: Number(claims.sub), room: RECEPTION_ROOM };
  }

  return { error: 'This account cannot join a consultation room.' };
}

/**
 * Browsers do not apply CORS to WebSockets, so an allowed-origin check has to
 * be made explicitly at the upgrade.
 *
 * This is defence in depth rather than the primary control: a room is joined
 * by presenting a token in the query string, never by a cookie the browser
 * attaches on its own, so a hostile page has nothing to replay. The check
 * still belongs here — it costs nothing and closes the hole that would open
 * the day someone switches this to cookie auth.
 */
function isAllowedWsOrigin(origin) {
  if (!origin) return true; // Non-browser client; it still needs a valid token.
  if (config.allowedOrigins.includes(origin)) return true;
  return !isProduction && PRIVATE_ORIGIN.test(origin);
}

const PRIVATE_ORIGIN =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

export function attachSignaling(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient({ origin }, done) {
      if (isAllowedWsOrigin(origin)) return done(true);
      console.warn(`[signaling] refused a socket from ${origin}`);
      return done(false, 403, 'Forbidden origin');
    },
  });

  wss.on('connection', async (ws, request) => {
    const url = new URL(request.url, 'http://localhost');
    const identity = await authenticate(url);

    if (identity.error) {
      ws.send(JSON.stringify({ type: 'error', message: identity.error, reason: identity.reason || 'unauthorized' }));
      ws.close(4001, 'unauthorized');
      return;
    }

    const peer = {
      id: crypto.randomBytes(9).toString('base64url'),
      ws,
      role: identity.role,
      name: identity.name,
      room: identity.room,
      doctorId: identity.doctorId || null,
      staffId: identity.staffId || null,
      appointmentId: identity.appointmentId || null,
      alive: true,
    };

    // One live socket per patient: a refreshed tab replaces the old one.
    if (peer.role === 'patient') {
      const existing = hub.peerByAppointment(peer.appointmentId);
      if (existing) {
        hub.send(existing, { type: 'session_ended', reason: 'replaced', message: 'Joined from another window.' });
        hub.removePeer(existing.id);
        existing.ws.close(1000, 'replaced');
      }
    }

    hub.addPeer(peer);

    hub.send(peer, {
      type: 'welcome',
      peerId: peer.id,
      role: peer.role,
      name: peer.name,
      room: peer.room,
      ...media.getJoinConfig(),
    });

    if (peer.role === 'patient') {
      // confirmed -> in_reception the moment they land (Section 8.4).
      try {
        const appointment =
          identity.appointment.status === 'confirmed'
            ? await transitionStatus(peer.appointmentId, 'in_reception', { current_room: peer.room })
            : identity.appointment;
        hub.broadcast(peer.room, { type: 'patient_joined', appointment, online: true }, { except: peer.id });
      } catch (error) {
        console.error('[signaling] patient status update failed:', error.message);
      }
    } else {
      hub.broadcastPresence();
      // A staff member joining an occupied room needs the current patient list.
      const waiting = hub.peersIn(peer.room).filter((other) => other.role === 'patient');
      for (const patient of waiting) {
        const appointment = await get('SELECT * FROM appointments WHERE id = ?', [patient.appointmentId]);
        if (appointment) hub.send(peer, { type: 'patient_joined', appointment, online: true });
      }
    }

    hub.syncRoom(peer.room);

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (message.type) {
        // SDP offers/answers and ICE candidates, relayed verbatim between two
        // peers that the server has already placed in the same room.
        case 'signal': {
          const target = hub.peers.get(message.to);
          if (!target || target.room !== peer.room) return;
          hub.send(target, { type: 'signal', from: peer.id, data: message.data });
          return;
        }

        case 'handoff': {
          if (peer.role !== 'reception') {
            return hub.send(peer, { type: 'error', message: 'Only reception can hand off a patient.' });
          }
          try {
            await hub.handoff({
              appointmentId: Number(message.appointmentId),
              doctorId: Number(message.doctorId),
              byName: peer.name,
            });
          } catch (error) {
            hub.send(peer, { type: 'error', message: error.message });
          }
          return;
        }

        case 'complete': {
          if (peer.role !== 'doctor' && peer.role !== 'reception') return;
          try {
            await hub.completeSession(Number(message.appointmentId), { notes: message.notes });
          } catch (error) {
            hub.send(peer, { type: 'error', message: error.message });
          }
          return;
        }

        case 'return_to_reception': {
          if (peer.role !== 'doctor' && peer.role !== 'reception') return;
          try {
            await hub.returnToReception(Number(message.appointmentId));
          } catch (error) {
            hub.send(peer, { type: 'error', message: error.message });
          }
          return;
        }

        case 'chat': {
          hub.broadcast(peer.room, {
            type: 'chat',
            from: peer.name,
            role: peer.role,
            text: String(message.text || '').slice(0, 1000),
            at: new Date().toISOString(),
          });
          return;
        }

        case 'pong':
        case 'ping': {
          peer.alive = true;
          hub.send(peer, { type: 'pong' });
          return;
        }

        default:
          return;
      }
    });

    ws.on('pong', () => {
      peer.alive = true;
    });

    ws.on('close', async () => {
      const removed = hub.removePeer(peer.id);
      if (!removed) return;

      hub.broadcast(removed.room, { type: 'peer_left', peerId: removed.id, reason: 'disconnected' });
      hub.syncRoom(removed.room);

      if (removed.role === 'patient') {
        hub.broadcast(removed.room, { type: 'patient_left', appointmentId: removed.appointmentId });
      } else {
        hub.broadcastPresence();
      }
    });
  });

  // Drop sockets that stopped responding so presence stays honest.
  const heartbeat = setInterval(() => {
    for (const peer of hub.peers.values()) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      try {
        peer.ws.ping();
      } catch {
        peer.ws.terminate();
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));

  console.log('[signaling] websocket hub listening on /ws');
  return wss;
}
