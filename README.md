# Surgeons Poly Clinic

Clinic platform: public website with blog, admin/reception console, doctor portal,
booking engine, notification pipeline, and a custom WebRTC video-consultation
system with a reception → doctor handoff.

Built against `Clinic Platform — Requirements & Architecture Document`; section
references below point back at that document.

## Running it

```bash
npm install
npm run dev:full      # Express API on :4000 + Vite on :8443
```

Open <http://localhost:8443>. Vite proxies both `/api` and `/ws` to the API, so
the browser stays same-origin — no CORS, and the httpOnly refresh cookie works.

### Testing over your local network

To try a real consultation between two devices (laptop as receptionist, phone as
patient):

```bash
npm run cert        # once, or whenever your LAN IP changes
npm run dev:lan     # same as dev:full, but over HTTPS
```

HTTPS is required, not cosmetic: browsers only allow camera and microphone
access in a secure context, and a LAN IP is not one — over plain HTTP the call
fails at the permission prompt. The generated certificate is self-signed, so
each device accepts a warning once. See
[docs/deployment.md](docs/deployment.md) for a full step-by-step test run.

| Route | What it is | Auth |
|---|---|---|
| `/` | Public website + booking | none |
| `/doctors/:id` | Doctor profile, services, availability preview | none |
| `/blog`, `/blog/:slug` | Blog listing and articles | none |
| `/admin` | Admin & receptionist console, reception WebRTC room | email + password |
| `/doctor` | Doctor portal, per-doctor WebRTC room | username + password |
| `/j/:token` | Patient video join page | signed link only |
| `/review/:token` | Post-consultation review form | one-time invite link |

In production these are not paths but **subdomains of one domain**, which is
what lets a single sign-in cover all of them (see
[docs/deployment.md](docs/deployment.md)):

| Host | App |
|---|---|
| `thespcofficial.com` | Public website |
| `03084213201.thespcofficial.com` | Admin + reception dashboard |
| `03224894179.thespcofficial.com` | Doctor panel |
| `api.thespcofficial.com` | API + WebSocket |

The app picks which to render from the hostname, and falls back to `/admin` and
`/doctor` paths locally where there are no subdomains. The console and doctor
panel are lazy-loaded chunks, so a patient never downloads the staff code.

### Seeded accounts

Development defaults, created only if the account does not already exist.
Change them via `.env` before deploying anywhere real.

| Role | Credentials |
|---|---|
| Admin | `admin@surgeonspolyclinic.com` / `Admin@12345` |
| Receptionist | `reception@surgeonspolyclinic.com` / `Reception@12345` |
| Doctors | `dr.ayesha` / `dr.zafar`, password `Doctor@12345` |

## Project layout

```
package.json          npm scripts for both halves
vite.config.ts        Vite config — root is frontend/, build output is dist/
tsconfig.json         typechecks frontend/src
dist/                 build output (gitignored)

backend/
  index.js              app bootstrap, wires the adapters together
  config.js             env + dev-only randomised secrets
  data/clinic.db        SQLite database (gitignored, recreated on boot)
  data/uploads/         images uploaded from the dashboard (gitignored)
  db/                   sqlite.js (driver), schema.js (migrations), seed.js
  adapters/             ← the swap points
    notifications.js      transactional outbox; swap for SES + WhatsApp Cloud API
    queue.js              durable jobs table + poller; swap for BullMQ/Redis
    media.js              P2P mesh config; swap for mediasoup/LiveKit SFU
  domain/               availability.js, booking.js, tokens.js, reviews.js,
                        siteContent.js (the editable website text)
  middleware/auth.js    role guards
  realtime/signaling.js WebSocket hub: rooms, roster, handoff, completion
  routes/               auth, public, admin, doctor, video, uploads
  jobs/                 reminder delivery + hold sweeping

frontend/
  index.html
  public/doctors/       doctor photographs, served from the site root
  src/
    App.tsx             route resolution
    lib/                api.ts, auth.ts, useCallSession.ts (signaling + WebRTC),
                        images.ts (browser-side resize + upload), richText.tsx
    components/         VideoStage.tsx, ui.tsx
    routes/
      PublicSite.tsx      home page + booking
      AdminApp.tsx        console shell
      DoctorApp.tsx       doctor portal
      PatientJoin.tsx     patient video page
      admin/              DoctorsPanel, ServicesPanel, WebsitePanel, BlogPanel,
                          ReviewsPanel, SettingsPanel
      public/             SiteChrome, BlogPages, DoctorDetailPage, ReviewPage

scripts/                test suites
docs/                   requirements assets, clinic content, design reference
```

