# Testing and deployment

Covers local network testing, what Redis is actually for, and the Render +
Vercel deployment.

---

## 1. Testing over your local network

Use this to try a real consultation between two devices — your laptop as the
receptionist, your phone as the patient.

```bash
npm run cert        # once, or whenever your LAN IP changes
npm run dev:lan     # starts the API and the web server together
```

The startup banner prints the exact URLs. On this machine they are:

| | URL |
|---|---|
| Website | `https://192.168.1.14:8443/` |
| Admin / reception | `https://192.168.1.14:8443/admin` |
| Doctor portal | `https://192.168.1.14:8443/doctor` |

### Why HTTPS is not optional here

Browsers only allow `getUserMedia` — camera and microphone — in a **secure
context**. `localhost` is exempt, but a LAN address like `http://192.168.1.14`
is not. Over plain HTTP the call connects and then silently fails at permission
time, which looks like a broken app. `npm run dev:lan` serves HTTPS with a
self-signed certificate that covers both `localhost` and your LAN IP.

Each device shows a certificate warning on its first visit. Accept it once:

- **Chrome / Edge / Android:** "Advanced" → "Proceed to 192.168.1.14 (unsafe)"
- **Safari / iOS:** "Show Details" → "visit this website" → confirm
- **Firefox:** "Advanced" → "Accept the Risk and Continue"

If your router hands out a new IP, re-run `npm run cert` and restart.

### A full test run

1. Laptop: open `/admin`, sign in as admin, allow camera. The reception room is
   now live.
2. Laptop (second window or another machine): open `/doctor`, sign in as
   `dr.ayesha` / `Doctor@12345`, allow camera. Reception should now show that
   doctor under "Doctors online".
3. Laptop: open `/`, book an appointment for a slot a few minutes away. Use a
   real email and WhatsApp number in the form — they are not actually sent yet,
   so anything valid works.
4. Laptop: in `/admin` → **Notifications**, wait for the `meeting_link` message
   (it fires 5 minutes before the slot; the queue polls every 15 seconds). Copy
   the `https://192.168.1.14:8443/j/…` link out of it.

   To skip the wait, open **Appointments** and press **Resend link** — that
   sends it immediately.
5. Phone: open that link. Accept the certificate warning, allow camera. You
   land in the reception room and the receptionist sees you.
6. Laptop `/admin`: press **Verify payment**, choose the doctor, press
   **Hand off**.
7. Phone: the video swaps to the doctor without the URL changing.
8. Doctor window: write notes, press **Complete consultation**. The phone shows
   the "consultation complete" screen and the link stops working.

TURN is not needed for this — both devices are on one LAN, so the browsers
connect directly.

---

## 2. What Redis is for

**Short answer: you do not need Redis to launch.** A single API instance runs
the whole system today — the job queue is a durable table, rate limiting is
in-process, and the signaling hub is in-memory. Redis becomes necessary the
moment you run **more than one API instance**.

### Why a second instance breaks without it

| Concern | Today | Breaks at 2+ instances because |
|---|---|---|
| **WebRTC signaling** | `SignalingHub` holds `peers` and `rooms` as in-memory Maps (`backend/realtime/signaling.js`) | A patient on instance A and the receptionist on instance B are in different process memory. They never see each other and the handoff silently does nothing. **This is the hard blocker.** |
| **Reminder jobs** | `jobs` table, polled every 15s, claimed with a conditional `UPDATE` | The claim mostly holds, but two pollers duplicate work and the timing drifts. BullMQ gives real atomic claiming, retries and backoff. |
| **Rate limiting** | `express-rate-limit` in-memory | Each instance keeps its own counter, so an attacker gets N× the allowed attempts. |
| **Slot holds** | SQLite row + unique index | Fine as-is. Moves to Postgres with the rest of the data; does not need Redis. |

### When you do add it

- **Redis 6.2 or newer** (BullMQ needs 5.0+, and 6.2+ for all features). Redis 7 is fine.
- **`maxmemory-policy` must be `noeviction`.** This one matters: with any
  eviction policy, Redis may drop keys under pressure and BullMQ will silently
  lose queued reminders.
- **Memory: 50 MB is generous** for this workload — a clinic with a few hundred
  appointments a day. Start at the smallest paid tier.
- **TLS and a password** in production. Render's managed instance and Redis
  Cloud both give you a `rediss://` URL.
