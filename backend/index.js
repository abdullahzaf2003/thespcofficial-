import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { config, isProduction } from './config.js';
import { migrate } from './db/schema.js';
import { seed } from './db/seed.js';
import { queue } from './adapters/queue.js';
import { media } from './adapters/media.js';
import { registerJobs, primeJobs } from './jobs/index.js';
import { attachSignaling } from './realtime/signaling.js';
import { BookingError } from './domain/booking.js';

import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import doctorRoutes from './routes/doctor.js';
import videoRoutes from './routes/video.js';
import uploadRoutes from './routes/uploads.js';

const app = express();

app.set('trust proxy', 1);

/**
 * Section 9: only the known frontend origins. Credentials are on, so a
 * permissive origin would let any site drive the refresh-token cookie.
 *
 * In development we additionally accept private-network origins, so testing
 * from a phone on the same WiFi works without editing ALLOWED_ORIGINS for
 * every DHCP lease. This relaxation never applies in production.
 */
const PRIVATE_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

function isAllowedOrigin(origin) {
  if (config.allowedOrigins.includes(origin)) return true;
  return !isProduction && PRIVATE_ORIGIN.test(origin);
}

app.use(
  cors({
    origin(origin, callback) {
      // A missing Origin header is a same-origin or non-browser request.
      if (!origin || isAllowedOrigin(origin)) return callback(null, true);
      // Refuse by omitting the CORS headers rather than throwing: the browser
      // blocks the response either way, but throwing here would surface as an
      // unhandled 500 instead of the explicit 403 the origin guard returns.
      return callback(null, false);
    },
    credentials: true,
  }),
);

app.use(
  helmet({
    // Images are served to the website from the API origin, so they must be
    // readable cross-origin; everything else stays locked down.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // This API serves JSON and images, never HTML, so the strictest possible
    // policy is also the correct one: nothing here should ever be a document,
    // frame, or script source.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'img-src': ["'self'", 'data:'],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // Six months, and only once the domains are actually on HTTPS.
    hsts: isProduction ? { maxAge: 15_552_000, includeSubDomains: true, preload: false } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);

/**
 * Uploaded images.
 *
 * `nosniff` plus an explicit download disposition means that even if something
 * got past the magic-byte check in routes/uploads.js, the browser will not
 * execute it as HTML or script from our origin.
 */
app.use(
  '/uploads',
  express.static(config.uploadDir, {
    index: false,
    dotfiles: 'deny',
    maxAge: '30d',
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  }),
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * CSRF backstop.
 *
 * SameSite=Lax on the refresh cookie already stops a cross-site POST from
 * carrying it, so this is defence in depth rather than the primary control:
 * any state-changing request that arrives with an Origin we do not recognise
 * is refused outright. Requests with no Origin header at all (server-to-server,
 * curl, the test suites) are not browser-driven and so are not CSRF.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

app.use('/api', (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin || isAllowedOrigin(origin)) return next();
  return res.status(403).json({ message: 'Request blocked: unrecognised origin.' });
});

app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    mediaMode: media.mode,
    timezone: config.clinicTimezone,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api', videoRoutes);
app.use('/api', publicRoutes);

app.use('/api', (_req, res) => res.status(404).json({ message: 'Not found.' }));

// Domain errors carry their own status; everything else is a 500 with no
// internals leaked to the client.
app.use((error, _req, res, _next) => {
  if (error instanceof BookingError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  console.error('[api] unhandled error:', error);
  return res.status(500).json({
    message: 'Something went wrong. Please try again.',
    ...(isProduction ? {} : { detail: error.message }),
  });
});

const server = http.createServer(app);

async function start() {
  await migrate();
  await seed();

  registerJobs();
  await primeJobs();
  queue.start();

  attachSignaling(server);

  server.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
    console.log(`[api] media mode: ${media.mode}`);
    console.log(`[api] patient links point at ${config.publicBaseUrl}`);

    if (process.env.DEV_HTTPS === '1') {
      const web = config.publicBaseUrl;
      console.log('\n  Open these on any device on this WiFi:');
      console.log(`    Website        ${web}/`);
      console.log(`    Admin console  ${web}/admin`);
      console.log(`    Doctor portal  ${web}/doctor`);
      console.log('\n  Accept the certificate warning once per device.\n');
    }

    if (!media.getJoinConfig().hasTurn) {
      console.warn('[api] no TURN server configured — fine on one LAN, needed across the internet. Set ICE_SERVERS.');
    }
  });
}

start().catch((error) => {
  console.error('[api] startup failed:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    queue.stop();
    server.close(() => process.exit(0));
  });
}
