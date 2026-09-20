# Deploying Surgeons Poly Clinic

Written for the person doing the deployment, start to finish. Follow it in
order — later steps depend on earlier ones.

You need three accounts, which you already have: **Namecheap** (the domain),
**Cloudflare** (DNS + the three websites), **Railway** (the API).

**Time:** about an hour, plus waiting for DNS.
**Cost:** $5/month (Railway) + ~$0.15 (storage). Cloudflare is free.

---

## What you are building

| Address | What it is | Hosted on |
|---|---|---|
| `thespcofficial.com` | Public website | Cloudflare Pages |
| `03084213201.thespcofficial.com` | Admin + reception dashboard | Cloudflare Pages |
| `03224894179.thespcofficial.com` | Doctor panel | Cloudflare Pages |
| `api.thespcofficial.com` | API + video signalling | Railway |

All four are subdomains of one domain. **This is not a style choice.** Staff
sign-in uses a cookie, and browsers only trust that cookie across sites that
share one root domain. If the API is left on Railway's own
`*.up.railway.app` address, Safari will silently sign staff out every 15
minutes and nothing in any log will explain why. Step 4 is where this is won
or lost.

---

## Step 1 — Point Namecheap at Cloudflare

Cloudflare needs to run DNS for the domain.

1. In **Cloudflare** → *Add a site* → enter `thespcofficial.com` → choose the
   **Free** plan.
2. Cloudflare scans, then shows you **two nameservers**, something like
   `xxx.ns.cloudflare.com`. Copy both.
3. In **Namecheap** → *Domain List* → *Manage* next to `thespcofficial.com`.
4. Find **Nameservers**, change the dropdown from *Namecheap BasicDNS* to
   **Custom DNS**.
5. Paste the two Cloudflare nameservers. Save (the little green tick).

Now wait. This usually takes 10–30 minutes, but can take up to 24 hours.
Cloudflare emails you when the domain is active. **Do not continue until it
says Active** — the later steps will fail confusingly if DNS is not ready.

---

## Step 2 — Put the code on GitHub

If `git push` has already been done, skip this.

```bash
git remote -v          # should show the thespcofficial- repo
git push -u origin main
```

---

## Step 3 — Deploy the API to Railway

1. **Railway** → *New Project* → *Deploy from GitHub repo* → pick
   `thespcofficial-`. Authorise GitHub if asked.
2. It will start building. Let it; it will fail or idle until configured.

### 3a. Region — do this before anything else

*Settings* → *Regions* → **Southeast Asia (Singapore)**.

This is the closest region to Lahore. Changing it later redeploys the service.

### 3b. Add the disk

*Settings* → *Volumes* → *Add Volume*. Mount path:

```
/data
```

Size 1 GB is plenty. This disk holds the appointments database and every
uploaded photo. **Without it, all patient bookings are erased on every
deploy** — Railway's normal filesystem is wiped each time.

### 3c. Environment variables

*Variables* → *Raw Editor*, and paste this in. Replace every `CHANGE_ME`.

```
NODE_ENV=production

DB_PATH=/data/clinic.db
UPLOAD_DIR=/data/uploads

JWT_SECRET=CHANGE_ME
MEETING_TOKEN_SECRET=CHANGE_ME

ADMIN_EMAIL=admin@thespcofficial.com
ADMIN_PASSWORD=CHANGE_ME
RECEPTION_EMAIL=reception@thespcofficial.com
RECEPTION_PASSWORD=CHANGE_ME
DOCTOR_PASSWORD=CHANGE_ME

ROOT_DOMAIN=thespcofficial.com
ADMIN_HOST=03084213201.thespcofficial.com
DOCTOR_HOST=03224894179.thespcofficial.com
API_HOST=api.thespcofficial.com
COOKIE_DOMAIN=.thespcofficial.com
PUBLIC_BASE_URL=https://thespcofficial.com

CLINIC_TIMEZONE=Asia/Karachi
```

For the two secrets, generate real random values — run this twice and use a
different result for each:

```bash
openssl rand -hex 32
```

The passwords are the first sign-in for each role. Use strong ones; you can
change them in the dashboard afterwards. **The app refuses to start if any of
these are missing** — that is deliberate, so a missing secret fails loudly at
deploy rather than quietly running on a throwaway one.

### 3d. Check Serverless is OFF

*Settings* → *Serverless* → must be **disabled**.

If it is on, Railway sleeps the service when it looks idle. This app has a
background job that sends each patient their video link 5 minutes before their
appointment, and it runs *inside* the API process. A sleeping service means
patients silently never receive their link.

### 3e. Deploy and check

Redeploy. When it is green, open *Deployments* → *View Logs*. You want:

```
[api] listening on http://localhost:...
[seed] created admin: admin@thespcofficial.com
```

---

## Step 4 — Give the API its own domain

**The step that makes staff sign-in work.**

1. Railway → *Settings* → *Networking* → *Custom Domain* → enter
   `api.thespcofficial.com`.
