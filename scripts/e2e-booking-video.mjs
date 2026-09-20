/**
 * End-to-end smoke test for the booking + video pipeline.
 *
 *   node scripts/e2e-booking-video.mjs
 *
 * Expects the API to be running (npm run server). It books a real appointment
 * into a temporary availability window a few minutes from now, then drives the
 * full call flow over WebSockets: patient joins reception, receptionist verifies
 * payment and hands off, doctor completes, token is burnt.
 *
 * Everything it creates is cleaned up at the end.
 */

import WebSocket from 'ws';
import sqlite3 from 'sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'http://localhost:4000';
const WS_BASE = API.replace(/^http/, 'ws');
const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'data', 'clinic.db');
const TZ = 'Asia/Karachi';

let passed = 0;
let failed = 0;
const cleanup = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function api(method, route, { token, body } = {}) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row))));
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));

/** Opens a socket and collects every message it receives. */
function connect(role, token, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?role=${role}&token=${encodeURIComponent(token)}`);
    const messages = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].match(message)) {
          waiters[i].resolve(message);
          waiters.splice(i, 1);
        }
      }
    });

    ws.on('error', reject);

    const client = {
      ws,
      label,
      messages,
      send: (message) => ws.send(JSON.stringify(message)),
      close: () => ws.close(),
      /** Resolves with the first message matching `match`, past or future. */
      waitFor(match, timeoutMs = 6000) {
        const found = messages.find(match);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error(`${label}: timed out waiting for a message (saw: ${messages.map((m) => m.type).join(', ')})`)),
            timeoutMs,
          );
          waiters.push({ match, resolve: (m) => { clearTimeout(timer); res(m); } });
        });
      },
    };

    ws.on('open', () => resolve(client));
    cleanup.push(() => ws.close());
  });
}

const clinicDate = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const clinicTime = (date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).format(date);

async function main() {
  console.log(`Running booking + video E2E against ${API}\n${'='.repeat(52)}`);

  // ------------------------------------------------------------- setup
  section('Health & auth');
  const health = await api('GET', '/api/health');
  check('API is healthy', health.status === 200 && health.body.status === 'ok');
  check('media adapter reports a mode', Boolean(health.body.mediaMode), JSON.stringify(health.body));

  const adminLogin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@surgeonspolyclinic.com', password: 'Admin@12345' },
  });
  check('admin can sign in', adminLogin.status === 200 && Boolean(adminLogin.body.accessToken), JSON.stringify(adminLogin.body));
  const adminToken = adminLogin.body.accessToken;

  const badLogin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@surgeonspolyclinic.com', password: 'wrong-password' },
  });
  check('wrong password is rejected', badLogin.status === 401);

  const doctorRow = await dbGet("SELECT * FROM doctors WHERE username IS NOT NULL ORDER BY id ASC LIMIT 1");
  const doctorLogin = await api('POST', '/api/auth/doctor-login', {
    body: { username: doctorRow.username, password: 'Doctor@12345' },
  });
  check('doctor can sign in', doctorLogin.status === 200 && Boolean(doctorLogin.body.accessToken), JSON.stringify(doctorLogin.body));
  const doctorToken = doctorLogin.body.accessToken;

  const noAuth = await api('GET', '/api/admin/dashboard');
  check('dashboard rejects anonymous callers', noAuth.status === 401);

  const doctorOnAdmin = await api('GET', '/api/admin/doctors', { token: doctorToken });
  check('doctor token cannot reach admin routes', doctorOnAdmin.status === 403, `got ${doctorOnAdmin.status}`);

  // ------------------------------------------------- availability window
  section('Availability & slot generation');

  // Give the doctor a temporary window starting a couple of minutes from now so
  // the booked slot falls inside the meeting-token join window.
  //
  // Availability overrides are per calendar date, so a window running from now
  // to an hour out cannot be expressed as one row when "an hour out" is
  // tomorrow in the clinic's timezone — end_time would sort before start_time
  // and the generator would produce nothing. Late in the clinic evening the
  // window is therefore split across the midnight boundary. Without this the
  // suite simply fails between roughly 23:00 and midnight Asia/Karachi.
  const windowStart = new Date(Date.now() + 2 * 60_000);
  const windowEnd = new Date(Date.now() + 62 * 60_000);
  const today = clinicDate(windowStart);
  const wrapsMidnight = clinicDate(windowEnd) !== today;

  const override = await api('POST', `/api/admin/doctors/${doctorRow.id}/overrides`, {
    token: adminToken,
    body: {
      date: today,
      kind: 'custom',
      start_time: clinicTime(windowStart),
      end_time: wrapsMidnight ? '23:59' : clinicTime(windowEnd),
      reason: 'e2e test window',
    },
  });
  check('admin can add a date override', override.status === 201, JSON.stringify(override.body));
  cleanup.push(() => api('DELETE', `/api/admin/overrides/${override.body.id}`, { token: adminToken }));

  if (wrapsMidnight) {
    const tail = await api('POST', `/api/admin/doctors/${doctorRow.id}/overrides`, {
      token: adminToken,
      body: {
        date: clinicDate(windowEnd),
        kind: 'custom',
        start_time: '00:00',
        end_time: clinicTime(windowEnd),
        reason: 'e2e test window (after midnight)',
      },
    });
    if (tail.status === 201) {
      cleanup.push(() => api('DELETE', `/api/admin/overrides/${tail.body.id}`, { token: adminToken }));
    }
  }

  const availability = await api('GET', `/api/doctors/${doctorRow.id}/availability?date=${today}`);
  check('availability returns slots for the override window', availability.body.slots?.length > 0, JSON.stringify(availability.body).slice(0, 200));
  check('every returned slot is in the future', availability.body.slots.every((slot) => new Date(slot.start) > new Date()));

  const slot = availability.body.slots[0];

  // --------------------------------------------------------- validation
  section('Booking validation');

  const noWhatsapp = await api('POST', '/api/appointments', {
    body: { patient_name: 'Test Patient', email: 'test@example.com', doctor_id: doctorRow.id, slot_start: slot.start },
  });
  check('booking without WhatsApp is refused', noWhatsapp.status === 400 && noWhatsapp.body.code === 'whatsapp_required', JSON.stringify(noWhatsapp.body));

  const badEmail = await api('POST', '/api/appointments', {
    body: { patient_name: 'Test Patient', email: 'not-an-email', patient_whatsapp: '03001234567', doctor_id: doctorRow.id, slot_start: slot.start },
  });
  check('booking with an invalid email is refused', badEmail.status === 400 && badEmail.body.code === 'email_required', JSON.stringify(badEmail.body));

  const pastSlot = await api('POST', '/api/appointments', {
    body: {
      patient_name: 'Test Patient', email: 'test@example.com', patient_whatsapp: '03001234567',
      doctor_id: doctorRow.id, slot_start: new Date(Date.now() - 3600_000).toISOString(),
    },
  });
  check('booking a past slot is refused', pastSlot.status === 409, JSON.stringify(pastSlot.body));

  // ------------------------------------------------------------ holding
  section('Slot holds & double-booking');

  const hold = await api('POST', '/api/appointments/hold', {
    body: { doctor_id: doctorRow.id, slot_start: slot.start },
  });
  check('a slot can be held', hold.status === 201 && Boolean(hold.body.holdToken), JSON.stringify(hold.body));

  const secondHold = await api('POST', '/api/appointments/hold', {
    body: { doctor_id: doctorRow.id, slot_start: slot.start },
  });
  check('a held slot cannot be held twice', secondHold.status === 409, JSON.stringify(secondHold.body));

  const heldAvailability = await api('GET', `/api/doctors/${doctorRow.id}/availability?date=${today}`);
  const heldSlot = heldAvailability.body.slots.find((s) => s.start === slot.start);
  check('a held slot shows as unavailable', heldSlot?.available === false, JSON.stringify(heldSlot));

  // ------------------------------------------------------------ booking
  section('Booking');

  const booking = await api('POST', '/api/appointments', {
    body: {
      patient_name: 'E2E Test Patient',
      email: 'e2e-patient@example.com',
      patient_whatsapp: '0300 123 4567',
      doctor_id: doctorRow.id,
      slot_start: slot.start,
      hold_token: hold.body.holdToken,
      note: 'Automated end-to-end test booking.',
    },
  });
  check('appointment is created', booking.status === 201, JSON.stringify(booking.body));
  const appointmentId = booking.body.appointment?.id;
  cleanup.push(() => dbRun('DELETE FROM appointments WHERE id = ?', [appointmentId]));
  cleanup.push(() => dbRun('DELETE FROM notifications WHERE appointment_id = ?', [appointmentId]));

  check('appointment starts as confirmed', booking.body.appointment?.status === 'confirmed', booking.body.appointment?.status);
  check('response does NOT leak the meeting link', !JSON.stringify(booking.body).includes('/j/'), JSON.stringify(booking.body));

  const stored = await dbGet('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
  check('WhatsApp number is normalised to E.164 digits', stored.patient_whatsapp === '923001234567', stored.patient_whatsapp);
  check('meeting token was generated', Boolean(stored.meeting_token));

  const rebook = await api('POST', '/api/appointments', {
    body: {
      patient_name: 'Someone Else', email: 'other@example.com', patient_whatsapp: '03009999999',
      doctor_id: doctorRow.id, slot_start: slot.start,
    },
  });
  check('the same slot cannot be booked twice', rebook.status === 409, JSON.stringify(rebook.body));

  // Race: fire several bookings at one slot simultaneously, expect exactly one win.
  const raceSlot = heldAvailability.body.slots.find((s) => s.start !== slot.start && s.available);
  if (raceSlot) {
    const attempts = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        api('POST', '/api/appointments', {
          body: {
            patient_name: `Racer ${n}`, email: `racer${n}@example.com`, patient_whatsapp: `0300111222${n}`,
            doctor_id: doctorRow.id, slot_start: raceSlot.start,
          },
        }),
      ),
    );
    const wins = attempts.filter((attempt) => attempt.status === 201);
    check('concurrent bookings on one slot produce exactly one winner', wins.length === 1, `${wins.length} succeeded`);
    for (const win of wins) cleanup.push(() => dbRun('DELETE FROM appointments WHERE id = ?', [win.body.appointment.id]));
  }

  // ------------------------------------------------------ notifications
  section('Notifications');

  const outbox = await api('GET', '/api/admin/notifications?limit=20', { token: adminToken });
  const confirmations = outbox.body.filter((n) => n.appointment_id === appointmentId && n.template === 'booking_confirmed');
  check('confirmation queued on both channels', confirmations.length === 2, `got ${confirmations.length}`);
  check('confirmation went to email and WhatsApp', new Set(confirmations.map((n) => n.channel)).size === 2);
  check('confirmation does NOT contain the meeting link', confirmations.every((n) => !n.body.includes('/j/')));

  const reminderJob = await dbGet("SELECT * FROM jobs WHERE dedupe_key = ?", [`meeting-link:${appointmentId}`]);
  check('the 5-minute reminder job was scheduled', Boolean(reminderJob), JSON.stringify(reminderJob));
  cleanup.push(() => dbRun('DELETE FROM jobs WHERE dedupe_key = ?', [`meeting-link:${appointmentId}`]));

  const resend = await api('POST', `/api/admin/appointments/${appointmentId}/resend-link`, { token: adminToken });
  check('reception can resend the meeting link', resend.status === 200, JSON.stringify(resend.body));

  // Reception can reveal the link to copy it or read it out on the phone.
  const revealed = await api('GET', `/api/admin/appointments/${appointmentId}/meeting-link`, { token: adminToken });
  check('reception can reveal the join link', revealed.status === 200 && revealed.body.link?.includes('/j/'), JSON.stringify(revealed.body).slice(0, 160));
  check('revealed link carries the validity window', Boolean(revealed.body.opensAt && revealed.body.expiresAt), JSON.stringify(revealed.body));

  const anonLink = await api('GET', `/api/admin/appointments/${appointmentId}/meeting-link`);
  check('the join link is not readable without auth', anonLink.status === 401, `got ${anonLink.status}`);

  const doctorLink = await api('GET', `/api/admin/appointments/${appointmentId}/meeting-link`, { token: doctorToken });
  check('doctors cannot read patient join links', doctorLink.status === 403, `got ${doctorLink.status}`);

  const listLeak = await api('GET', '/api/admin/appointments?limit=5', { token: adminToken });
  check('the appointments list still never carries tokens', !JSON.stringify(listLeak.body).includes('/j/'));

  const linkMessages = (await api('GET', '/api/admin/notifications?limit=40', { token: adminToken })).body.filter(
    (n) => n.appointment_id === appointmentId && n.template === 'meeting_link',
  );
  check('the resent message carries the join link', linkMessages.length === 2 && linkMessages.every((n) => n.body.includes('/j/')), JSON.stringify(linkMessages.map((n) => n.channel)));

  // ------------------------------------------------- token access control
  section('Meeting token');

  const meetingToken = (await dbGet('SELECT meeting_token FROM appointments WHERE id = ?', [appointmentId])).meeting_token;

  const forged = await api('GET', `/api/video/session/${appointmentId}.abc.def`);
  check('a forged token is rejected', forged.status === 403, JSON.stringify(forged.body));

  const session = await api('GET', `/api/video/session/${meetingToken}`);
  check('a valid token returns a joinable session', session.status === 200 && session.body.joinable === true, JSON.stringify(session.body).slice(0, 200));
  check('session bootstrap includes ICE servers', Array.isArray(session.body.iceServers) && session.body.iceServers.length > 0);
  check('patient is routed to reception first', session.body.room === 'reception', session.body.room);

  // --------------------------------------------------------- video flow
  section('Reception → doctor handoff');

  const reception = await connect('reception', adminToken, 'reception');
  await reception.waitFor((m) => m.type === 'welcome');
  check('receptionist joins the persistent reception room', reception.messages.some((m) => m.type === 'welcome' && m.room === 'reception'));

  const doctorClient = await connect('doctor', doctorToken, 'doctor');
  const doctorWelcome = await doctorClient.waitFor((m) => m.type === 'welcome');
  check('doctor joins their own persistent room', doctorWelcome.room === `doctor:${doctorRow.id}`, doctorWelcome.room);

  const presence = await reception.waitFor((m) => m.type === 'presence' && m.doctors.length > 0);
  check('reception sees the doctor come online', presence.doctors.some((d) => d.id === doctorRow.id), JSON.stringify(presence));

  const patient = await connect('patient', meetingToken, 'patient');
  const patientWelcome = await patient.waitFor((m) => m.type === 'welcome');
  check('patient joins with only their link', patientWelcome.room === 'reception', patientWelcome.room);

  const arrived = await reception.waitFor((m) => m.type === 'patient_joined');
  check('reception is told the patient arrived', arrived.appointment?.id === appointmentId, JSON.stringify(arrived).slice(0, 200));
  check('status moved to in_reception', arrived.appointment?.status === 'in_reception', arrived.appointment?.status);

  const roster = await patient.waitFor((m) => m.type === 'roster' && m.peers.length > 0);
  check('patient is given the receptionist as a WebRTC peer', roster.peers.some((p) => p.role === 'reception'), JSON.stringify(roster));

  // Receptionist verifies payment on the call.
  const payment = await api('PATCH', `/api/admin/appointments/${appointmentId}/payment-status`, {
    token: adminToken,
    body: { payment_status: 'verified' },
  });
  check('receptionist can mark payment verified', payment.status === 200 && payment.body.appointment.payment_status === 'verified', JSON.stringify(payment.body).slice(0, 200));

  // The handoff itself.
  const handoff = await api('POST', '/api/handoff', {
    token: adminToken,
    body: { appointmentId, doctorId: doctorRow.id },
  });
  check('handoff is accepted', handoff.status === 200, JSON.stringify(handoff.body));

  const roomChanged = await patient.waitFor((m) => m.type === 'room_changed');
  check('patient is re-pointed to the doctor room on the SAME socket', roomChanged.room === `doctor:${doctorRow.id}`, roomChanged.room);
  check('patient never received a new URL', !JSON.stringify(roomChanged).includes('/j/'));

  const doctorSeesPatient = await doctorClient.waitFor((m) => m.type === 'patient_joined');
  check('doctor is told the patient arrived', doctorSeesPatient.appointment?.id === appointmentId);
  check('status moved to with_doctor', doctorSeesPatient.appointment?.status === 'with_doctor', doctorSeesPatient.appointment?.status);

  const doctorRoster = await doctorClient.waitFor((m) => m.type === 'roster' && m.peers.some((p) => p.role === 'patient'));
  check('doctor and patient are now WebRTC peers', doctorRoster.peers.some((p) => p.role === 'patient'));

  // Signal relay between the two peers actually in the room.
  const patientPeerId = doctorRoster.peers.find((p) => p.role === 'patient').id;
  doctorClient.send({ type: 'signal', to: patientPeerId, data: { kind: 'offer', sdp: 'fake-sdp' } });
  const relayed = await patient.waitFor((m) => m.type === 'signal');
  check('SDP/ICE is relayed between peers in a room', relayed.data?.sdp === 'fake-sdp', JSON.stringify(relayed));

  // ------------------------------------------------------- notes & close
  section('Doctor notes & completion');

  const notes = await api('PATCH', `/api/doctor/appointments/${appointmentId}/notes`, {
    token: doctorToken,
    body: { notes: 'Patient reviewed. Follow up in two weeks.' },
  });
  check('doctor can save notes', notes.status === 200, JSON.stringify(notes.body));

  const complete = await api('PATCH', `/api/doctor/appointments/${appointmentId}/complete`, {
    token: doctorToken,
    body: { notes: 'Consultation complete.' },
  });
  check('doctor can complete the consultation', complete.status === 200 && complete.body.appointment.status === 'completed', JSON.stringify(complete.body).slice(0, 200));

  const ended = await patient.waitFor((m) => m.type === 'session_ended');
  check('patient session is torn down', ended.reason === 'completed', JSON.stringify(ended));

  const burnt = await dbGet('SELECT meeting_token, status FROM appointments WHERE id = ?', [appointmentId]);
  check('meeting token is invalidated after completion', burnt.meeting_token === null, String(burnt.meeting_token));

  const revealAfter = await api('GET', `/api/admin/appointments/${appointmentId}/meeting-link`, { token: adminToken });
  check('a completed appointment will not re-mint a link', revealAfter.status === 409, `got ${revealAfter.status}`);

  const reuse = await api('GET', `/api/video/session/${meetingToken}`);
  check('the old link no longer works', reuse.status === 403, JSON.stringify(reuse.body));

  // Rooms outlive the patient (Section 8.1).
  check('reception socket is still open', reception.ws.readyState === WebSocket.OPEN);
  check('doctor socket is still open', doctorClient.ws.readyState === WebSocket.OPEN);

  const badTransition = await api('PATCH', `/api/admin/appointments/${appointmentId}`, {
    token: adminToken,
    body: { status: 'in_reception' },
  });
  check('a completed appointment cannot move backwards', badTransition.status === 409, JSON.stringify(badTransition.body));

  // ------------------------------------------------------------ scoping
  section('Doctor data scoping');

  const otherDoctor = await dbGet('SELECT id FROM doctors WHERE id != ? LIMIT 1', [doctorRow.id]);
  if (otherDoctor) {
    const foreign = await api('GET', `/api/doctor/appointments/${appointmentId}`, { token: doctorToken });
    check('doctor can read their own appointment', foreign.status === 200);
  }
  const doctorList = await api('GET', '/api/doctor/appointments?scope=completed', { token: doctorToken });
  check('doctor list is scoped to that doctor', doctorList.body.every((a) => a.doctor_id === doctorRow.id), JSON.stringify(doctorList.body.map((a) => a.doctor_id)));
  // `meeting_token_used_at` is a timestamp and may legitimately be present —
  // only the token column itself must never be exposed.
  check(
    'doctor list never includes meeting tokens',
    doctorList.body.every((appointment) => !Object.hasOwn(appointment, 'meeting_token')),
    JSON.stringify(Object.keys(doctorList.body[0] || {}).filter((key) => key.includes('meeting'))),
  );
}

main()
  .catch((error) => {
    failed += 1;
    console.error('\nFATAL:', error.message);
  })
  .finally(async () => {
    for (const task of cleanup.reverse()) {
      try {
        await task();
      } catch {
        /* best effort */
      }
    }
    db.close();

    console.log(`\n${'='.repeat(52)}`);
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
