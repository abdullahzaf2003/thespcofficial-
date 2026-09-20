# Surgeons Poly Clinic

Clinic platform running inside Figma Make: React + Vite + Tailwind CSS frontend,
Express + SQLite backend, WebRTC video consultations.

See `README.md` for what the system does and how the pieces fit together.

## Development Server

A Vite development server is **already running** on `$PORT` (default 8443). You
don't need to start it manually.

- Preview URL: the user can access the running app through the preview panel
- Hot reload: changes to frontend source are reflected immediately

The **API server is separate** and is not started by the harness. Run it with
`npm run server` (port 4000), or run both together with `npm run dev:full`.
Changes to `backend/` require restarting that process — there is no hot reload.

## Project Structure

Source is split into `frontend/` and `backend/`. Build and toolchain config
stays at the repo root because the Figma Make harness (`.figma/make/dev`,
`.figma/make/deploy`) runs `pnpm run dev` / `pnpm run build` from the root and
deploys the root-level `dist/`. **Do not move `package.json`, `vite.config.ts`,
`tsconfig.json`, or the `dist/` output directory** — that breaks the harness.

Start with task-relevant files below. Only follow imports or inspect other files
when required, when a documented path is missing, or when the repository
contradicts this guide.

### Root

- `package.json` - scripts for both halves (`dev`, `server`, `dev:full`, `build`, `test`)
- `vite.config.ts` - Vite config; `root` is `frontend/`, output is root `dist/`, `@` aliases `frontend/src`, and `/api` + `/ws` proxy to the API on :4000
- `tsconfig.json` - typechecks `frontend/src`
- `.env.example` - every environment variable, with notes on which are required in production
- `.mise.toml` - toolchain versions for Node.js and pnpm

### Frontend (`frontend/`)

- `index.html` - Vite HTML shell containing `#root` and loading `/src/main.tsx`
- `src/main.tsx` - React entrypoint; imports `src/index.css` and mounts `src/App.tsx`
- `src/App.tsx` - resolves the app from the **hostname** first (dashboard and doctor panel are subdomains in production), then the path: `/`, `/doctors/:id`, `/blog`, `/blog/:slug`, `/admin`, `/doctor`, `/j/:token`, `/review/:token`. Admin, doctor and join are lazy-loaded chunks.
- `src/index.css` - global CSS entrypoint and Tailwind CSS v4 import
- `src/lib/api.ts` - fetch wrapper, shared types, signaling URL helper
- `src/lib/auth.ts` - `useSession`: in-memory access token, refresh-cookie rotation, refresh-on-wake, and the `upload` helper
- `src/lib/images.ts` - resizes images in the browser to WebP before uploading
- `src/lib/richText.tsx` - renders blog bodies as React elements (never innerHTML)
- `src/lib/useCallSession.ts` - WebSocket signaling and WebRTC peer management
- `src/routes/` - one file per page; `admin/` holds the console panels, `public/` the site chrome and content pages
- `src/components/` - `VideoStage.tsx` (call UI), `ui.tsx` (form and layout primitives, incl. `ImageField`)
- `public/` - static assets served from the site root (e.g. `public/doctors/x.jpeg` → `/doctors/x.jpeg`)

### Backend (`backend/`)

- `index.js` - bootstrap: migrations, seed, jobs, signaling, Express routes
- `config.js` - environment config; dev secrets are randomised per boot
- `db/` - `sqlite.js` (the only file that knows the driver), `schema.js` (idempotent migrations), `seed.js`
- `domain/` - `availability.js` (slot generation), `booking.js` (holds, booking, status machine), `tokens.js` (meeting tokens, JWT, refresh-token families), `reviews.js` (invite-only reviews), `siteContent.js` (the editable website text — the single source of truth for the seed, the API validation and the dashboard form)
- `adapters/` - swap points for `notifications`, `queue` and `media`; keep the method names when replacing an implementation
- `realtime/signaling.js` - WebSocket hub, rooms, reception → doctor handoff
- `routes/` - `auth`, `public`, `admin`, `doctor`, `video`, `uploads`
- `data/clinic.db` - SQLite database, gitignored, recreated and reseeded on boot
- `data/uploads/` - images uploaded from the dashboard, gitignored