`package.json`, `vite.config.ts`, `tsconfig.json` and `dist/` stay at the repo
root on purpose: the Figma Make harness (`.figma/make/dev` and `deploy`) runs
`pnpm run dev` / `pnpm run build` from the root and deploys the root-level
`dist/`. Everything else is split cleanly into `backend/` and `frontend/`.

## Tests

```bash
npm test              # typecheck + render + both e2e suites
npm run typecheck
npm run test:render   # renders all 12 route/panel components via Vite's SSR pipeline
npm run test:e2e      # booking + video pipeline (needs the API running)
npm run test:admin    # content management + permissions (needs the API running)
```

`test:e2e` books a real appointment into a temporary availability window a few
minutes out, then drives the whole call flow over WebSockets — patient joins
reception, payment verified, handoff, doctor completes, token burnt. `test:admin`
covers doctors (credentials, availability editor, overrides), services, blog
draft/publish, clinic info, staff accounts, and the admin-vs-receptionist
boundary. Both clean up everything they create.

## How a consultation works

1. Patient books. Slots are generated live from the doctor's weekly template
   plus date overrides, minus anything booked or held (Section 3.2). Picking a
   slot places a 10-minute hold so nobody else can take it mid-form.
2. Booking confirms immediately by email **and** WhatsApp. Both are mandatory
   fields; the confirmation deliberately does **not** contain the meeting link
   (Section 5.4).
3. A background job fires 5 minutes before the slot and sends the actual link,
   `…/j/{token}`, on both channels (Section 5.5).
4. The patient clicks it and lands in the **reception room** — one persistent
   room that is live whenever a receptionist is signed in.
5. The receptionist verifies payment on the call, picks a doctor from the
   online list, and hands off.
6. The patient's session is re-pointed to `doctor:{id}`. **Their URL, tab and
   socket never change** — the client renegotiates media against the doctor.
7. The doctor writes notes and completes. The patient's token is burnt and
   their session torn down; the reception and doctor rooms stay live for the
   next patient (Section 8.1).

Appointment status follows the call: `confirmed → in_reception → with_doctor →
completed`, enforced by a transition table so the record can never drift from
the call state.

## Managing the site

Everything the public site shows is editable from the dashboard — nothing is
hardcoded, and changes appear on the next page load without a deploy. That
includes the page text itself: headings, the home-page banner, section
introductions, contact details and SEO fields all live under **Website text**.

The form there is generated from the field definitions in
`backend/domain/siteContent.js`, so making another piece of copy editable is a
one-line change on the server — the dashboard grows the input by itself.

The seeded copy is the clinic's own, from [docs/site-content.xlsx](docs/site-content.xlsx)
and [docs/clinic-content.md](docs/clinic-content.md) — headings, the "Why Patients
Choose Us" block, clinic figures, the emergency banner and the FAQ. One thing from
those files is deliberately left out: the star ratings and review counts
("4.6 · 534 reviews", "99% Patient Satisfaction") came from a third-party directory
listing. Publishing them beside this clinic's own verified, moderated reviews would
show numbers the clinic cannot evidence. The fields exist and are editable if the
clinic decides otherwise.

| Tab | Who | What |
|---|---|---|
| Reception | admin, receptionist | Live reception room, payment verification, handoff |
| Appointments | admin, receptionist | Filter by status/date, resend link, reschedule, cancel, request a review |
| Doctors | admin | Profiles, portal credentials, weekly hours, date overrides |
| Services | admin | Price, duration, category, which doctors offer it |
| Website text | admin | Every heading and paragraph on the public site |
| Questions | admin | The FAQ shown on the website, reorderable |
| Blog | admin | Draft/publish, SEO fields, image upload, preview |
| Reviews | admin, receptionist | Approve, hide or delete patient reviews |
| Notifications | admin, receptionist | Outbox of every message the system queued |
| Settings | admin | Clinic contact details, staff accounts |

Doctor passwords are generated on creation and shown **once** — they are stored
hashed and can only be reset, never recovered.

### Doctors do not sign in repeatedly

A doctor signs in once per device and stays signed in for 30 days, renewed on
every use — so in practice, opening the bookmark shows their room, not a login
form. The session is also re-checked when the tab returns to the foreground, so
a laptop that slept overnight is already signed in before anyone clicks.

The safety valve is revocation rather than expiry: each person sees their signed-in
devices under **Settings → Where you are signed in**, and an admin can sign a
doctor out of one device (or all of them) from the Doctors panel. Refresh tokens
are single-use, so a stolen one is detected on its second use and kills the
whole session.

### The adapter boundaries

The requirements call for Postgres, Redis, BullMQ, and a self-hosted SFU. None
of those run in this environment, so each is behind an adapter with the same
method names its replacement would have. Swapping one is a single-file change;
no domain or route code moves.

