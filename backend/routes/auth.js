import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { get } from '../db/sqlite.js';
import { config, isProduction } from '../config.js';
import {
  issueAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshTokensFor,
  revokeRefreshFamily,
  listDevicesFor,
} from '../domain/tokens.js';
import { requireAuth, readCookie } from '../middleware/auth.js';

const router = Router();

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Brute force is about *failed* attempts, so successful sign-ins are not
// counted. A legitimate user signing in repeatedly (or a test suite) is never
// throttled, while an attacker guessing passwords still hits the wall after 10.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many failed sign-in attempts. Please wait a few minutes.' },
});

const REFRESH_COOKIE = 'clinic_refresh';

/**
 * The refresh cookie.
 *
 * `domain` is the load-bearing part. Scoped to `.thespcofficial.com` it is a
 * first-party cookie on the website, the dashboard and the doctor panel alike,
 * so one sign-in covers all three and Safari's third-party cookie blocking
 * never comes into it. SameSite=Lax is safe for the same reason: subdomains of
 * one registrable domain are same-site, so the cookie rides legitimate
 * requests but not cross-site ones — which is also our CSRF defence.
 */
function setRefreshCookie(res, token, expiresAt) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    expires: new Date(expiresAt),
    path: '/api/auth',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    path: '/api/auth',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  });
}

const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';

async function issueSession(res, req, { subjectType, subjectId, role, name }, familyId) {
  const accessToken = issueAccessToken({ subjectType, subjectId, role, name });
  const refresh = await issueRefreshToken({
    subjectType,
    subjectId,
    familyId,
    userAgent: req.headers['user-agent'] || '',
    ip: clientIp(req),
  });
  setRefreshCookie(res, refresh.token, refresh.expiresAt);
  return {
    accessToken,
    expiresIn: config.accessTokenTtl,
    // The client shows "you will stay signed in until ..." so a doctor knows
    // the session is durable and stops expecting a password prompt.
    sessionExpiresAt: refresh.expiresAt,
  };
}

// Staff: admin + receptionist.
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

  const user = await get('SELECT * FROM admin_users WHERE email = ?', [String(email).trim().toLowerCase()]);
  // Compare unconditionally so a missing user and a wrong password take the
  // same time and cannot be told apart.
  const fallbackHash = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = bcrypt.compareSync(String(password), user?.password_hash || fallbackHash);

  if (!user || !ok || user.status === 'inactive') {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  const session = await issueSession(res, req, {
    subjectType: 'staff',
    subjectId: user.id,
    role: user.role || 'admin',
    name: user.name || user.email,
  });

  return res.json({
    ...session,
    user: { id: user.id, email: user.email, name: user.name, role: user.role || 'admin' },
  });
});

// Doctors sign in with credentials issued by the admin (Section 7).
router.post('/doctor-login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });

  const doctor = await get('SELECT * FROM doctors WHERE username = ?', [String(username).trim().toLowerCase()]);
  const fallbackHash = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = bcrypt.compareSync(String(password), doctor?.password_hash || fallbackHash);

  if (!doctor || !ok || doctor.status === 'inactive') {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  const session = await issueSession(res, req, {
    subjectType: 'doctor',
    subjectId: doctor.id,
    role: 'doctor',
    name: doctor.name,
  });

  return res.json({
    ...session,
    user: {
      id: doctor.id,
      name: doctor.name,
      username: doctor.username,
      role: 'doctor',
      specialty: doctor.specialty,
      socket_room_id: doctor.socket_room_id,
    },
  });
});

router.post('/refresh', async (req, res) => {
  // Cookie only. The token is never handed to JavaScript, so an XSS bug on the
  // dashboard cannot walk away with a 30-day doctor session.
  const token = readCookie(req, REFRESH_COOKIE);
  const row = await consumeRefreshToken(token);
  if (!row) {
    clearRefreshCookie(res);
    return res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }

  let identity;
  if (row.subject_type === 'doctor') {
    const doctor = await get('SELECT * FROM doctors WHERE id = ?', [row.subject_id]);
    if (!doctor || doctor.status === 'inactive') {
      clearRefreshCookie(res);
      return res.status(401).json({ message: 'Account is inactive.' });
    }
    identity = { subjectType: 'doctor', subjectId: doctor.id, role: 'doctor', name: doctor.name };
  } else {
    const user = await get('SELECT * FROM admin_users WHERE id = ?', [row.subject_id]);
    if (!user || user.status === 'inactive') {
      clearRefreshCookie(res);
      return res.status(401).json({ message: 'Account is inactive.' });
    }
    identity = {
      subjectType: 'staff',
      subjectId: user.id,
      role: user.role || 'admin',
      name: user.name || user.email,
    };
  }

  // Carrying the family forward is what makes the window *sliding*: each use
  // mints a fresh full-length token, so an active doctor never reaches the
  // 30-day edge at all.
  const session = await issueSession(res, req, identity, row.family_id);
  return res.json({
    ...session,
    user: { id: identity.subjectId, role: identity.role, name: identity.name },
  });
});

/**
 * Signs out this device only. A doctor signing out on the clinic PC keeps
 * their own phone signed in, which is what they expect.
 */
router.post('/logout', requireAuth('admin', 'receptionist', 'doctor'), async (req, res) => {
  const token = readCookie(req, REFRESH_COOKIE);
  const row = token ? await get('SELECT * FROM refresh_tokens WHERE token_hash = ?', [sha256(token)]) : null;

  if (row?.family_id) {
    await revokeRefreshFamily(req.auth.subjectType, req.auth.id, row.family_id);
  } else {
    await revokeRefreshTokensFor(req.auth.subjectType, req.auth.id);
  }

  clearRefreshCookie(res);
  return res.json({ message: 'Signed out.' });
});

/** Signs out every device — the button to press if a phone is lost. */
router.post('/logout-all', requireAuth('admin', 'receptionist', 'doctor'), async (req, res) => {
  await revokeRefreshTokensFor(req.auth.subjectType, req.auth.id);
  clearRefreshCookie(res);
  return res.json({ message: 'Signed out on all devices.' });
});

/** The signed-in device list a person sees for their own account. */
router.get('/devices', requireAuth('admin', 'receptionist', 'doctor'), async (req, res) => {
  const current = readCookie(req, REFRESH_COOKIE);
  const row = current ? await get('SELECT family_id FROM refresh_tokens WHERE token_hash = ?', [sha256(current)]) : null;
  const devices = await listDevicesFor(req.auth.subjectType, req.auth.id);

  res.json(
    devices.map((device) => ({
      id: device.family_id,
      label: device.device_label || 'Unknown device',
      last_used_at: device.last_used_at,
      expires_at: device.expires_at,
      current: Boolean(row && row.family_id === device.family_id),
    })),
  );
});

router.delete('/devices/:familyId', requireAuth('admin', 'receptionist', 'doctor'), async (req, res) => {
  await revokeRefreshFamily(req.auth.subjectType, req.auth.id, String(req.params.familyId));
  res.json({ message: 'That device has been signed out.' });
});

router.get('/me', requireAuth('admin', 'receptionist', 'doctor'), (req, res) => {
  res.json({ user: req.auth });
});

export default router;