## Dependencies

- Runtime: React 19 and React DOM 19
- Backend: Express 5, sqlite3, ws, jsonwebtoken, bcryptjs, helmet, express-rate-limit
- Styling: Tailwind CSS v4 with the `@tailwindcss/vite` plugin
- Build tooling: Vite 8, TypeScript 5.7, and `@vitejs/plugin-react`
- Formatting: oxfmt

## Styling

This project uses **Tailwind CSS v4** through the `@tailwindcss/vite` plugin
configured in `vite.config.ts`. `frontend/src/index.css` imports Tailwind with
`@import 'tailwindcss';`. Use Tailwind utility classes directly in JSX and put
global CSS or Tailwind v4 theme customization in `frontend/src/index.css`. This
scaffold does not need a Tailwind config file or PostCSS config.

`frontend/src/main.tsx` imports `frontend/src/index.css`, so global font wiring
belongs there. Keep CSS `@import` statements first, then add any `@font-face`
rules and font-family defaults.

The palette is defined once as Tailwind v4 `@theme` tokens in
`frontend/src/index.css` and used through utility classes — `bg-brand`,
`text-accent`, `bg-soft`, `bg-canvas`, and the `-600`/`-400` variants. The
colours come from the clinic logo: navy `#0a3182` is `brand`, `#0b63c5` is
`accent`, sky `#30c0fc` is `accent-400`, `#e4f1fc` is `soft`.

**Do not reintroduce hardcoded hex** (`bg-[#0a3182]`). Tokens are why the
green-to-blue rebrand was one file rather than eleven.

**`accent-400` is the logo's sky blue and is decorative only** — fills, dots,
list markers, and text on dark panels. It scores 2.09:1 on white, so it must
never be body text there. Use `accent` (5.82:1).

**Success and "live" states stay green** (`bg-green-100 text-green-700`,
`bg-green-500`). Verified payment and a live call read green by convention;
that is worth more than palette consistency. Only brand tints were recoloured.

## Testing

```bash
npm test              # typecheck + render smoke + both e2e suites
npm run test:render   # renders every route/panel via Vite's SSR pipeline
npm run test:e2e      # booking + video pipeline (needs the API running)
npm run test:admin    # content management + permissions (needs the API running)
```

Both e2e suites write to the real database and clean up after themselves. Add
assertions there when changing booking, video, or admin behaviour.

## Code quality

- Use double quotes for strings containing apostrophes (`"We're here to help"`), or escape them in single-quoted strings. An unescaped apostrophe in a single-quoted string breaks the build.
- Ensure JSX tags are closed and braces are balanced.
- Export page components as default exports.
- Never return `password_hash` or `meeting_token` from an API response.
- Every protected route names the roles it accepts via `requireAuth(...)`.
- Appointment status changes go through `transitionStatus`, never a raw UPDATE.
- Never render stored content with `dangerouslySetInnerHTML`. Blog bodies go
  through `RichText`, which builds React elements from a small Markdown subset.
- Editable website copy belongs in `backend/domain/siteContent.js`, not in JSX.
  Adding a field there makes it editable in the dashboard automatically.
- Reviews are invite-only and moderated. Do not add an open submission endpoint.
- Website copy comes from `docs/site-content.xlsx` and `docs/clinic-content.md`,
  seeded through `SITE_DEFAULTS`. Doctor star ratings from those files are
  deliberately NOT seeded — they came from a third-party directory and cannot be
  evidenced alongside the clinic's own moderated reviews.
- Uploaded files are validated by magic bytes and given generated names.