2. Railway shows you a **CNAME target** like `abc123.up.railway.app`. Copy it.
3. Cloudflare → *DNS* → *Add record*:
   - Type: **CNAME**
   - Name: `api`
   - Target: the value Railway gave you
   - Proxy status: **DNS only** (grey cloud, *not* orange)

   Grey cloud matters. Cloudflare's proxy interferes with the long-lived
   WebSocket connections the video calls depend on.
4. Wait for Railway to show the domain as active, then check:

```bash
curl https://api.thespcofficial.com/api/health
```

You want `{"status":"ok",...}`. Do not continue until you see it.

---

## Step 5 — Deploy the three websites

Cloudflare now puts new projects on **Workers** rather than Pages. Workers has
parity for static sites, including the `_headers` and `_redirects` files in
`frontend/public/`, so that is what we use. `wrangler.jsonc` at the repo root
configures it.

All three properties are the *same build* — the app picks which one to render
from the address it is opened at. So you create three Workers projects from one
repo, identical except for the name and the domain.

For **each** of the three: Cloudflare → *Workers & Pages* → *Create* → *Import
a repository* → pick `thespcofficial-`, then:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy --name <PROJECT NAME>` |

The `--name` override matters. Without it all three deploy over the top of each
other, because they share one `wrangler.jsonc`.

Add these three build variables to **all three** projects:

```
VITE_API_BASE=https://api.thespcofficial.com
VITE_ADMIN_HOST=03084213201.thespcofficial.com
VITE_DOCTOR_HOST=03224894179.thespcofficial.com
```

Every copy has to recognise all three addresses, which is why the hostnames go
on all three and not just their own.

| Project name | Deploy command | Domain to attach |
|---|---|---|
| `spc-website` | `npx wrangler deploy --name spc-website` | `thespcofficial.com` + `www.thespcofficial.com` |
| `spc-dashboard` | `npx wrangler deploy --name spc-dashboard` | `03084213201.thespcofficial.com` |
| `spc-doctor` | `npx wrangler deploy --name spc-doctor` | `03224894179.thespcofficial.com` |

Attach the domains afterwards under the project's *Settings → Domains &
Routes → Add → Custom domain*. Cloudflare creates the DNS records itself.

These **can** stay proxied (orange cloud) — the proxy is fine for static pages.
It was only the API that had to be grey.

## Step 6 — TURN, before any real consultation

Without this, video calls connect but show a black screen for roughly one
patient in six, mostly on mobile data. It is not optional.

Cloudflare → *Calls* → create a **TURN key**. You get a key ID and secret.
Then add to **Railway**:

```
ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.cloudflare.com:3478"],"username":"<KEY_ID>","credential":"<SECRET>"}]
```

Metered.ca is an equivalent alternative if you prefer.

---

## Step 7 — Check it works

1. Open `https://thespcofficial.com` — the website loads.
2. Open `https://03084213201.thespcofficial.com` — sign in as admin.
3. Open `https://03224894179.thespcofficial.com` — sign in as a doctor.
4. **Sign in as admin, wait 20 minutes, then click something.** If you are
   still signed in, the cookie is working. If you are thrown back to the login
   screen, the API is not on `api.thespcofficial.com` — go back to step 4.
5. Book a test appointment on the public site. It should appear in the
   dashboard under *Appointments*.
6. Do a real video call with two devices before letting a patient near it.
   This is the one part no automated test covers.

---

## After launch

**Change the seeded passwords.** They are in your Railway variables and were
typed in plain text — rotate them from *Settings → Staff accounts*.

**Set up backups.** The appointments database is one file on one disk. Railway
can take volume backups — turn them on. A disk is not a backup: one bad deploy
or one wrong click and every appointment and consultation note is gone.

**Deploy in the mornings.** Pushing to `main` redeploys the API, and a service
with a disk attached has a short outage while it restarts. Doctors consult in
the evening (5–9 PM), so deploy outside that window.

**Notifications are not connected yet.** Every email and WhatsApp message the
system would send is recorded in the dashboard under *Notifications*, but
nothing is actually delivered until a provider is wired into
`backend/adapters/notifications.js`. Patients will not receive their meeting
links until that is done — until then, send them manually with the *Copy join
link* button on the appointment.

---

## If something is wrong

**Staff get signed out every 15 minutes.**
The API is not on `api.thespcofficial.com`, or `COOKIE_DOMAIN` is missing.
Step 4.

**A patient's meeting link shows a 404.**
SPA routing is off. `wrangler.jsonc` must have
`"not_found_handling": "single-page-application"` inside `assets`. Do not add a
`_redirects` file with `/* /index.html 200` — Workers rejects it as an infinite
loop, since /index.html matches /*.

**Video connects but the picture is black.**
No TURN server. Step 6.

**Appointments vanished after a deploy.**
`DB_PATH` is not pointing at the volume. It must be `/data/clinic.db`, and the
volume must be mounted at `/data`. Step 3b.

**The API will not start.**
Check the logs for `must be set in production` — a required variable is
missing. Step 3c.

**Everything looks fine but no patient receives anything.**
Expected. See *Notifications are not connected yet* above.