- **Hosting:** Render Key Value sits in the same network as your service and is
  the simplest choice. Redis Cloud's free 30 MB tier also works. Be careful with
  Upstash on a per-request plan — BullMQ uses blocking reads that burn requests
  quickly; their fixed-price tier is fine.

You would then need three code changes, all behind existing adapter boundaries:

1. `backend/adapters/queue.js` → BullMQ. Keep `register` / `schedule` / `cancel`.
2. `backend/realtime/signaling.js` → add a Redis pub/sub layer so `broadcast`
   and the room registry span instances.
3. `backend/routes/auth.js` and `index.js` → `rate-limit-redis` store.

**Recommendation: launch on one instance with no Redis.** Add it when real
traffic justifies scaling, or when you want zero-downtime deploys (those run two
instances briefly, which trips the signaling problem above).

---

## 3. Render + Vercel

### What goes where

**The API cannot go on Vercel or any serverless host.** Serverless functions
cannot hold open WebSocket connections, and the whole video system depends on
long-lived sockets for the reception and doctor rooms. The API needs a
persistent Node process with a persistent disk.

Recommended, ~$7/month all in:

| Piece | Host | Why |
|---|---|---|
| DNS | **Cloudflare** | Free, and you want it anyway for the TURN server below |
| 3 frontends | **Cloudflare Pages** | Free tier permits commercial use, global CDN, free TLS |
| API + WebSocket | **Render**, Singapore region, **Starter $7/mo** | Persistent process, holds sockets, closest region to Lahore |
| Database + uploads | **Render Disk**, 1 GB (~$0.25/mo) | See the warning below |
| TURN | **Cloudflare Calls** or **Metered.ca** | Both have a free tier; TURN is mandatory, see below |

Two things to be careful about:

**Do not use Render's free tier.** It spins the service down after ~15 minutes
of inactivity. A cold start in the middle of a booked consultation is not a
trade-off worth $7, and a clinic's traffic is exactly the bursty pattern that
triggers it.

**Check the licence on whichever frontend host you pick.** Vercel's Hobby tier
is for personal, non-commercial projects — a clinic is a commercial use, which
would put you on Pro at $20/month per member. Cloudflare Pages and Netlify both
permit commercial use on their free tiers, which is why Pages is recommended
above. Vercel works perfectly well technically; it is the billing that differs.

### Alternatives considered

| Option | Verdict |
|---|---|
| **Railway** | Fine technically, volumes work. No region near Pakistan, so signaling latency is worse |
| **Fly.io** | Has Singapore, good WebSocket support, slightly cheaper. More operational complexity — reasonable if you are comfortable with a CLI and `fly.toml` |
| **A VPS** (Hetzner, Contabo) | ~€4/month and full control, but you then own TLS renewal, OS patching, backups and monitoring. For a clinic with no sysadmin, that is a liability, not a saving |
| **DigitalOcean App Platform** | No persistent disk, which forces the Postgres migration now rather than later |

### SQLite will lose your data on Render

Render's filesystem is ephemeral — it is wiped on every deploy and restart. The
database lives at `backend/data/clinic.db` and uploaded images at
`backend/data/uploads/`, so on Render you would lose every appointment **and
every photo the clinic uploaded** on each deploy.

Point both `DB_PATH` and `UPLOAD_DIR` at the mounted disk. Forgetting
`UPLOAD_DIR` is the easier mistake to make, because nothing breaks at deploy
time — the images simply disappear later.

Two options:

1. **Attach a Render Disk** (persistent volume) and point `DB_PATH` at it.
   Cheapest, keeps SQLite, but pins you to a single instance forever — a disk
   cannot be shared.
2. **Move to Postgres.** Reimplement `backend/db/sqlite.js` against `pg`,
   keeping `run` / `all` / `get` / `transaction`. Nothing above that file
   changes. This is the path if you ever want more than one instance.

Given you are starting with one instance, option 1 is a reasonable launch
choice and option 2 is the upgrade.

### DNS: one domain, three subdomains

The three properties are subdomains of **one** registrable domain. This is the
decision everything else rests on — see "Why subdomains" below.

