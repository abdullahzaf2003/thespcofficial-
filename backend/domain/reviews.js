import crypto from 'node:crypto';
import { run, get } from '../db/sqlite.js';
import { config } from '../config.js';

/**
 * Review invitations.
 *
 * A review can only exist because a consultation actually happened. When an
 * appointment is completed the patient is sent a one-time link; that link is
 * the only way to reach the review form. This removes the open POST endpoint
 * that previously let anyone publish to the home page, and it means every
 * published review is attached to a real appointment with a real doctor.
 *
 * The token is hashed at rest for the same reason the refresh tokens are: a
 * database leak should not hand out working links.
 */

const INVITE_TTL_DAYS = Number(process.env.REVIEW_INVITE_TTL_DAYS || 30);

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Creates (or reissues) the invitation for an appointment. Reissuing keeps one
 * row per appointment, so a resend cannot produce two usable links.
 */
export async function createReviewInvite(appointmentId) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();

  await run(
    `INSERT INTO review_invites (appointment_id, token_hash, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(appointment_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       expires_at = excluded.expires_at,
       used_at = NULL`,
    [appointmentId, hash(token), expiresAt],
  );

  return { token, expiresAt };
}

export function reviewLinkFor(token, origin) {
  const base = (origin || config.publicBaseUrl).replace(/\/$/, '');
  return `${base}/review/${token}`;
}

/**
 * Resolves an invite token to the appointment it belongs to.
 * Returns `{ ok: true, appointment, invite }` or `{ ok: false, message }`.
 */
export async function resolveReviewInvite(token) {
  if (typeof token !== 'string' || token.length < 20) {
    return { ok: false, message: 'This review link is not valid.' };
  }

  const invite = await get('SELECT * FROM review_invites WHERE token_hash = ?', [hash(token)]);
  if (!invite) return { ok: false, message: 'This review link is not valid.' };

  if (invite.used_at) {
    return { ok: false, message: 'You have already left a review for this appointment. Thank you!' };
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { ok: false, message: 'This review link has expired.' };
  }

  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [invite.appointment_id]);
  if (!appointment || appointment.status !== 'completed') {
    return { ok: false, message: 'This review link is not valid.' };
  }

  return { ok: true, appointment, invite };
}

export async function markInviteUsed(inviteId) {
  await run('UPDATE review_invites SET used_at = ? WHERE id = ?', [new Date().toISOString(), inviteId]);
}

export function reviewInviteMessage(appointment, doctorName, link, clinicName = 'our clinic') {
  return {
    template: 'review_invite',
    subject: 'How was your consultation?',
    body:
      `Thank you for visiting ${clinicName}. If you have a moment, we would love to hear how your ` +
      `consultation with ${doctorName} went: ${link}\n` +
      'Your review is read by our team before it appears on our website.',
  };
}
