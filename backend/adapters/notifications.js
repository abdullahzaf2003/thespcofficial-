import { run, all } from '../db/sqlite.js';
import { config } from '../config.js';

/**
 * Notification adapter.
 *
 * Contract:
 *   send({ appointmentId, channel, template, recipient, subject, body }) -> Promise<{ id, status }>
 *
 * The shipped implementation is a transactional outbox: every message is
 * persisted to the `notifications` table and logged. Swapping in SES +
 * WhatsApp Cloud API means implementing `deliver()` below and leaving the
 * rest of the codebase untouched — callers only ever use `notifier.send`.
 */

class OutboxNotificationAdapter {
  constructor({ deliver } = {}) {
    this.deliverFn = deliver || null;
  }

  async send({ appointmentId = null, channel, template, recipient, subject = '', body = '' }) {
    if (!recipient) {
      // A missing channel is not an error: Section 10 says send to both and
      // whichever is reachable still delivers.
      return { id: null, status: 'skipped' };
    }

    const { id } = await run(
      `INSERT INTO notifications (appointment_id, channel, template, recipient, subject, body, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      [appointmentId, channel, template, recipient, subject, body],
    );

    try {
      if (this.deliverFn) {
        await this.deliverFn({ channel, recipient, subject, body, template });
      } else {
        console.log(`[notify:${channel}] -> ${recipient} | ${template}\n${subject ? `  ${subject}\n` : ''}  ${body}`);
      }
      await run("UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?", [new Date().toISOString(), id]);
      return { id, status: 'sent' };
    } catch (error) {
      await run("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?", [String(error.message), id]);
      console.error(`[notify:${channel}] delivery failed for ${recipient}:`, error.message);
      return { id, status: 'failed' };
    }
  }

  /** Send the same message over every channel the patient gave us. */
  async sendToPatient(appointment, { template, subject, body }) {
    const results = await Promise.all([
      this.send({
        appointmentId: appointment.id,
        channel: 'email',
        template,
        recipient: appointment.email,
        subject,
        body,
      }),
      this.send({
        appointmentId: appointment.id,
        channel: 'whatsapp',
        template,
        recipient: appointment.patient_whatsapp,
        subject: '',
        body,
      }),
    ]);
    return results;
  }

  async listForAppointment(appointmentId) {
    return all('SELECT * FROM notifications WHERE appointment_id = ? ORDER BY id DESC', [appointmentId]);
  }
}

export const notifier = new OutboxNotificationAdapter();

// ------------------------------------------------------------- templates

export function bookingConfirmedMessage(appointment, doctorName, clinicName) {
  const when = formatSlot(appointment.slot_start);
  return {
    template: 'booking_confirmed',
    subject: `Appointment confirmed — ${clinicName}`,
    body:
      `Hello ${appointment.patient_name}, your appointment with ${doctorName} is confirmed for ${when}. ` +
      `Your meeting link will be sent to you ${config.reminderLeadMinutes} minutes before your scheduled time ` +
      `by email and WhatsApp. Please have your payment confirmation ready for the receptionist.`,
  };
}

export function meetingLinkMessage(appointment, doctorName, link) {
  const when = formatSlot(appointment.slot_start);
  return {
    template: 'meeting_link',
    subject: `Your consultation link — ${when}`,
    body:
      `Your appointment with ${doctorName} starts at ${when}. Join here: ${link}\n` +
      'You will first meet the receptionist, who will verify your payment and connect you to the doctor.',
  };
}

export function appointmentCancelledMessage(appointment, doctorName, reason) {
  const when = formatSlot(appointment.slot_start);
  return {
    template: 'appointment_cancelled',
    subject: 'Appointment cancelled',
    body:
      `Your appointment with ${doctorName} on ${when} has been cancelled.` +
      (reason ? ` Reason: ${reason}.` : '') +
      ' Please contact the clinic to rebook.',
  };
}

export function appointmentRescheduledMessage(appointment, doctorName) {
  return {
    template: 'appointment_rescheduled',
    subject: 'Appointment rescheduled',
    body: `Your appointment with ${doctorName} has been moved to ${formatSlot(appointment.slot_start)}.`,
  };
}

function formatSlot(iso) {
  if (!iso) return 'your scheduled time';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: config.clinicTimezone,
  }).format(new Date(iso));
}