| Record | Type | Points at | Serves |
|---|---|---|---|
| `thespcofficial.com` | A / ALIAS | Pages (or Vercel) | Public website |
| `www` | CNAME | Pages | Redirect to the apex |
| `03084213201` | CNAME | Pages | Admin + reception dashboard |
| `03224894179` | CNAME | Pages | Doctor panel |
| `api` | CNAME | **Render** | API + WebSocket |

The two numeric subdomains are valid hostnames (a DNS label may be all digits;
only a *top-level* domain may not). They are hard to guess, which is a mild
extra hurdle for a passer-by — but treat it as a curtain, not a lock. Every
panel is still protected by authentication and role checks, and must stay that
way.

Because they are also hard to *type*, the doctor panel is built to be signed
into once and bookmarked: sessions last 30 days and slide forward on every use,
so a doctor sees their room, not a login form. If you later want something
memorable, add a `doctors.thespcofficial.com` CNAME to the same target — the
app matches on `DOCTOR_HOST`, so set that variable to whichever name you want
to be canonical.

### Why subdomains (and why the API must be one too)

Staff sign-in uses an httpOnly refresh cookie. Cookies are scoped by
*registrable domain*, not by host:

- **Three separate domains** → the cookie is **third-party** on two of them.
  Safari blocks third-party cookies outright and Chrome is phasing them out, so
  staff would appear to be randomly signed out every 15 minutes, with no error
  anywhere to explain it.
- **One domain with subdomains** → the cookie is set on `.thespcofficial.com`
  and is **first-party** on all of them. One sign-in, no browser to fight.

This is why `api.thespcofficial.com` matters. If the API stays on its default
`*.onrender.com` hostname, it is a different registrable domain and the cookie
becomes third-party again — reintroducing exactly the bug the subdomain layout
removes. **Attach the custom domain to the Render service before launch.**

`SameSite=Lax` is kept for the same reason it is safe: subdomains of one
registrable domain are same-site, so the cookie rides legitimate requests while
cross-site POSTs get nothing. The API additionally rejects any state-changing
request carrying an unrecognised `Origin`.

### Building each frontend

All three properties are one React app, and the app picks which to render from
`window.location.hostname`. The admin console and doctor panel are lazy-loaded
chunks, so a patient on the public website never downloads the staff code.

Create three projects from the same repository — one per domain. On Cloudflare
Pages the build command is `npm run build` and the output directory is `dist`,
with a single SPA fallback rule. On Vercel the equivalent is a shared
`vercel.json`:

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

The only difference between the projects is the domain attached to each, plus
the build-time variables below. No rewrite to `/admin` or `/doctor` is needed —
on a staff subdomain, every path renders that panel.

### Frontend → API wiring

In development, Vite proxies `/api` and `/ws` so everything is same-origin. In
production the frontends are on Vercel and the API is on Render, so set these
on **each** frontend project (they are read at build time, not runtime):

```
VITE_API_BASE=https://api.thespcofficial.com
VITE_ADMIN_HOST=03084213201.thespcofficial.com
VITE_DOCTOR_HOST=03224894179.thespcofficial.com
```

`frontend/src/lib/api.ts` derives the WebSocket URL from `VITE_API_BASE`, so
`wss://api.thespcofficial.com/ws` needs no separate setting.

### Environment variables on Render

```
NODE_ENV=production
API_PORT=4000

JWT_SECRET=<openssl rand -hex 32>
MEETING_TOKEN_SECRET=<openssl rand -hex 32>

ADMIN_EMAIL=...
ADMIN_PASSWORD=<strong, changed after first login>
RECEPTION_EMAIL=...
RECEPTION_PASSWORD=<strong>
DOCTOR_PASSWORD=<strong>

ROOT_DOMAIN=thespcofficial.com
ADMIN_HOST=03084213201.thespcofficial.com
DOCTOR_HOST=03224894179.thespcofficial.com
API_HOST=api.thespcofficial.com

# The leading dot is what makes one sign-in cover every subdomain.
COOKIE_DOMAIN=.thespcofficial.com

PUBLIC_BASE_URL=https://thespcofficial.com
# ALLOWED_ORIGINS is derived from ROOT_DOMAIN; set it only to add extra origins.

REFRESH_TOKEN_TTL_DAYS=7
DOCTOR_REFRESH_TOKEN_TTL_DAYS=30

CLINIC_TIMEZONE=Asia/Karachi
DB_PATH=/var/data/clinic.db        # Render Disk mount
UPLOAD_DIR=/var/data/uploads       # MUST also be on the disk — see below

ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:<host>:3478"],"username":"<user>","credential":"<pass>"}]
```

