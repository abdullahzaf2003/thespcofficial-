import crypto from 'node:crypto';
import { run, get, all, transaction, isUniqueViolation } from '../db/sqlite.js';
import { config } from '../config.js';
import { isValidSlot, utcToClinicDate, utcToClinicTime } from './availability.js';
import { createMeetingToken } from './tokens.js';
import { queue, JOB_SEND_MEETING_LINK, JOB_SEND_REVIEW_INVITE } from '../adapters/queue.js';
import { notifier, bookingConfirmedMessage } from '../adapters/notifications.js';

/**
 * Appointment lifecycle (Section 8.4).
 *
 *   pending_payment -> confirmed -> in_reception -> with_doctor -> completed
 *                                         \-> cancelled / no_show
 *
 * Transitions are funnelled through `transitionStatus` so the call state and
 * the appointment record can never drift apart.
 */
export const APPOINTMENT_STATUSES = [
  'pending_payment',
  'confirmed',
  'in_reception',
  'with_doctor',
  'completed',
  'cancelled',
  'no_show',
];

const ALLOWED_TRANSITIONS = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['in_reception', 'cancelled', 'no_show'],
  in_reception: ['with_doctor', 'confirmed', 'cancelled', 'no_show'],
  with_doctor: ['completed', 'in_reception', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export class BookingError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'booking_error';
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pakistani numbers arrive as 0308…, +92308… or 92308…; store E.164 digits. */
export function normalizeWhatsapp(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('92')) return digits;
  if (digits.startsWith('0')) return `92${digits.slice(1)}`;
  return digits;
}

// ------------------------------------------------------------------ holds

/**
 * Locks a slot for `slotHoldMinutes` while the patient fills in the form.
 * The unique index on (doctor_id, slot_start) makes this race-safe.
 */
export async function holdSlot({ doctorId, slotStart }) {
  if (!(await isValidSlot(doctorId, slotStart))) {
    throw new BookingError(409, 'That time is no longer available.', 'slot_unavailable');
  }

  const holdToken = crypto.randomBytes(16).toString('base64url');
  const expiresAt = new Date(Date.now() + config.slotHoldMinutes * 60_000).toISOString();
  const slot = await get('SELECT slot_duration_minutes FROM doctors WHERE id = ?', [doctorId]);
  const step = Number(slot?.slot_duration_minutes) || 20;
  const slotEnd = new Date(new Date(slotStart).getTime() + step * 60_000).toISOString();

  try {
    await run(
      'INSERT INTO slot_holds (doctor_id, slot_start, slot_end, hold_token, expires_at) VALUES (?, ?, ?, ?, ?)',
      [doctorId, slotStart, slotEnd, holdToken, expiresAt],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BookingError(409, 'Someone is already booking that time. Please pick another slot.', 'slot_held');
    }
    throw error;
  }

  return { holdToken, expiresAt, slotEnd };
}

export async function releaseHold(holdToken) {
  if (!holdToken) return;
  await run('DELETE FROM slot_holds WHERE hold_token = ?', [holdToken]);
}

// ----------------------------------------------------------- booking flow

