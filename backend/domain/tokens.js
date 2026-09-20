import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config, isProduction } from '../config.js';
import { run, get, all } from '../db/sqlite.js';

// -------------------------------------------------------- meeting tokens

/**
 * Patient meeting tokens (Section 9).
 *
 * Opaque, HMAC-signed, bound to one appointment, and only accepted inside the
 * appointment's time window. The signature means a forged token is rejected
 * before it ever reaches the database.
 */

function sign(payload) {
  return crypto.createHmac('sha256', config.meetingTokenSecret).update(payload).digest('base64url');
}

export function createMeetingToken(appointmentId) {
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = `${appointmentId}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function parseMeetingToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [appointmentId, nonce, signature] = parts;
  const expected = sign(`${appointmentId}.${nonce}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const id = Number(appointmentId);
  return Number.isInteger(id) && id > 0 ? { appointmentId: id } : null;
}

/**
 * Resolves a token to a live appointment, or returns a reason it was refused.
 * Returns { ok: true, appointment } or { ok: false, reason, message }.
 */
export async function resolveMeetingToken(token) {
  const parsed = parseMeetingToken(token);
  if (!parsed) return { ok: false, reason: 'invalid', message: 'This meeting link is not valid.' };

  const appointment = await get('SELECT * FROM appointments WHERE id = ? AND meeting_token = ?', [
    parsed.appointmentId,
    token,
  ]);
  if (!appointment) return { ok: false, reason: 'invalid', message: 'This meeting link is not valid.' };

  if (['cancelled', 'no_show'].includes(appointment.status)) {
    return { ok: false, reason: 'cancelled', message: 'This appointment was cancelled.' };
  }
  if (appointment.status === 'completed') {
    return { ok: false, reason: 'completed', message: 'This consultation has already been completed.' };
  }

  const now = Date.now();
  const start = new Date(appointment.slot_start).getTime();
  const opensAt = start - config.meetingTokenEarlyMinutes * 60_000;
  const closesAt = start + config.meetingTokenLateMinutes * 60_000;

  if (now < opensAt) {
    return {
      ok: false,
      reason: 'too_early',
      message: `This link opens ${config.meetingTokenEarlyMinutes} minutes before your appointment.`,
      opensAt: new Date(opensAt).toISOString(),
      appointment,
    };
  }
  if (now > closesAt) {
    return { ok: false, reason: 'expired', message: 'This meeting link has expired.' };
  }

  return { ok: true, appointment };
}

/**
 * Builds the patient join URL.
 *
 * `origin` lets an interactive caller pin the link to however the staff member
 * is actually browsing — so a receptionist on https://192.168.1.14:8443 copies
 * a link that works on the same network, rather than one pointing at the
 * server's own idea of localhost. Background jobs pass nothing and fall back to
 * PUBLIC_BASE_URL.
 *
 * The Host header is client-controlled, so `requestOrigin` below refuses to
 * trust it in production; there the configured value always wins.
 */
export function meetingLinkFor(token, origin) {
  const base = (origin || config.publicBaseUrl).replace(/\/$/, '');
  return `${base}/j/${token}`;
}

/**
 * The origin a request came from, but only in development. Returns null in
 * production so meeting links can never be pointed at an attacker's host by a
 * forged Host or Origin header.
 */
export function requestOrigin(req) {
  if (isProduction || !req) return null;

  const origin = req.headers?.origin;
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;

  // The dev proxy forwards the browser's real host and scheme; without them we
  // would see the proxy's own localhost target.
  const host = req.headers?.['x-forwarded-host']?.split(',')[0].trim() || req.headers?.host;
  if (!host) return null;

  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim() || req.protocol || 'http';
  return `${proto}://${host}`;
}

// ------------------------------------------------------------------ JWT