`NODE_ENV=production` makes the app **refuse to boot** without the secrets
above — that is deliberate, so a missing secret fails loudly at deploy instead
of quietly running on a randomised one.

### TURN becomes mandatory in production

On your LAN, browsers connect directly. Across the internet, roughly 10–20% of
users sit behind symmetric NAT (common on mobile networks) where STUN alone
fails and the call connects but shows black video. You need a TURN server.

Cheapest reliable options: **Twilio Network Traversal Service** (pay per GB,
nothing to run), **Metered.ca** (has a free tier), or self-hosted **coturn** on
a small VPS. Put the credentials in `ICE_SERVERS`.

---

## 4. WhatsApp Cloud API

You are handling the Meta side. The code side is one function.

`backend/adapters/notifications.js` exports an `OutboxNotificationAdapter` that
takes an optional `deliver` callback. Every message is already persisted to the
`notifications` table with its channel, recipient and body — today `deliver` is
unset, so messages are logged instead of sent.

To go live, construct the adapter with a `deliver` that branches on channel:

```js
export const notifier = new OutboxNotificationAdapter({
  async deliver({ channel, recipient, subject, body }) {
    if (channel === 'whatsapp') {
      const response = await fetch(
        `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: recipient,              // already normalised to E.164 digits
            type: 'text',
            text: { body },
          }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      return;
    }
    // email: SES / SendGrid / Resend
  },
});
```

Throwing marks the row `failed` with the error and, for the reminder job,
triggers a retry. The outbox tab in the admin console shows exactly what was
attempted.

**Two things to know about WhatsApp Cloud API:**

- Free-form text only works inside a 24-hour window after the patient messages
  you first. Since the clinic initiates contact, **the booking confirmation and
  meeting link must be approved message templates**, not the plain text above.
  Submit two templates in Meta Business Manager — one for the confirmation, one
  carrying the join link — and send with `type: 'template'`.
- Numbers are stored as E.164 digits without `+` (`923001234567`), which is the
  format the Cloud API expects.

---

## Resolved: cross-domain staff auth

This section previously described a blocker. It is fixed — kept here because
the reasoning explains why the DNS layout is the way it is, and why it should
not be "simplified" later.

**The problem.** The original plan put the three properties on three separate
registrable domains. The refresh token is an `httpOnly` cookie, and across
unrelated domains the browser treats it as a **third-party cookie**: Safari
blocks those outright, Firefox partitions them, Chrome is phasing them out.
Staff would have been signed out every 15 minutes, with nothing in any log to
explain it. It is not a CORS setting — `SameSite=None; Secure` gets blocked
too.

**The fix.** Move the properties onto subdomains of one registrable domain and
scope the cookie to `.thespcofficial.com`. It is then first-party everywhere,
and the problem does not exist rather than being mitigated.

The alternative — returning the refresh token in the response body and keeping
it in `sessionStorage` — was rejected. It would have put a long-lived
credential inside reach of any XSS bug on the dashboard, which is a worse trade
than the one being solved, especially with doctor sessions lasting 30 days. The
token is never sent to JavaScript; `POST /api/auth/refresh` reads the cookie
and nothing else.

**What still has to be true in production:**

- `api.thespcofficial.com` is a custom domain on the Render service. On the
  default `*.onrender.com` hostname the cookie is third-party again.
- `COOKIE_DOMAIN=.thespcofficial.com` is set on the API.
- All four hosts are HTTPS — the cookie is `Secure` in production.

Patient meeting and review links are unaffected either way: they carry a signed
token in the URL and use no cookies at all.

### Session lifetimes

| Who | Without a password | Behaviour |
|---|---|---|
| Admin / reception | 7 days | Sliding; the console can edit the site and create accounts, so it is kept shorter |
| Doctors | 30 days | Sliding; opening the panel at all renews it |

Both rotate on every use and are single-use. Presenting an already-rotated
token means two parties hold it, so the entire session family is revoked and
everyone signs in again — this is what makes a 30-day window acceptable.

Each person can see their signed-in devices under **Settings → Where you are
signed in**, and an admin can revoke a doctor's device from the Doctors panel.
That is the answer to a lost phone, rather than a short expiry that would
punish every doctor daily.
