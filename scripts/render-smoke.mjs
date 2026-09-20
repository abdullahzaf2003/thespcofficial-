/**
 * Render smoke test.
 *
 *   node scripts/render-smoke.mjs
 *
 * Loads each route through Vite's SSR pipeline and renders it once. This
 * catches import errors, bad JSX and crashes on first render across all four
 * entry points. It does NOT exercise effects — WebSockets, getUserMedia and
 * WebRTC negotiation need a real browser.
 */

import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

// Paths are relative to Vite's root, which is frontend/.
const ROUTES = [
  { file: '/src/routes/PublicSite.tsx', name: 'PublicSite', props: {}, expect: 'Surgeons Poly Clinic' },
  { file: '/src/routes/AdminApp.tsx', name: 'AdminApp', props: {}, expect: 'Loading' },
  { file: '/src/routes/DoctorApp.tsx', name: 'DoctorApp', props: {}, expect: 'Loading' },
  { file: '/src/routes/PatientJoin.tsx', name: 'PatientJoin', props: { token: 'smoke-test-token' }, expect: 'consultation' },
  { file: '/src/routes/public/BlogPages.tsx', name: 'BlogListPage', exportName: 'BlogListPage', props: {}, expect: 'Health Library' },
  { file: '/src/routes/public/BlogPages.tsx', name: 'BlogPostPage', exportName: 'BlogPostPage', props: { slug: 'smoke' }, expect: 'Surgeons Poly Clinic' },
  { file: '/src/routes/public/DoctorDetailPage.tsx', name: 'DoctorDetailPage', props: { doctorId: '1' }, expect: 'Loading' },
  { file: '/src/routes/admin/AppointmentsPanel.tsx', name: 'AppointmentsPanel', props: { authed: async () => [], notify: () => {} }, expect: 'Status' },
  { file: '/src/routes/admin/DoctorsPanel.tsx', name: 'DoctorsPanel', props: { authed: async () => [], notify: () => {}, upload: async () => ({ url: '', bytes: 0 }) }, expect: 'Doctors' },
  { file: '/src/routes/admin/ServicesPanel.tsx', name: 'ServicesPanel', props: { authed: async () => [], notify: () => {} }, expect: 'Services' },
  { file: '/src/routes/admin/BlogPanel.tsx', name: 'BlogPanel', props: { authed: async () => [], notify: () => {}, upload: async () => ({ url: '', bytes: 0 }) }, expect: 'Blog' },
  { file: '/src/routes/admin/SettingsPanel.tsx', name: 'SettingsPanel', props: { authed: async () => ({}), notify: () => {}, role: 'admin' }, expect: 'settings' },
  { file: '/src/routes/admin/WebsitePanel.tsx', name: 'WebsitePanel', props: { authed: async () => ({ fields: [], values: {} }), notify: () => {} }, expect: 'website' },
  { file: '/src/routes/admin/FaqPanel.tsx', name: 'FaqPanel', props: { authed: async () => [], notify: () => {} }, expect: 'question' },
  { file: '/src/routes/admin/ReviewsPanel.tsx', name: 'ReviewsPanel', props: { authed: async () => ({ reviews: [], counts: {} }), notify: () => {}, role: 'admin' }, expect: 'review' },
  { file: '/src/routes/public/ReviewPage.tsx', name: 'ReviewPage', props: { token: 'smoke-test-token' }, expect: 'Loading' },
  { file: '/src/App.tsx', name: 'App', props: {}, expect: 'Surgeons Poly Clinic' },
];

let passed = 0;
let failed = 0;

// react-dom/server does not touch these, but module-level code might.
globalThis.window = undefined;

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

for (const route of ROUTES) {
  try {
    const module = await vite.ssrLoadModule(route.file);
    const Component = route.exportName ? module[route.exportName] : module.default;

    if (typeof Component !== 'function') {
      throw new Error(`${route.name} does not export a component named ${route.exportName || 'default'}`);
    }

    const html = renderToString(createElement(Component, route.props));

    if (!html.includes(route.expect)) {
      throw new Error(`rendered output did not contain "${route.expect}"`);
    }

    passed += 1;
    console.log(`  ✓ ${route.name} renders (${html.length} chars)`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${route.name}: ${error.message}`);
  }
}

await vite.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