export function issueAccessToken({ subjectType, subjectId, role, name }) {
  return jwt.sign({ sub: String(subjectId), typ: subjectType, role, name }, config.jwtSecret, {
    expiresIn: config.accessTokenTtl,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Doctors get the long sliding window; staff get the shorter one. */
function refreshTtlDays(subjectType) {
  return subjectType === 'doctor' ? config.doctorRefreshTokenTtlDays : config.refreshTokenTtlDays;
}

/**
 * Turns a User-Agent into something a non-technical person can recognise in a
 * "signed in on these devices" list. Deliberately coarse — it is a memory aid
 * for the person revoking, not fingerprinting.
 */
export function describeDevice(userAgent = '') {
  const ua = String(userAgent);
  const os =
    /iPhone|iPad/i.test(ua) ? 'iPhone/iPad'
    : /Android/i.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown device';
  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : 'browser';
  return `${os} · ${browser}`;
}

/**
 * Issues a refresh token.
 *
 * `familyId` threads through every rotation of a single sign-in. Carrying it
 * forward is what makes reuse detection possible below: one login is one
 * family, and only the newest token in a family is live.
 */
export async function issueRefreshToken({ subjectType, subjectId, familyId, userAgent = '', ip = '' }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + refreshTtlDays(subjectType) * 86_400_000).toISOString();
  const family = familyId || crypto.randomBytes(16).toString('hex');

  await run(
    `INSERT INTO refresh_tokens
       (subject_type, subject_id, token_hash, expires_at, family_id, user_agent, ip, device_label, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      subjectType,
      subjectId,
      hashToken(token),
      expiresAt,
      family,
      String(userAgent).slice(0, 300),
      String(ip).slice(0, 60),
      describeDevice(userAgent),
      new Date().toISOString(),
    ],
  );
  return { token, expiresAt, familyId: family };
}

/**
 * Validates and rotates a refresh token.
 *
 * Rotation is single-use, so a token presented twice means two parties hold
 * it — the legitimate device and a thief. We cannot tell which is which, so
 * the whole family is revoked and both are forced to sign in again. That is
 * the trade that lets doctor sessions live for 30 days.
 */
export async function consumeRefreshToken(token) {
  if (!token) return null;
  const row = await get('SELECT * FROM refresh_tokens WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return null;

  if (row.revoked_at) {
    if (row.family_id) {
      await run(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
        [new Date().toISOString(), row.family_id],
      );
      console.warn(
        `[auth] refresh token reuse detected for ${row.subject_type} ${row.subject_id}; revoked the whole session family.`,
      );
    }
    return null;
  }

  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  await run('UPDATE refresh_tokens SET revoked_at = ?, last_used_at = ? WHERE id = ?', [
    new Date().toISOString(),
    new Date().toISOString(),
    row.id,
  ]);
  return row;
}

export async function revokeRefreshTokensFor(subjectType, subjectId) {
  await run('UPDATE refresh_tokens SET revoked_at = ? WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL', [
    new Date().toISOString(),
    subjectType,
    subjectId,
  ]);
}

/** Revokes one device (one family), leaving the person's other devices alone. */
export async function revokeRefreshFamily(subjectType, subjectId, familyId) {
  const result = await run(
    'UPDATE refresh_tokens SET revoked_at = ? WHERE subject_type = ? AND subject_id = ? AND family_id = ? AND revoked_at IS NULL',
    [new Date().toISOString(), subjectType, subjectId, familyId],
  );
  return result;
}

/** One row per signed-in device, newest first. Never exposes a token hash. */
export async function listDevicesFor(subjectType, subjectId) {
  const rows = await all(
    `SELECT family_id, device_label, ip, MAX(last_used_at) AS last_used_at, MAX(expires_at) AS expires_at
       FROM refresh_tokens
      WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL AND family_id IS NOT NULL
      GROUP BY family_id
      ORDER BY last_used_at DESC`,
    [subjectType, subjectId],
  );
  return rows.filter((row) => new Date(row.expires_at).getTime() > Date.now());
}

/** Housekeeping so the table does not grow without bound. */
export async function purgeExpiredRefreshTokens() {
  await run("DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)", [
    new Date().toISOString(),
    new Date(Date.now() - 30 * 86_400_000).toISOString(),
  ]);
}
