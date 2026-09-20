import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** First non-internal IPv4 address, used to build LAN-reachable dev links. */
export function lanAddress() {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
  return addresses[0] || 'localhost';
}

/**
 * Where patients reach the app. Meeting links are built from this, so in LAN
 * testing it has to be the address a phone can actually open — not localhost.
 */
function resolvePublicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;

  const port = process.env.WEB_PORT || '8443';
  if (process.env.DEV_HTTPS === '1') return `https://${lanAddress()}:${port}`;
  return `http://localhost:${port}`;
}

/**
 * The clinic runs on one registrable domain with the two staff panels on
 * subdomains of it:
 *
 *   thespcofficial.com               public website
 *   03084213201.thespcofficial.com   admin + reception dashboard
 *   03224894179.thespcofficial.com   doctor panel
 *   api.thespcofficial.com           this API
 *
 * That shape is deliberate. Because all four are subdomains of one root, the
 * refresh cookie below is set on `.thespcofficial.com` and is a FIRST-party
 * cookie everywhere — which is the whole reason staff sessions survive in
 * Safari. Hosting the API on a foreign host (say `*.onrender.com`) would turn
 * it back into a third-party cookie and silently break sign-in.
 */
const rootDomain = (process.env.ROOT_DOMAIN || 'thespcofficial.com').trim().toLowerCase();

const host = (envName, prefix) => (process.env[envName] || (prefix ? `${prefix}.${rootDomain}` : rootDomain)).trim().toLowerCase();

const adminHost = host('ADMIN_HOST', '03084213201');
const doctorHost = host('DOCTOR_HOST', '03224894179');
const publicHost = host('PUBLIC_HOST', null);
const apiHost = host('API_HOST', 'api');

function requiredInProduction(name, fallback) {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be set in production.`);
  }
  return fallback;
}

// Dev-only secrets are randomised per boot so a leaked default can never sign a
// token that another install would accept. Set them in .env to keep sessions
// alive across restarts.
const devSecret = () => crypto.randomBytes(32).toString('hex');

export const config = {
  port: Number(process.env.API_PORT || process.env.PORT || 4000),
  dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'clinic.db'),

  jwtSecret: requiredInProduction('JWT_SECRET', devSecret()),
  meetingTokenSecret: requiredInProduction('MEETING_TOKEN_SECRET', devSecret()),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',

  // Refresh-token lifetime, per kind of user. Doctors get a long sliding
  // window on purpose: the clinic's doctors are not technical, open the panel
  // irregularly, and being bounced to a password prompt mid-clinic is the
  // failure mode we care most about avoiding. Every refresh issues a fresh
  // 30-day token, so a doctor who opens the panel at all is never signed out;
  // only a device untouched for a full 30 days has to sign in again. Staff on
  // the dashboard keep the shorter window because that console can edit the
  // public site and create accounts.
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7),
  doctorRefreshTokenTtlDays: Number(process.env.DOCTOR_REFRESH_TOKEN_TTL_DAYS || 30),

  // Seed credentials. Only applied when the user row does not already exist.
  seedAdminEmail: process.env.ADMIN_EMAIL || 'admin@surgeonspolyclinic.com',
  seedAdminPassword: requiredInProduction('ADMIN_PASSWORD', 'Admin@12345'),
  seedReceptionEmail: process.env.RECEPTION_EMAIL || 'reception@surgeonspolyclinic.com',
  seedReceptionPassword: requiredInProduction('RECEPTION_PASSWORD', 'Reception@12345'),
  seedDoctorPassword: requiredInProduction('DOCTOR_PASSWORD', 'Doctor@12345'),

  // Public origin used to build patient meeting links.
  publicBaseUrl: resolvePublicBaseUrl(),

  rootDomain,
  adminHost,
  doctorHost,
  publicHost,
  apiHost,

  /**
   * Domain the refresh cookie is scoped to. A leading dot means "this domain
   * and every subdomain", which is what lets one sign-in cover the dashboard
   * and the doctor panel. Left undefined in development so the cookie is
   * host-only on localhost.
   */
  cookieDomain: process.env.COOKIE_DOMAIN || (process.env.NODE_ENV === 'production' ? `.${rootDomain}` : undefined),

  // The production origins. In development these are ignored in favour of the
  // private-network rule in index.js.
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ||
    [
      `https://${publicHost}`,
      `https://www.${publicHost}`,
      `https://${adminHost}`,
      `https://${doctorHost}`,
      'http://localhost:8443',
      'http://localhost:4000',
    ].join(',')
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  clinicTimezone: process.env.CLINIC_TIMEZONE || 'Asia/Karachi',

  // Minutes before slot_start that the meeting link is delivered (Section 10).
  reminderLeadMinutes: Number(process.env.REMINDER_LEAD_MINUTES || 5),
  // How long a patient may hold a slot while filling in the booking form.
  slotHoldMinutes: Number(process.env.SLOT_HOLD_MINUTES || 10),
  // Meeting tokens stay valid from this long before slot_start until this long after.
  meetingTokenEarlyMinutes: Number(process.env.MEETING_TOKEN_EARLY_MINUTES || 15),
  meetingTokenLateMinutes: Number(process.env.MEETING_TOKEN_LATE_MINUTES || 120),

  // Image uploads from the dashboard. Files are resized in the browser before
  // they are sent, so this ceiling only ever catches something pathological.
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 3_000_000),

  iceServers: process.env.ICE_SERVERS
    ? JSON.parse(process.env.ICE_SERVERS)
    : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

export const isProduction = process.env.NODE_ENV === 'production';
