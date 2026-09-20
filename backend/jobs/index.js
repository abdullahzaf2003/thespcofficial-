import { run, get } from '../db/sqlite.js';
import {
  queue,
  JOB_SEND_MEETING_LINK,
  JOB_RELEASE_EXPIRED_HOLDS,
  JOB_SEND_REVIEW_INVITE,
  JOB_PURGE_EXPIRED_TOKENS,
} from '../adapters/queue.js';
import { notifier, meetingLinkMessage } from '../adapters/notifications.js';
import { meetingLinkFor, createMeetingToken, purgeExpiredRefreshTokens } from '../domain/tokens.js';
import { createReviewInvite, reviewLinkFor, reviewInviteMessage } from '../domain/reviews.js';
import { releaseExpiredHolds } from '../domain/availability.js';

const HOLD_SWEEP_INTERVAL_MS = 5 * 60_000;
const TOKEN_PURGE_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Background jobs (Section 10). Registered against the queue adapter, so
 * moving to BullMQ later changes the adapter, not these handlers.
 */
export function registerJobs() {
  /**
   * Delivers the actual meeting link `reminderLeadMinutes` before the slot.
   * The booking confirmation deliberately does not contain this link.
   */
  queue.register(JOB_SEND_MEETING_LINK, async ({ appointmentId }) => {
    const appointment = await get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
    if (!appointment) return;

    if (['cancelled', 'completed', 'no_show'].includes(appointment.status)) {
      console.log(`[jobs] skipping link for ${appointmentId} (${appointment.status})`);
      return;
    }

    let token = appointment.meeting_token;
    if (!token) {
      token = createMeetingToken(appointmentId);
      await run('UPDATE appointments SET meeting_token = ? WHERE id = ?', [token, appointmentId]);
    }

    const doctor = await get('SELECT name FROM doctors WHERE id = ?', [appointment.doctor_id]);
    const results = await notifier.sendToPatient(
      appointment,
      meetingLinkMessage(appointment, doctor?.name || 'your doctor', meetingLinkFor(token)),
    );

    // Section 10: send to both, whichever lands is enough. Only a total
    // failure is worth a retry.
    if (!results.some((result) => result.status === 'sent')) {
      throw new Error('Neither email nor WhatsApp delivery succeeded.');
    }

    await run('UPDATE appointments SET reminder_sent_at = ? WHERE id = ?', [new Date().toISOString(), appointmentId]);
  });

  /**
   * Invites the patient to review the consultation they just had. This is the
   * only way a review is ever created — there is no open submission form — so
   * every published review traces back to a completed appointment.
   */
  queue.register(JOB_SEND_REVIEW_INVITE, async ({ appointmentId }) => {
    const appointment = await get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
    if (!appointment || appointment.status !== 'completed') return;

    const existing = await get('SELECT id FROM reviews WHERE appointment_id = ?', [appointmentId]);
    if (existing) return;

    const [doctor, clinic] = await Promise.all([
      get('SELECT name FROM doctors WHERE id = ?', [appointment.doctor_id]),
      get("SELECT value FROM clinic_info WHERE key = 'clinic_name'"),
    ]);

    const { token } = await createReviewInvite(appointmentId);
    await notifier.sendToPatient(
      appointment,
      reviewInviteMessage(
        appointment,
        doctor?.name || 'your doctor',
        reviewLinkFor(token),
        clinic?.value || 'our clinic',
      ),
    );
    // A patient who never sees this simply does not leave a review, so unlike
    // the meeting link there is nothing here worth retrying.
  });

  /** Clears out refresh tokens nobody can use any more. */
  queue.register(JOB_PURGE_EXPIRED_TOKENS, async () => {
    await purgeExpiredRefreshTokens();
    await queue.schedule({
      kind: JOB_PURGE_EXPIRED_TOKENS,
      runAt: new Date(Date.now() + TOKEN_PURGE_INTERVAL_MS),
      dedupeKey: 'token-purge',
    });
  });

  /** Frees slots abandoned mid-booking, then re-arms itself. */
  queue.register(JOB_RELEASE_EXPIRED_HOLDS, async () => {
    await releaseExpiredHolds();
    await queue.schedule({
      kind: JOB_RELEASE_EXPIRED_HOLDS,
      runAt: new Date(Date.now() + HOLD_SWEEP_INTERVAL_MS),
      dedupeKey: 'hold-sweep',
    });
  });
}

/** Re-arms the recurring sweep and any reminders missed while the server was down. */
export async function primeJobs() {
  await queue.schedule({
    kind: JOB_RELEASE_EXPIRED_HOLDS,
    runAt: new Date(Date.now() + 30_000),
    dedupeKey: 'hold-sweep',
  });
  await queue.schedule({
    kind: JOB_PURGE_EXPIRED_TOKENS,
    runAt: new Date(Date.now() + 60_000),
    dedupeKey: 'token-purge',
  });
  await releaseExpiredHolds();
}