| Adapter | Now | Replace with |
|---|---|---|
| `db/sqlite.js` | SQLite + WAL | Postgres (reimplement `run`/`all`/`get`/`transaction`) |
| `adapters/queue.js` | `jobs` table, 15s poll, durable across restarts | BullMQ on Redis |
| `adapters/notifications.js` | outbox table + console log | SES/SendGrid + WhatsApp Cloud API |
| `adapters/media.js` | P2P mesh, STUN only | mediasoup or LiveKit |

Likewise the three "separate domains" are routes of one app. Each entry point is
self-contained, so splitting them onto `admin.` / `doctor.` subdomains later is
a hosting change, not a rewrite.

### Why P2P instead of an SFU

Section 8.2 recommends an SFU because a P2P client must tear down its peer
connection and build a new one on handoff. That renegotiation is real, but it
is invisible to the patient: the signaling server keeps their socket open and
only swaps which peer they negotiate with, so the stated requirement — one
link per patient, rooms that never go down — holds either way. Moving to an SFU
means implementing `media.js` against mediasoup; the signaling protocol does
not change.

## Branding

The logo lives in `frontend/public/brand/` as a WebP wordmark with a PNG
fallback (28 KB served, from a 384 KB original kept at
[docs/assets/logo-original.png](docs/assets/logo-original.png)), plus a square
`mark` cropped to the cross for favicons and tight spaces. The `Logo` component
in `frontend/src/routes/public/SiteChrome.tsx` is the only place that references
those files.

The site palette is taken from the logo: navy `#0a3182`, sky `#30c0fc`. The sky
blue is decorative only — it scores 2.09:1 on white, so `accent` (`#0b63c5`,
5.82:1) carries anything that has to be read. Every pairing the UI uses was
checked against WCAG AA; the lowest is 5.07:1.

Green survives in one place on purpose: verified payment, completed
appointments and a live call. Those are status, not brand.

## Security

- Access tokens (15 min) are held **in memory only**, never localStorage.
  Reloads are covered by an httpOnly, single-use, rotating refresh cookie
  scoped to `/api/auth` and to `.thespcofficial.com`, so one sign-in covers the
  website, the dashboard and the doctor panel without a third-party cookie.
- Refresh tokens rotate on every use. Presenting one that has already been
  rotated means two parties hold it, so the whole session family is revoked.
  This is what makes the 30-day doctor session safe; each person can also see
  and revoke their own devices, and an admin can revoke a doctor's.
- Patient meeting tokens are HMAC-signed and opaque, bound to one appointment,
  valid only from 15 minutes before to 2 hours after the slot, and nulled out
  on completion. Forged tokens are rejected before any DB lookup.
- Role guards on every protected route. Receptionists can run the desk but not
  touch content; doctors' queries are filtered by their own id. Meeting tokens
  and password hashes are stripped from every response.
- Double-booking is prevented by a partial unique index on
  `(doctor_id, slot_start)` where the status is not cancelled/no-show — the
  transaction produces the friendly message, the index is the actual guarantee.
- Login is rate-limited (10 per 15 min) and compares a bcrypt hash even when
  the user does not exist, so a missing account and a wrong password are
  indistinguishable by timing.
- CORS is restricted to `ALLOWED_ORIGINS`; credentials are on, so a permissive
  origin would expose the refresh cookie.
- Blog posts are rendered by building React elements from a small Markdown-like
  subset (`frontend/src/lib/richText.tsx`), never by setting `innerHTML`. There
  is no code path that turns stored content into markup, so stored XSS is
  closed structurally rather than by filtering.
- Reviews can only be written by a patient who completed a consultation and
  followed the one-time link sent afterwards, and are published only once staff
  approve them.
- Uploaded images are identified by their magic bytes, not the filename or the
  declared type; SVG is refused because it executes script. Stored files are
  given generated names and served with `nosniff` and a sandbox CSP.
- State-changing requests carrying an unrecognised `Origin` are refused, and the
  WebSocket upgrade applies the same allowlist.

## Known gaps

These need either infrastructure or a decision from the clinic — they are not
oversights.

- **No TURN server.** STUN alone does not traverse symmetric NAT, so calls may
  fail on some mobile networks. Set `ICE_SERVERS` with a TURN entry.
- **Notifications are logged, not delivered.** Everything the system would send
  is visible in the console's Notifications tab. Wire a provider into
  `adapters/notifications.js`.
- **Single reception room.** Open item 4 in the requirements (multiple
  concurrent receptionists) is unresolved; every patient lands in one shared
  reception room.
- **No online payment.** Per open item 3, payment is verified manually by the
  receptionist on the call (`payment_status`). No gateway is integrated.
- **The video client is unverified in a real browser.** The signaling protocol
  is covered end-to-end and every component renders, but getUserMedia and actual
  WebRTC negotiation need a browser with a camera.
