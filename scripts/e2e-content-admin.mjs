/**
 * End-to-end test for the content-management surface.
 *
 *   node scripts/e2e-content-admin.mjs
 *
 * Covers doctors (incl. issued credentials and the availability editor),
 * services, blog draft/publish, clinic info, staff accounts, and the
 * admin-vs-receptionist permission boundary. Cleans up everything it creates.
 */

import sqlite3 from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'http://localhost:4000';
const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'data', 'clinic.db');

let passed = 0;
let failed = 0;
const cleanup = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (title) => console.log(`\n${title}`);

async function api(method, route, { token, body, origin, cookie, raw } = {}) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    setCookie: response.headers.get('set-cookie') || '',
  };
}

/** Pulls the refresh cookie out of a Set-Cookie header for the session tests. */
function refreshCookie(setCookie) {
  const match = /clinic_refresh=([^;]+)/.exec(setCookie || '');
  return match ? `clinic_refresh=${match[1]}` : '';
}

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row))));

const db = new sqlite3.Database(DB_PATH);
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));

async function main() {
  console.log(`Running content-admin E2E against ${API}\n${'='.repeat(52)}`);

  section('Auth & roles');
  const admin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@surgeonspolyclinic.com', password: 'Admin@12345' },
  });
  check('admin signs in', admin.status === 200, JSON.stringify(admin.body));
  const adminToken = admin.body.accessToken;

  const reception = await api('POST', '/api/auth/login', {
    body: { email: 'reception@surgeonspolyclinic.com', password: 'Reception@12345' },
  });
  check('receptionist signs in', reception.status === 200, JSON.stringify(reception.body));
  const receptionToken = reception.body.accessToken;
  check('receptionist has the receptionist role', reception.body.user?.role === 'receptionist', reception.body.user?.role);

  // The permission boundary: reception runs the desk, admin owns content.
  const receptionOnDoctors = await api('GET', '/api/admin/doctors', { token: receptionToken });
  check('receptionist cannot manage doctors', receptionOnDoctors.status === 403, `got ${receptionOnDoctors.status}`);
  const receptionOnBlog = await api('GET', '/api/admin/blog', { token: receptionToken });
  check('receptionist cannot manage blog', receptionOnBlog.status === 403, `got ${receptionOnBlog.status}`);
  const receptionOnAppointments = await api('GET', '/api/admin/appointments', { token: receptionToken });
  check('receptionist CAN see appointments', receptionOnAppointments.status === 200, `got ${receptionOnAppointments.status}`);
  const receptionOnClinicInfo = await api('PUT', '/api/admin/clinic-info', {
    token: receptionToken,
    body: { clinic_name: 'Hacked' },
  });
  check('receptionist cannot edit clinic info', receptionOnClinicInfo.status === 403, `got ${receptionOnClinicInfo.status}`);

  // ------------------------------------------------------------- doctors
  section('Doctors');
  const created = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: {
      name: 'Dr E2E Test',
      specialty: 'Test Specialty',
      qualifications: 'MBBS',
      consultation_fee: 2500,
      years_experience: 7,
      slot_duration_minutes: 30,
      start_time: '09:00',
      end_time: '12:00',
    },
  });
  check('admin creates a doctor', created.status === 201, JSON.stringify(created.body));
  const doctorId = created.body.doctor?.id;
  cleanup.push(() => dbRun('DELETE FROM doctor_availability WHERE doctor_id = ?', [doctorId]));
  cleanup.push(() => dbRun('DELETE FROM doctor_services WHERE doctor_id = ?', [doctorId]));
  cleanup.push(() => dbRun('DELETE FROM doctors WHERE id = ?', [doctorId]));

  check('credentials are returned once on creation', Boolean(created.body.credentials?.username && created.body.credentials?.password), JSON.stringify(created.body.credentials));
  check('password hash is never returned', !JSON.stringify(created.body).includes('password_hash'));
  check('a persistent room id is assigned', Boolean(created.body.doctor?.socket_room_id), created.body.doctor?.socket_room_id);

  // The issued credentials must actually work.
  const newDoctorLogin = await api('POST', '/api/auth/doctor-login', {
    body: { username: created.body.credentials.username, password: created.body.credentials.password },
  });
  check('issued credentials can sign in to the doctor portal', newDoctorLogin.status === 200, JSON.stringify(newDoctorLogin.body));

  const duplicate = await api('POST', '/api/admin/doctors', {
    token: adminToken,
    body: { name: 'Dr E2E Test', specialty: 'x', username: created.body.credentials.username },
  });
  check('duplicate usernames are rejected', duplicate.status === 409, `got ${duplicate.status}`);

  const patched = await api('PATCH', `/api/admin/doctors/${doctorId}`, {
    token: adminToken,
    body: { consultation_fee: 3000, bio: 'Updated bio.' },
  });
  check('doctor can be edited', patched.status === 200 && patched.body.doctor.consultation_fee === 3000, JSON.stringify(patched.body.doctor?.consultation_fee));

  // Default Mon–Sat hours from the create call.
  const availability = await api('GET', `/api/admin/doctors/${doctorId}/availability`, { token: adminToken });
  check('default weekly hours were created', availability.body.template?.length === 6, `${availability.body.template?.length} rows`);
  check('default hours use the submitted times', availability.body.template?.[0]?.start_time === '09:00', availability.body.template?.[0]?.start_time);

  const newTemplate = await api('PUT', `/api/admin/doctors/${doctorId}/availability`, {
    token: adminToken,
    body: { template: [{ weekday: 1, start_time: '10:00', end_time: '14:00' }, { weekday: 3, start_time: '10:00', end_time: '14:00' }] },
  });
  check('availability template can be replaced', newTemplate.status === 200, JSON.stringify(newTemplate.body));

  const reread = await api('GET', `/api/admin/doctors/${doctorId}/availability`, { token: adminToken });
  check('replaced template persists', reread.body.template?.length === 2, `${reread.body.template?.length} rows`);

  const badTemplate = await api('PUT', `/api/admin/doctors/${doctorId}/availability`, {
    token: adminToken,
    body: { template: [{ weekday: 1, start_time: '18:00', end_time: '09:00' }] },
  });
  check('end time before start time is rejected', badTemplate.status === 400, JSON.stringify(badTemplate.body));

  const override = await api('POST', `/api/admin/doctors/${doctorId}/overrides`, {
    token: adminToken,
    body: { date: '2027-01-01', kind: 'closed', reason: 'e2e holiday' },
  });
  check('a date override can be added', override.status === 201, JSON.stringify(override.body));

  const closedDay = await api('GET', `/api/doctors/${doctorId}/availability?date=2027-01-01`);
  check('a closed override yields no slots', closedDay.body.slots?.length === 0, JSON.stringify(closedDay.body.slots));

  const removed = await api('DELETE', `/api/admin/overrides/${override.body.id}`, { token: adminToken });
  check('a date override can be removed', removed.status === 200, JSON.stringify(removed.body));

  const deactivated = await api('DELETE', `/api/admin/doctors/${doctorId}`, { token: adminToken });
  check('doctor can be deactivated', deactivated.status === 200);
  const publicDoctors = await api('GET', '/api/doctors');
  check('a deactivated doctor disappears from the public list', !publicDoctors.body.some((d) => d.id === doctorId));

  // ------------------------------------------------------------ services
  section('Services');
  const service = await api('POST', '/api/admin/services', {
    token: adminToken,
    body: { name: 'E2E Test Service', description: 'Temporary', price: 999, duration_minutes: 45, category: 'Testing' },
  });
  check('service is created', service.status === 201, JSON.stringify(service.body));
  const serviceId = service.body.service?.id;
  cleanup.push(() => dbRun('DELETE FROM doctor_services WHERE service_id = ?', [serviceId]));
  cleanup.push(() => dbRun('DELETE FROM services WHERE id = ?', [serviceId]));

  check('a slug is generated', service.body.service?.slug === 'e2e-test-service', service.body.service?.slug);

  const publicServices = await api('GET', '/api/services');
  check('new service appears publicly', publicServices.body.some((s) => s.id === serviceId));

  const linked = await api('PATCH', `/api/admin/services/${serviceId}`, {
    token: adminToken,
    body: { price: 1200, doctor_ids: [1] },
  });
  check('service can be edited and linked to a doctor', linked.status === 200 && linked.body.service.price === 1200, JSON.stringify(linked.body.service?.price));

  const withLinks = await api('GET', '/api/services');
  check('doctor link shows on the public feed', withLinks.body.find((s) => s.id === serviceId)?.doctor_ids?.includes(1), JSON.stringify(withLinks.body.find((s) => s.id === serviceId)?.doctor_ids));

  const doctorProfile = await api('GET', '/api/doctors/1');
  check('service appears on the doctor profile', doctorProfile.body.services?.some((s) => s.id === serviceId));

  await api('DELETE', `/api/admin/services/${serviceId}`, { token: adminToken });
  const afterHide = await api('GET', '/api/services');
  check('a hidden service leaves the public list', !afterHide.body.some((s) => s.id === serviceId));

  // ---------------------------------------------------------------- blog
  section('Blog');
  const draft = await api('POST', '/api/admin/blog', {
    token: adminToken,
    body: { title: 'E2E Draft Post', content: 'First paragraph.\n\nSecond paragraph.', excerpt: 'A draft', status: 'draft' },
  });
  check('draft post is created', draft.status === 201, JSON.stringify(draft.body));
  const postId = draft.body.post?.id;
  cleanup.push(() => dbRun('DELETE FROM blogs WHERE id = ?', [postId]));

  check('draft has a generated slug', draft.body.post?.slug === 'e2e-draft-post', draft.body.post?.slug);
  check('draft has no published_at', !draft.body.post?.published_at, draft.body.post?.published_at);

  const publicDrafts = await api('GET', '/api/blog');
  check('drafts are NOT publicly visible', !publicDrafts.body.some((p) => p.id === postId));

  const published = await api('PATCH', `/api/admin/blog/${postId}`, { token: adminToken, body: { status: 'published' } });
  check('post can be published', published.status === 200, JSON.stringify(published.body));
  check('publishing stamps published_at', Boolean(published.body.post?.published_at), published.body.post?.published_at);

  const publicPublished = await api('GET', '/api/blog');
  check('published post is publicly visible', publicPublished.body.some((p) => p.id === postId));

  const bySlug = await api('GET', '/api/blog/e2e-draft-post');
  check('post is fetchable by slug', bySlug.status === 200 && bySlug.body.id === postId, JSON.stringify(bySlug.body).slice(0, 120));

  const missing = await api('GET', '/api/blog/no-such-post');
  check('a missing slug returns 404', missing.status === 404);

  const unpublished = await api('PATCH', `/api/admin/blog/${postId}`, { token: adminToken, body: { status: 'draft' } });
  check('post can be unpublished', unpublished.status === 200);
  const afterUnpublish = await api('GET', '/api/blog');
  check('unpublished post leaves the public list', !afterUnpublish.body.some((p) => p.id === postId));

  const deleted = await api('DELETE', `/api/admin/blog/${postId}`, { token: adminToken });
  check('post can be deleted', deleted.status === 200);

  // --------------------------------------------------------- clinic info
  section('Clinic info');
  const before = await api('GET', '/api/clinic-info');
  const originalPhone = before.body.phone_primary;

  const updated = await api('PUT', '/api/admin/clinic-info', {
    token: adminToken,
    body: { phone_primary: '042-99999999' },
  });
  check('clinic info can be updated', updated.status === 200, JSON.stringify(updated.body).slice(0, 120));

  const publicInfo = await api('GET', '/api/clinic-info');
  check('the change is served publicly', publicInfo.body.phone_primary === '042-99999999', publicInfo.body.phone_primary);

  const siteContent = await api('GET', '/api/site-content');
  check('the change flows into the site feed', siteContent.body.general?.call_phone === '042-99999999', siteContent.body.general?.call_phone);

  // Put it back.
  await api('PUT', '/api/admin/clinic-info', { token: adminToken, body: { phone_primary: originalPhone } });
  const restored = await api('GET', '/api/clinic-info');
  check('original value restored', restored.body.phone_primary === originalPhone, restored.body.phone_primary);

  // --------------------------------------------------------------- staff
  section('Staff accounts');
  const weakPassword = await api('POST', '/api/admin/staff', {
    token: adminToken,
    body: { email: 'e2e-weak@example.com', password: 'short', role: 'receptionist' },
  });
  check('weak passwords are rejected', weakPassword.status === 400, JSON.stringify(weakPassword.body));

  const badRole = await api('POST', '/api/admin/staff', {
    token: adminToken,
    body: { email: 'e2e-role@example.com', password: 'LongEnoughPass1', role: 'superuser' },
  });
  check('invalid roles are rejected', badRole.status === 400, JSON.stringify(badRole.body));

  const staff = await api('POST', '/api/admin/staff', {
    token: adminToken,
    body: { email: 'e2e-staff@example.com', name: 'E2E Staff', password: 'LongEnoughPass1', role: 'receptionist' },
  });
  check('staff account is created', staff.status === 201, JSON.stringify(staff.body));
  cleanup.push(() => dbRun('DELETE FROM admin_users WHERE email = ?', ['e2e-staff@example.com']));

  const newStaffLogin = await api('POST', '/api/auth/login', {
    body: { email: 'e2e-staff@example.com', password: 'LongEnoughPass1' },
  });
  check('new staff can sign in', newStaffLogin.status === 200, JSON.stringify(newStaffLogin.body));

  const dupeStaff = await api('POST', '/api/admin/staff', {
    token: adminToken,
    body: { email: 'e2e-staff@example.com', password: 'LongEnoughPass1', role: 'admin' },
  });
  check('duplicate staff emails are rejected', dupeStaff.status === 409, `got ${dupeStaff.status}`);

  const staffList = await api('GET', '/api/admin/staff', { token: adminToken });
  check('staff list never exposes password hashes', !JSON.stringify(staffList.body).includes('password_hash'));


  // ------------------------------------------------------- website text
  section('Website text');

  const editableText = await api('GET', '/api/admin/site-content', { token: adminToken });
  check('site content returns field definitions', Array.isArray(editableText.body.fields) && editableText.body.fields.length > 0);
  check('site content returns current values', typeof editableText.body.values === 'object');

  const originalHero = editableText.body.values.hero_title_line_1;

  const savedHero = await api('PUT', '/api/admin/site-content', {
    token: adminToken,
    body: { hero_title_line_1: 'E2E Heading' },
  });
  check('admin can edit website text', savedHero.status === 200, JSON.stringify(savedHero.body));

  const publicFeed = await api('GET', '/api/site-content');
  check('the edit reaches the public website', publicFeed.body.general?.hero_title_line_1 === 'E2E Heading',
    publicFeed.body.general?.hero_title_line_1);

  const unknownKey = await api('PUT', '/api/admin/site-content', {
    token: adminToken,
    body: { not_a_real_field: 'x' },
  });
  check('unknown fields are rejected', unknownKey.status === 400, `got ${unknownKey.status}`);

  const tooLong = await api('PUT', '/api/admin/site-content', {
    token: adminToken,
    body: { hero_title_line_1: 'x'.repeat(500) },
  });
  check('over-long values are rejected', tooLong.status === 400, `got ${tooLong.status}`);

  const receptionEdit = await api('PUT', '/api/admin/site-content', {
    token: receptionToken,
    body: { hero_title_line_1: 'Reception should not manage this' },
  });
  check('a receptionist cannot edit the website text', receptionEdit.status === 403, `got ${receptionEdit.status}`);

  await api('PUT', '/api/admin/site-content', { token: adminToken, body: { hero_title_line_1: originalHero } });
  const restoredHero = await api('GET', '/api/site-content');
  check('original heading restored', restoredHero.body.general?.hero_title_line_1 === originalHero);

  // ------------------------------------------------------------ reviews
  section('Reviews');

  const openPost = await api('POST', '/api/reviews', {
    body: { patient_name: 'Spammer', rating: 5, message: 'Anyone can post this' },
  });
  check('the open review endpoint is gone', openPost.status === 404, `got ${openPost.status}`);

  const badInvite = await api('GET', '/api/reviews/invite/not-a-real-token-at-all');
  check('a forged review link is refused', badInvite.status === 400, `got ${badInvite.status}`);

  // Build a completed appointment to review, the same way a real one ends up.
  const reviewDoctorId = doctorId;
  await dbRun(
    `INSERT INTO appointments (patient_name, phone, email, patient_whatsapp, doctor_id, doctor_name,
       appointment_date, appointment_time, slot_start, slot_end, status)
     VALUES ('E2E Review Patient', '03001234567', 'review@example.com', '03001234567', ?, 'E2E Doctor',
       '2026-01-01', '10:00', '2026-01-01T05:00:00.000Z', '2026-01-01T05:20:00.000Z', 'completed')`,
    [reviewDoctorId],
  );
  const apptRow = await dbGet("SELECT id FROM appointments WHERE patient_name = 'E2E Review Patient' ORDER BY id DESC LIMIT 1");
  cleanup.push(() => dbRun('DELETE FROM appointments WHERE id = ?', [apptRow.id]));
  cleanup.push(() => dbRun('DELETE FROM reviews WHERE appointment_id = ?', [apptRow.id]));
  cleanup.push(() => dbRun('DELETE FROM review_invites WHERE appointment_id = ?', [apptRow.id]));

  const invited = await api('POST', `/api/admin/appointments/${apptRow.id}/review-invite`, { token: adminToken });
  check('admin can send a review invitation', invited.status === 200, JSON.stringify(invited.body));

  // The link is only ever sent to the patient, so read it back out of the outbox.
  const outbox = await dbGet(
    "SELECT body FROM notifications WHERE appointment_id = ? AND template = 'review_invite' ORDER BY id DESC LIMIT 1",
    [apptRow.id],
  );
  const inviteToken = (/\/review\/([A-Za-z0-9_-]+)/.exec(outbox?.body || '') || [])[1];
  check('the invitation contains a review link', Boolean(inviteToken));

  const inviteInfo = await api('GET', `/api/reviews/invite/${inviteToken}`);
  check('the review link identifies the appointment', inviteInfo.body.doctor_name === 'E2E Doctor', JSON.stringify(inviteInfo.body));

  const badRating = await api('POST', `/api/reviews/invite/${inviteToken}`, { body: { rating: 9, message: 'nope' } });
  check('an out-of-range rating is refused', badRating.status === 400, `got ${badRating.status}`);

  const submitted = await api('POST', `/api/reviews/invite/${inviteToken}`, {
    body: { rating: 5, message: 'Excellent care from the whole team.' },
  });
  check('a review can be submitted through the invitation', submitted.status === 201, JSON.stringify(submitted.body));

  const reused = await api('POST', `/api/reviews/invite/${inviteToken}`, { body: { rating: 1, message: 'again' } });
  check('the invitation is single use', reused.status === 400, `got ${reused.status}`);

  const publicAfterSubmit = await api('GET', '/api/reviews');
  check(
    'a pending review is NOT on the website',
    !publicAfterSubmit.body.some((row) => row.message === 'Excellent care from the whole team.'),
  );

  const queue = await api('GET', '/api/admin/reviews?status=pending', { token: adminToken });
  const pending = queue.body.reviews.find((row) => row.appointment_id === apptRow.id);
  check('the review is in the moderation queue', Boolean(pending), JSON.stringify(queue.body.counts));

  const approved = await api('PATCH', `/api/admin/reviews/${pending.id}`, {
    token: adminToken,
    body: { status: 'approved' },
  });
  check('a review can be approved', approved.status === 200, JSON.stringify(approved.body));

  const publicAfterApprove = await api('GET', '/api/reviews');
  check(
    'an approved review appears on the website',
    publicAfterApprove.body.some((row) => row.message === 'Excellent care from the whole team.'),
  );

  const hidden = await api('PATCH', `/api/admin/reviews/${pending.id}`, {
    token: adminToken,
    body: { status: 'rejected' },
  });
  check('a review can be taken back down', hidden.status === 200);

  const publicAfterHide = await api('GET', '/api/reviews');
  check(
    'a hidden review leaves the website',
    !publicAfterHide.body.some((row) => row.message === 'Excellent care from the whole team.'),
  );


  // ---------------------------------------------------------------- FAQ
  section('FAQ');

  const publicFaqs = await api('GET', '/api/faqs');
  check('the clinic\'s questions are seeded and public', Array.isArray(publicFaqs.body) && publicFaqs.body.length >= 3,
    JSON.stringify(publicFaqs.body).slice(0, 120));
  check('questions carry an answer', publicFaqs.body.every((row) => row.question && row.answer));

  const faqCreated = await api('POST', '/api/admin/faqs', {
    token: adminToken,
    body: { question: 'E2E question?', answer: 'E2E answer.' },
  });
  check('admin can add a question', faqCreated.status === 201, JSON.stringify(faqCreated.body));
  const faqId = faqCreated.body.faq?.id;
  cleanup.push(() => dbRun('DELETE FROM faqs WHERE id = ?', [faqId]));

  const faqMissing = await api('POST', '/api/admin/faqs', { token: adminToken, body: { question: 'Only a question' } });
  check('a question without an answer is refused', faqMissing.status === 400, `got ${faqMissing.status}`);

  const faqOnSite = await api('GET', '/api/faqs');
  check('a new question shows on the website', faqOnSite.body.some((row) => row.id === faqId));

  const faqHidden = await api('PATCH', `/api/admin/faqs/${faqId}`, { token: adminToken, body: { enabled: 0 } });
  check('a question can be hidden', faqHidden.status === 200, JSON.stringify(faqHidden.body));

  const faqAfterHide = await api('GET', '/api/faqs');
  check('a hidden question leaves the website', !faqAfterHide.body.some((row) => row.id === faqId));

  const faqReception = await api('POST', '/api/admin/faqs', {
    token: receptionToken,
    body: { question: 'x', answer: 'y' },
  });
  check('a receptionist cannot edit the FAQ', faqReception.status === 403, `got ${faqReception.status}`);

  const faqDeleted = await api('DELETE', `/api/admin/faqs/${faqId}`, { token: adminToken });
  check('a question can be deleted', faqDeleted.status === 200);

  // ------------------------------------------------- clinic content pack
  section('Clinic content');

  const feed = await api('GET', '/api/site-content');
  check('the real services heading is live', feed.body.general?.services_heading === 'Complete Surgical & ENT Services',
    feed.body.general?.services_heading);
  check('the "why choose us" copy is present', Boolean(feed.body.general?.why_choose_title));
  check('the clinic figures are present', Boolean(feed.body.general?.stat_1_value && feed.body.general?.stat_3_label));
  check('the emergency block is present', Boolean(feed.body.general?.emergency_title));
  check('the consultation fee is Rs. 3,000 everywhere', feed.body.general?.consultation_fee_amount === 3000,
    String(feed.body.general?.consultation_fee));
  check('every doctor is priced at the consultation fee',
    feed.body.doctors?.every((row) => Number(row.consultation_fee) === 3000),
    feed.body.doctors?.map((row) => row.consultation_fee).join(','));
  check('the FAQ quotes the same fee',
    (feed.body.faqs || []).every((row) => !/1,?500/.test(row.answer)),
    'a question still quotes the old fee');
  check('doctors carry their profile detail', feed.body.doctors?.some((row) => row.verification && row.timing_note),
    JSON.stringify(feed.body.doctors?.[0] || {}).slice(0, 160));
  check(
    'no unevidenced star rating is published',
    feed.body.doctors?.every((row) => !row.rating),
    'a doctor has a rating set — confirm the clinic can evidence it',
  );

  // -------------------------------------------------------- staff sessions
  section('Sessions & devices');

  const doctorSession = await api('POST', '/api/auth/doctor-login', {
    body: { username: 'dr.ayesha', password: 'Doctor@12345' },
    origin: 'http://localhost:8443',
  });
  check('doctor signs in', doctorSession.status === 200, JSON.stringify(doctorSession.body));

  const doctorDays = (new Date(doctorSession.body.sessionExpiresAt) - Date.now()) / 86_400_000;
  check('a doctor session lasts about 30 days', doctorDays > 28 && doctorDays <= 30, `${doctorDays.toFixed(1)} days`);

  const staffDays = (new Date(admin.body.sessionExpiresAt) - Date.now()) / 86_400_000;
  check('a staff session is shorter than a doctor session', staffDays < doctorDays, `${staffDays.toFixed(1)} days`);

  check('the refresh token is never returned in the response body', !('refreshToken' in doctorSession.body));

  const doctorCookie = refreshCookie(doctorSession.setCookie);
  check('sign-in sets an httpOnly refresh cookie', doctorSession.setCookie.includes('HttpOnly'), doctorSession.setCookie);

  const devices = await api('GET', '/api/auth/devices', { token: doctorSession.body.accessToken, cookie: doctorCookie });
  check('a doctor can see their signed-in devices', Array.isArray(devices.body) && devices.body.length > 0);
  check('the current device is marked', devices.body.some((row) => row.current));

  const rotated = await api('POST', '/api/auth/refresh', { cookie: doctorCookie, origin: 'http://localhost:8443' });
  check('the session refreshes from the cookie', rotated.status === 200, JSON.stringify(rotated.body));

  const slid = (new Date(rotated.body.sessionExpiresAt) - Date.now()) / 86_400_000;
  check('refreshing slides the window forward', slid > 28, `${slid.toFixed(1)} days`);

  // Presenting a token that has already been rotated means two parties hold it.
  const replay = await api('POST', '/api/auth/refresh', { cookie: doctorCookie, origin: 'http://localhost:8443' });
  check('a replayed refresh token is refused', replay.status === 401, `got ${replay.status}`);

  const afterReuse = await api('POST', '/api/auth/refresh', {
    cookie: refreshCookie(rotated.setCookie),
    origin: 'http://localhost:8443',
  });
  check('token reuse revokes the whole session family', afterReuse.status === 401, `got ${afterReuse.status}`);

  // --------------------------------------------------------- hardening
  section('Request hardening');

  const foreignOrigin = await api('POST', '/api/auth/login', {
    body: { email: 'admin@surgeonspolyclinic.com', password: 'Admin@12345' },
    origin: 'https://evil.example.com',
  });
  check('a state-changing request from an unknown origin is blocked', foreignOrigin.status === 403, `got ${foreignOrigin.status}`);

  const allowedOrigin = await api('GET', '/api/site-content', { origin: 'https://03084213201.thespcofficial.com' });
  check('the dashboard subdomain is an allowed origin', allowedOrigin.status === 200, `got ${allowedOrigin.status}`);

  const anonUpload = await api('POST', '/api/uploads', { origin: 'http://localhost:8443' });
  check('uploads require sign-in', anonUpload.status === 401, `got ${anonUpload.status}`);

  // A file that claims to be an image but is not one.
  const fakeImage = new FormData();
  fakeImage.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/webp' }), 'evil.webp');
  const fakeUpload = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, Origin: 'http://localhost:8443' },
    body: fakeImage,
  });
  check('a non-image upload is rejected on its contents', fakeUpload.status === 400, `got ${fakeUpload.status}`);

  // A real 1x1 PNG, to prove the sniffing accepts genuine images.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const realImage = new FormData();
  realImage.append('file', new Blob([pngBytes], { type: 'image/png' }), 'dot.png');
  const realUpload = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, Origin: 'http://localhost:8443' },
    body: realImage,
  });
  const uploaded = await realUpload.json().catch(() => ({}));
  check('a genuine image uploads', realUpload.status === 201 && uploaded.url?.startsWith('/uploads/'), JSON.stringify(uploaded));

  if (uploaded.url) {
    const storedPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'backend',
      'data',
      'uploads',
      path.basename(uploaded.url),
    );
    cleanup.push(() => fs.rm(storedPath, { force: true }));

    const served = await fetch(`${API}${uploaded.url}`);
    check('the uploaded image is served back', served.status === 200, `got ${served.status}`);
    check('uploads are served with nosniff', served.headers.get('x-content-type-options') === 'nosniff');
  }

  // Opt-in: this locks the current IP out of sign-in for 15 minutes, which
  // would break every later run, so it only fires on request.
  //   TEST_RATE_LIMIT=1 node scripts/e2e-content-admin.mjs
  if (process.env.TEST_RATE_LIMIT === '1') {
    section('Brute-force protection');
    const statuses = [];
    for (let attempt = 0; attempt < 13; attempt += 1) {
      const response = await api('POST', '/api/auth/login', {
        body: { email: 'admin@surgeonspolyclinic.com', password: `wrong-${attempt}` },
      });
      statuses.push(response.status);
    }
    check('repeated failed sign-ins are throttled', statuses.includes(429), statuses.join(','));

    const correct = await api('POST', '/api/auth/login', {
      body: { email: 'admin@surgeonspolyclinic.com', password: 'Admin@12345' },
    });
    check('the lockout holds even for the correct password', correct.status === 429, `got ${correct.status}`);
    console.log('  ! sign-in is now locked for this IP for 15 minutes (restart the API to clear it)');
  }
}

main()
  .catch((error) => {
    failed += 1;
    console.error('\nFATAL:', error.message);
  })
  .finally(async () => {
    for (const task of cleanup.reverse()) {
      try {
        await task();
      } catch {
        /* best effort */
      }
    }
    db.close();
    console.log(`\n${'='.repeat(52)}`);
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