export async function createAppointment(input) {
  const patientName = String(input.patient_name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const whatsapp = normalizeWhatsapp(input.patient_whatsapp);
  const phone = String(input.phone || '').trim() || whatsapp;
  const doctorId = Number(input.doctor_id);
  const serviceId = input.service_id ? Number(input.service_id) : null;
  const slotStart = String(input.slot_start || '');

  // Section 5.3: both channels are mandatory, regardless of which one is later
  // used to deliver the link.
  if (!patientName) throw new BookingError(400, 'Your name is required.', 'name_required');
  if (!EMAIL_PATTERN.test(email)) throw new BookingError(400, 'A valid email address is required.', 'email_required');
  if (whatsapp.length < 10) throw new BookingError(400, 'A valid WhatsApp number is required.', 'whatsapp_required');
  if (!Number.isInteger(doctorId)) throw new BookingError(400, 'Please choose a doctor.', 'doctor_required');
  if (!slotStart || Number.isNaN(Date.parse(slotStart))) {
    throw new BookingError(400, 'Please choose an appointment time.', 'slot_required');
  }

  const doctor = await get("SELECT * FROM doctors WHERE id = ? AND status != 'inactive'", [doctorId]);
  if (!doctor) throw new BookingError(404, 'That doctor is not available.', 'doctor_not_found');

  if (new Date(slotStart).getTime() <= Date.now()) {
    throw new BookingError(409, 'That time has already passed.', 'slot_past');
  }

  const step = Number(doctor.slot_duration_minutes) || 20;
  const slotEnd = new Date(new Date(slotStart).getTime() + step * 60_000).toISOString();

  let service = null;
  if (serviceId) {
    service = await get("SELECT * FROM services WHERE id = ? AND status = 'active'", [serviceId]);
  }

  const appointmentId = await transaction(async () => {
    // Re-check inside the transaction; the partial unique index is the real
    // guarantee, this just produces a friendlier error in the common case.
    const clash = await get(
      `SELECT id FROM appointments
       WHERE doctor_id = ? AND slot_start = ? AND status NOT IN ('cancelled', 'no_show')`,
      [doctorId, slotStart],
    );
    if (clash) throw new BookingError(409, 'That slot has just been booked. Please pick another.', 'slot_taken');

    // A hold belonging to this patient is consumed; anyone else's blocks us.
    const hold = await get('SELECT * FROM slot_holds WHERE doctor_id = ? AND slot_start = ?', [doctorId, slotStart]);
    if (hold && input.hold_token && hold.hold_token !== input.hold_token) {
      throw new BookingError(409, 'Someone is already booking that time.', 'slot_held');
    }

    try {
      const { id } = await run(
        `INSERT INTO appointments (
           patient_name, phone, email, patient_whatsapp, doctor_id, doctor_name, service_id,
           appointment_date, appointment_time, slot_start, slot_end, note,
           status, payment_status, current_room, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'unpaid', 'reception', ?, ?)`,
        [
          patientName,
          phone,
          email,
          whatsapp,
          doctorId,
          doctor.name,
          service?.id || null,
          utcToClinicDate(slotStart),
          utcToClinicTime(slotStart),
          slotStart,
          slotEnd,
          String(input.note || ''),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      if (hold) await run('DELETE FROM slot_holds WHERE id = ?', [hold.id]);
      return id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BookingError(409, 'That slot has just been booked. Please pick another.', 'slot_taken');
      }
      throw error;
    }
  });

  // Token is derived from the row id, so it is assigned after insert.
  const meetingToken = createMeetingToken(appointmentId);
  await run('UPDATE appointments SET meeting_token = ? WHERE id = ?', [meetingToken, appointmentId]);

  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);

  // The link itself is NOT sent now (Section 5.4) — only the summary.
  const clinicName = (await get("SELECT value FROM clinic_info WHERE key = 'clinic_name'"))?.value || 'the clinic';
  await notifier.sendToPatient(appointment, bookingConfirmedMessage(appointment, doctor.name, clinicName));

  await scheduleReminder(appointment);

  return appointment;
}

/** Queues the "5 minutes before" meeting-link delivery (Section 5.5). */
export async function scheduleReminder(appointment) {
  const runAt = new Date(new Date(appointment.slot_start).getTime() - config.reminderLeadMinutes * 60_000);
  return queue.schedule({
    kind: JOB_SEND_MEETING_LINK,
    runAt: runAt.getTime() < Date.now() ? new Date() : runAt,
    payload: { appointmentId: appointment.id },
    dedupeKey: `meeting-link:${appointment.id}`,
  });
}

// How long after a consultation ends before the review invitation goes out.
// Long enough not to feel automated, short enough that the visit is fresh.
const REVIEW_INVITE_DELAY_MS = Number(process.env.REVIEW_INVITE_DELAY_MINUTES || 30) * 60_000;

// ------------------------------------------------------------ transitions

export async function transitionStatus(appointmentId, nextStatus, extra = {}) {
  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
  if (!appointment) throw new BookingError(404, 'Appointment not found.', 'not_found');

  const current = appointment.status || 'confirmed';
  if (current === nextStatus) return appointment;

  const allowed = ALLOWED_TRANSITIONS[current] || [];
  if (!allowed.includes(nextStatus)) {
    throw new BookingError(409, `Cannot move an appointment from ${current} to ${nextStatus}.`, 'invalid_transition');
  }

  const fields = { status: nextStatus, updated_at: new Date().toISOString(), ...extra };
  if (nextStatus === 'in_reception' && !appointment.joined_at) fields.joined_at = new Date().toISOString();
  if (nextStatus === 'completed') fields.completed_at = new Date().toISOString();
  if (nextStatus === 'cancelled') fields.cancelled_at = new Date().toISOString();

  const keys = Object.keys(fields);
  await run(`UPDATE appointments SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, [
    ...keys.map((key) => fields[key]),
    appointmentId,
  ]);

  if (['completed', 'cancelled', 'no_show'].includes(nextStatus)) {
    await queue.cancel(`meeting-link:${appointmentId}`);
  }

  // Ask for a review a little after the consultation ends, not the instant the
  // doctor hangs up. Queued rather than sent inline so a notification outage
  // can never fail the status change that the call teardown depends on.
  if (nextStatus === 'completed') {
    await queue.schedule({
      kind: JOB_SEND_REVIEW_INVITE,
      runAt: new Date(Date.now() + REVIEW_INVITE_DELAY_MS),
      payload: { appointmentId },
      dedupeKey: `review-invite:${appointmentId}`,
    });
  }

  return get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
}

export async function appointmentsForDay(dateStr, { doctorId } = {}) {
  const params = [dateStr];
  let sql = 'SELECT * FROM appointments WHERE appointment_date = ?';
  if (doctorId) {
    sql += ' AND doctor_id = ?';
    params.push(doctorId);
  }
  return all(`${sql} ORDER BY slot_start ASC`, params);
}
