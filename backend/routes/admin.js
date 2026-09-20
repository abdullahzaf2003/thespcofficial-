import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { run, all, get } from '../db/sqlite.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { utcToClinicDate, generateSlots } from '../domain/availability.js';
import { transitionStatus, scheduleReminder, BookingError } from '../domain/booking.js';
import { meetingLinkFor, createMeetingToken, requestOrigin } from '../domain/tokens.js';
import {
  notifier,
  meetingLinkMessage,
  appointmentCancelledMessage,
  appointmentRescheduledMessage,
} from '../adapters/notifications.js';
import { hub } from '../realtime/signaling.js';
import { SITE_FIELDS, validateSiteContent } from '../domain/siteContent.js';
import { createReviewInvite, reviewLinkFor, reviewInviteMessage } from '../domain/reviews.js';
import { listDevicesFor, revokeRefreshFamily, revokeRefreshTokensFor } from '../domain/tokens.js';

const router = Router();

const admin = requireAuth('admin');
const desk = requireAuth('admin', 'receptionist');

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Applies only the fields a caller actually sent. */
async function patchRow(table, id, allowedFields, body) {
  const updates = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }
  const keys = Object.keys(updates);
  if (!keys.length) return false;

  if (allowedFields.includes('updated_at')) updates.updated_at = new Date().toISOString();
  const finalKeys = Object.keys(updates);

  await run(`UPDATE ${table} SET ${finalKeys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, [
    ...finalKeys.map((key) => updates[key]),
    id,
  ]);
  return true;
}

// ----------------------------------------------------------- dashboard

router.get('/dashboard', desk, async (_req, res) => {
  const today = utcToClinicDate(new Date().toISOString());
  const nowIso = new Date().toISOString();

  const [todays, upcoming, counts, statusRows, recentReviews] = await Promise.all([
    all('SELECT * FROM appointments WHERE appointment_date = ? ORDER BY slot_start ASC', [today]),
    all(
      `SELECT * FROM appointments
       WHERE slot_start > ? AND status NOT IN ('cancelled', 'completed', 'no_show')
       ORDER BY slot_start ASC LIMIT 25`,
      [nowIso],
    ),
    get(`SELECT
           (SELECT COUNT(*) FROM doctors WHERE enabled = 1) AS doctors,
           (SELECT COUNT(*) FROM services WHERE status = 'active') AS services,
           (SELECT COUNT(*) FROM blogs) AS blogs,
           (SELECT COUNT(*) FROM appointments) AS appointments,
           (SELECT COUNT(DISTINCT email) FROM appointments) AS patients`),
    all('SELECT status, COUNT(*) AS total FROM appointments GROUP BY status'),
    all('SELECT * FROM reviews ORDER BY id DESC LIMIT 10'),
  ]);

  // Revenue counts verified payments only — unpaid rows are not income.
  const revenue = await get(
    `SELECT COALESCE(SUM(d.consultation_fee), 0) AS total
     FROM appointments a JOIN doctors d ON d.id = a.doctor_id
     WHERE a.payment_status = 'verified' AND a.status = 'completed'`,
  );

  res.json({
    today,
    todaysAppointments: todays,
    upcomingAppointments: upcoming,
    summary: {
      ...counts,
      revenue: Number(revenue?.total || 0),
      currency: 'PKR',
      byStatus: statusRows.reduce((acc, row) => {
        acc[row.status || 'unknown'] = row.total;
        return acc;
      }, {}),
    },
    onlineDoctors: hub.onlineDoctors(),
    recentReviews,
  });
});

// -------------------------------------------------------- appointments

router.get('/appointments', desk, async (req, res) => {
  const filters = [];
  const params = [];

  if (req.query.doctorId) {
    filters.push('doctor_id = ?');
    params.push(Number(req.query.doctorId));
  }
  if (req.query.status) {
    filters.push('status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.date) {
    filters.push('appointment_date = ?');
    params.push(String(req.query.date));
  }
  if (req.query.from) {
    filters.push('appointment_date >= ?');
    params.push(String(req.query.from));
  }
  if (req.query.to) {
    filters.push('appointment_date <= ?');
    params.push(String(req.query.to));
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const appointments = await all(
    `SELECT * FROM appointments ${where} ORDER BY slot_start DESC, id DESC LIMIT ?`,
    [...params, limit],
  );

  // Never leak live meeting tokens into a list view.
  res.json(appointments.map(({ meeting_token, ...rest }) => ({ ...rest, has_link: Boolean(meeting_token) })));
});

router.patch('/appointments/:id', desk, async (req, res) => {
  const id = Number(req.params.id);
  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [id]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  const doctor = await get('SELECT * FROM doctors WHERE id = ?', [appointment.doctor_id]);

  // Reschedule: validate the new slot the same way a patient booking would be.
  if (req.body.slot_start && req.body.slot_start !== appointment.slot_start) {
    const newStart = String(req.body.slot_start);
    if (Number.isNaN(Date.parse(newStart))) return res.status(400).json({ message: 'slot_start must be an ISO date.' });

    const clash = await get(
      `SELECT id FROM appointments
       WHERE doctor_id = ? AND slot_start = ? AND id != ? AND status NOT IN ('cancelled', 'no_show')`,
      [appointment.doctor_id, newStart, id],
    );
    if (clash) return res.status(409).json({ message: 'The doctor already has an appointment at that time.' });

    const step = Number(doctor?.slot_duration_minutes) || 20;
    await run(
      'UPDATE appointments SET slot_start = ?, slot_end = ?, appointment_date = ?, appointment_time = ?, updated_at = ? WHERE id = ?',
      [
        newStart,
        new Date(new Date(newStart).getTime() + step * 60_000).toISOString(),
        utcToClinicDate(newStart),
        new Intl.DateTimeFormat('en-GB', { timeZone: config.clinicTimezone, hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(newStart)),
        new Date().toISOString(),
        id,
      ],
    );

    const moved = await get('SELECT * FROM appointments WHERE id = ?', [id]);
    await scheduleReminder(moved);
    await notifier.sendToPatient(moved, appointmentRescheduledMessage(moved, doctor?.name || 'your doctor'));
  }

  await patchRow('appointments', id, ['receptionist_notes', 'note', 'patient_name', 'updated_at'], req.body);

  if (req.body.status && req.body.status !== appointment.status) {
    try {
      await transitionStatus(id, String(req.body.status));
    } catch (error) {
      if (error instanceof BookingError) return res.status(error.status).json({ message: error.message });
      throw error;
    }

    if (req.body.status === 'cancelled') {
      const cancelled = await get('SELECT * FROM appointments WHERE id = ?', [id]);
      await notifier.sendToPatient(
        cancelled,
        appointmentCancelledMessage(cancelled, doctor?.name || 'your doctor', req.body.reason),
      );
    }
  }

  const updated = await get('SELECT * FROM appointments WHERE id = ?', [id]);
  const { meeting_token, ...safe } = updated;
  return res.json({ message: 'Appointment updated.', appointment: safe });
});

/** Receptionist marks payment verified on the call (Section 6.4). */
router.patch('/appointments/:id/payment-status', desk, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.payment_status || '');

  if (!['unpaid', 'pending_verification', 'verified'].includes(status)) {
    return res.status(400).json({ message: 'payment_status must be unpaid, pending_verification, or verified.' });
  }

  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [id]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  await run('UPDATE appointments SET payment_status = ?, updated_at = ? WHERE id = ?', [
    status,
    new Date().toISOString(),
    id,
  ]);

  const updated = await get('SELECT * FROM appointments WHERE id = ?', [id]);
  if (status === 'verified') hub.notifyPaymentVerified(updated);

  const { meeting_token, ...safe } = updated;
  return res.json({ message: 'Payment status updated.', appointment: safe });
});

/** Manual resend (Section 6.3) — also re-mints a token that was already burnt. */
router.post('/appointments/:id/resend-link', desk, async (req, res) => {
  const id = Number(req.params.id);
  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [id]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  if (['cancelled', 'completed', 'no_show'].includes(appointment.status)) {
    return res.status(409).json({ message: `Cannot send a link for a ${appointment.status} appointment.` });
  }

  let token = appointment.meeting_token;
  if (!token) {
    token = createMeetingToken(id);
    await run('UPDATE appointments SET meeting_token = ?, meeting_token_used_at = NULL WHERE id = ?', [token, id]);
  }

  const doctor = await get('SELECT name FROM doctors WHERE id = ?', [appointment.doctor_id]);
  await notifier.sendToPatient(
    appointment,
    meetingLinkMessage(appointment, doctor?.name || 'your doctor', meetingLinkFor(token, requestOrigin(req))),
  );
  await run('UPDATE appointments SET reminder_sent_at = ? WHERE id = ?', [new Date().toISOString(), id]);

  return res.json({ message: 'Meeting link sent by email and WhatsApp.' });
});

/**
 * Reveals the patient's join link so reception can copy it, read it out on the
 * phone, or re-send it by hand.
 *
 * Deliberately a separate call rather than a field on the appointments list:
 * the token is the entire credential for joining the call, so it is fetched
 * one appointment at a time on an explicit action instead of being sprayed
 * across every list response, log and browser cache.
 */
router.get('/appointments/:id/meeting-link', desk, async (req, res) => {
  const id = Number(req.params.id);
  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [id]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  if (['cancelled', 'no_show'].includes(appointment.status)) {
    return res.status(409).json({ message: `This appointment is ${appointment.status}.` });
  }
  if (appointment.status === 'completed') {
    return res.status(409).json({ message: 'This consultation is finished and its link has been retired.' });
  }

  // Mint on demand so the link is available before the reminder job runs, and
  // again if a previous session burnt the old token.
  let token = appointment.meeting_token;
  if (!token) {
    token = createMeetingToken(id);
    await run('UPDATE appointments SET meeting_token = ?, meeting_token_used_at = NULL WHERE id = ?', [token, id]);
  }

  const start = new Date(appointment.slot_start).getTime();
  return res.json({
    link: meetingLinkFor(token, requestOrigin(req)),
    opensAt: new Date(start - config.meetingTokenEarlyMinutes * 60_000).toISOString(),
    expiresAt: new Date(start + config.meetingTokenLateMinutes * 60_000).toISOString(),
    slotStart: appointment.slot_start,
    patientName: appointment.patient_name,
  });
});

/** Outbox view — makes the notification pipeline inspectable without a mail server. */
router.get('/notifications', desk, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await all('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', [limit]));
});

// -------------------------------------------------------------- doctors

router.get('/doctors', admin, async (_req, res) => {
  const doctors = await all('SELECT * FROM doctors ORDER BY id ASC');
  res.json(doctors.map(({ password_hash, ...rest }) => rest));
});

router.post('/doctors', admin, async (req, res) => {
  const { name, specialty } = req.body || {};
  if (!name || !specialty) return res.status(400).json({ message: 'Doctor name and specialty are required.' });

  const username = req.body.username ? slugify(req.body.username) : slugify(name);
  const password = req.body.password || crypto.randomBytes(6).toString('base64url');

  const existing = await get('SELECT id FROM doctors WHERE username = ?', [username]);
  if (existing) return res.status(409).json({ message: 'That username is already taken.' });

  const { id } = await run(
    `INSERT INTO doctors (
       name, specialty, qualifications, image, bio, enabled, username, password_hash,
       socket_room_id, consultation_fee, currency, languages, years_experience,
       slot_duration_minutes, status, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      String(name),
      String(specialty),
      String(req.body.qualifications || ''),
      String(req.body.image || ''),
      String(req.body.bio || ''),
      username,
      bcrypt.hashSync(String(password), 10),
      `doctor-${crypto.randomBytes(8).toString('hex')}`,
      Number(req.body.consultation_fee || 3000),
      String(req.body.currency || 'PKR'),
      String(req.body.languages || 'English, Urdu'),
      Number(req.body.years_experience || 0),
      Number(req.body.slot_duration_minutes || 20),
      new Date().toISOString(),
    ],
  );

  // Default to Mon–Sat evening hours; editable via /doctors/:id/availability.
  for (let weekday = 1; weekday <= 6; weekday += 1) {
    await run('INSERT INTO doctor_availability (doctor_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)', [
      id,
      weekday,
      String(req.body.start_time || '18:00'),
      String(req.body.end_time || '21:00'),
    ]);
  }

  const doctor = await get('SELECT * FROM doctors WHERE id = ?', [id]);
  const { password_hash, ...safe } = doctor;
  // The generated password is shown once, here, and never stored in plain text.
  return res.status(201).json({ message: 'Doctor created.', doctor: safe, credentials: { username, password } });
});

router.patch('/doctors/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  const doctor = await get('SELECT id FROM doctors WHERE id = ?', [id]);
  if (!doctor) return res.status(404).json({ message: 'Doctor not found.' });

  await patchRow(
    'doctors',
    id,
    [
      'name', 'specialty', 'qualifications', 'image', 'bio', 'enabled', 'consultation_fee',
      'currency', 'languages', 'years_experience', 'slot_duration_minutes', 'status', 'updated_at',
      'verification', 'wait_time', 'timing_note', 'tags', 'rating', 'reviews_note',
    ],
    req.body,
  );

  if (req.body.password) {
    await run('UPDATE doctors SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(String(req.body.password), 10), id]);
  }

  const updated = await get('SELECT * FROM doctors WHERE id = ?', [id]);
  const { password_hash, ...safe } = updated;
  return res.json({ message: 'Doctor updated.', doctor: safe });
});

router.delete('/doctors/:id', admin, async (req, res) => {
  // Soft delete: appointment history must survive.
  await run("UPDATE doctors SET enabled = 0, status = 'inactive' WHERE id = ?", [Number(req.params.id)]);
  res.json({ message: 'Doctor deactivated.' });
});

router.get('/doctors/:id/availability', admin, async (req, res) => {
  const id = Number(req.params.id);
  const [template, overrides] = await Promise.all([
    all('SELECT * FROM doctor_availability WHERE doctor_id = ? ORDER BY weekday ASC', [id]),
    all('SELECT * FROM doctor_date_overrides WHERE doctor_id = ? ORDER BY date ASC', [id]),
  ]);
  res.json({ template, overrides });
});

router.put('/doctors/:id/availability', admin, async (req, res) => {
  const id = Number(req.params.id);
  const template = Array.isArray(req.body?.template) ? req.body.template : null;
  if (!template) return res.status(400).json({ message: 'template must be an array of weekly windows.' });

  for (const row of template) {
    if (!/^\d{2}:\d{2}$/.test(String(row.start_time)) || !/^\d{2}:\d{2}$/.test(String(row.end_time))) {
      return res.status(400).json({ message: 'start_time and end_time must be HH:MM.' });
    }
    if (String(row.start_time) >= String(row.end_time)) {
      return res.status(400).json({ message: 'start_time must be before end_time.' });
    }
  }

  await run('DELETE FROM doctor_availability WHERE doctor_id = ?', [id]);
  for (const row of template) {
    await run(
      'INSERT INTO doctor_availability (doctor_id, weekday, start_time, end_time, enabled) VALUES (?, ?, ?, ?, ?)',
      [id, Number(row.weekday), String(row.start_time), String(row.end_time), row.enabled === false ? 0 : 1],
    );
  }

  res.json({ message: 'Availability updated.' });
});

router.post('/doctors/:id/overrides', admin, async (req, res) => {
  const id = Number(req.params.id);
  const { date, kind = 'closed', start_time = null, end_time = null, reason = '' } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });

  const { id: overrideId } = await run(
    'INSERT INTO doctor_date_overrides (doctor_id, date, kind, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?, ?)',
    [id, String(date), String(kind), start_time, end_time, String(reason)],
  );
  res.status(201).json({ message: 'Override added.', id: overrideId });
});

router.delete('/overrides/:id', admin, async (req, res) => {
  await run('DELETE FROM doctor_date_overrides WHERE id = ?', [Number(req.params.id)]);
  res.json({ message: 'Override removed.' });
});

/** Lets the admin preview exactly what a patient would see. */
router.get('/doctors/:id/slots', desk, async (req, res) => {
  const date = String(req.query.date || utcToClinicDate(new Date().toISOString()));
  res.json({ date, slots: await generateSlots(Number(req.params.id), date) });
});

// ------------------------------------------------------------- services

router.get('/services', admin, async (_req, res) => {
  res.json(await all('SELECT * FROM services ORDER BY sort_order ASC, id ASC'));
});

router.post('/services', admin, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ message: 'Service name is required.' });

  const { id } = await run(
    `INSERT INTO services (name, slug, description, category, icon, image, price, currency, duration_minutes, status, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(name),
      slugify(req.body.slug || name),
      String(req.body.description || ''),
      String(req.body.category || 'General'),
      String(req.body.icon || ''),
      String(req.body.image || ''),
      Number(req.body.price || 0),
      String(req.body.currency || 'PKR'),
      Number(req.body.duration_minutes || 20),
      String(req.body.status || 'active'),
      Number(req.body.sort_order || 0),
    ],
  );

  for (const doctorId of req.body.doctor_ids || []) {
    await run('INSERT OR IGNORE INTO doctor_services (doctor_id, service_id) VALUES (?, ?)', [Number(doctorId), id]);
  }

  res.status(201).json({ message: 'Service created.', service: await get('SELECT * FROM services WHERE id = ?', [id]) });
});

router.patch('/services/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  await patchRow(
    'services',
    id,
    ['name', 'description', 'category', 'icon', 'image', 'price', 'currency', 'duration_minutes', 'status', 'sort_order'],
    req.body,
  );

  if (Array.isArray(req.body.doctor_ids)) {
    await run('DELETE FROM doctor_services WHERE service_id = ?', [id]);
    for (const doctorId of req.body.doctor_ids) {
      await run('INSERT OR IGNORE INTO doctor_services (doctor_id, service_id) VALUES (?, ?)', [Number(doctorId), id]);
    }
  }

  res.json({ message: 'Service updated.', service: await get('SELECT * FROM services WHERE id = ?', [id]) });
});

router.delete('/services/:id', admin, async (req, res) => {
  await run("UPDATE services SET status = 'inactive' WHERE id = ?", [Number(req.params.id)]);
  res.json({ message: 'Service deactivated.' });
});

// ----------------------------------------------------------------- blog

/**
 * Blog bodies are stored and rendered as plain text with a small Markdown-ish
 * subset (see frontend/src/lib/richText.tsx), never as HTML. Stripping tags on
 * the way in keeps the stored copy matching what is rendered, so a post pasted
 * out of Word does not leave stray markup on the page. The renderer builds
 * React elements rather than setting innerHTML, so this is tidiness rather
 * than the security control — that one is structural.
 */
function stripHtml(value) {
  return String(value ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

router.get('/blog', admin, async (_req, res) => {
  res.json(await all('SELECT * FROM blogs ORDER BY id DESC'));
});

router.post('/blog', admin, async (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ message: 'Title and content are required.' });

  const status = req.body.status === 'draft' ? 'draft' : 'published';
  const { id } = await run(
    `INSERT INTO blogs (title, slug, excerpt, content, image, author, status, tags, seo_title, seo_description, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(title),
      slugify(req.body.slug || title),
      stripHtml(req.body.excerpt || ''),
      stripHtml(content),
      String(req.body.image || ''),
      String(req.body.author || req.auth.name || 'Admin'),
      status,
      String(req.body.tags || ''),
      String(req.body.seo_title || ''),
      String(req.body.seo_description || ''),
      status === 'published' ? new Date().toISOString() : null,
    ],
  );

  res.status(201).json({ message: 'Post created.', post: await get('SELECT * FROM blogs WHERE id = ?', [id]) });
});

router.patch('/blog/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  const body = { ...req.body };
  if (body.content !== undefined) body.content = stripHtml(body.content);
  if (body.excerpt !== undefined) body.excerpt = stripHtml(body.excerpt);
  await patchRow(
    'blogs',
    id,
    ['title', 'excerpt', 'content', 'image', 'author', 'status', 'tags', 'seo_title', 'seo_description'],
    body,
  );
  if (req.body.status === 'published') {
    await run('UPDATE blogs SET published_at = COALESCE(published_at, ?) WHERE id = ?', [new Date().toISOString(), id]);
  }
  res.json({ message: 'Post updated.', post: await get('SELECT * FROM blogs WHERE id = ?', [id]) });
});

router.delete('/blog/:id', admin, async (req, res) => {
  await run('DELETE FROM blogs WHERE id = ?', [Number(req.params.id)]);
  res.json({ message: 'Post deleted.' });
});

// --------------------------------------------------------- clinic info

router.get('/clinic-info', desk, async (_req, res) => {
  const rows = await all('SELECT key, value FROM clinic_info');
  res.json(rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {}));
});

router.put('/clinic-info', admin, async (req, res) => {
  const body = req.body || {};
  for (const [key, value] of Object.entries(body)) {
    await run(
      `INSERT INTO clinic_info (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), new Date().toISOString()],
    );
  }
  const rows = await all('SELECT key, value FROM clinic_info');
  res.json({ message: 'Clinic info updated.', info: rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {}) });
});

// --------------------------------------------------------------- staff

router.get('/staff', admin, async (_req, res) => {
  res.json(await all('SELECT id, email, name, role, status, created_at FROM admin_users ORDER BY id ASC'));
});

router.post('/staff', admin, async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
  if (!['admin', 'receptionist'].includes(role)) {
    return res.status(400).json({ message: 'Role must be admin or receptionist.' });
  }
  if (String(password).length < 10) {
    return res.status(400).json({ message: 'Password must be at least 10 characters.' });
  }

  try {
    const { id } = await run('INSERT INTO admin_users (email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?)', [
      String(email).trim().toLowerCase(),
      bcrypt.hashSync(String(password), 10),
      String(name || ''),
      role,
      'active',
    ]);
    res.status(201).json({ message: 'Staff account created.', id });
  } catch {
    res.status(409).json({ message: 'That email is already registered.' });
  }
});

// -------------------------------------------------------- website text

/**
 * The website's editable text, shipped together with the field definitions
 * that describe it. The dashboard builds its form from `fields`, so adding an
 * editable heading is a one-line change in domain/siteContent.js and needs no
 * frontend work at all.
 */
router.get('/site-content', admin, async (_req, res) => {
  const rows = await all('SELECT key, value FROM clinic_info');
  const values = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
  res.json({ fields: SITE_FIELDS, values });
});

router.put('/site-content', admin, async (req, res) => {
  const { values, errors } = validateSiteContent(req.body);
  if (errors.length) return res.status(400).json({ message: errors[0], errors });
  if (!Object.keys(values).length) return res.status(400).json({ message: 'Nothing to save.' });

  for (const [key, value] of Object.entries(values)) {
    await run(
      `INSERT INTO clinic_info (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }

  const rows = await all('SELECT key, value FROM clinic_info');
  res.json({
    message: 'Website updated. Your changes are live.',
    values: rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {}),
  });
});

// ------------------------------------------------------------- reviews

/** Moderation queue. Defaults to what needs a decision. */
router.get('/reviews', desk, async (req, res) => {
  const status = String(req.query.status || 'pending');
  const clauses = ['approved', 'rejected', 'pending'].includes(status) ? 'WHERE r.status = ?' : '';
  const params = clauses ? [status] : [];

  const reviews = await all(
    `SELECT r.*, a.appointment_date, a.slot_start
       FROM reviews r
       LEFT JOIN appointments a ON a.id = r.appointment_id
       ${clauses}
      ORDER BY r.id DESC
      LIMIT 200`,
    params,
  );

  const counts = await all('SELECT status, COUNT(*) AS total FROM reviews GROUP BY status');
  res.json({
    reviews,
    counts: counts.reduce((acc, row) => ({ ...acc, [row.status]: Number(row.total) }), {}),
  });
});

router.patch('/reviews/:id', desk, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'Status must be approved, rejected or pending.' });
  }

  const review = await get('SELECT id FROM reviews WHERE id = ?', [id]);
  if (!review) return res.status(404).json({ message: 'Review not found.' });

  await run('UPDATE reviews SET status = ?, moderated_at = ?, moderated_by = ? WHERE id = ?', [
    status,
    new Date().toISOString(),
    req.auth.name || String(req.auth.id),
    id,
  ]);

  const updated = await get('SELECT * FROM reviews WHERE id = ?', [id]);
  res.json({
    message: status === 'approved' ? 'Review published on the website.' : 'Review updated.',
    review: updated,
  });
});

router.delete('/reviews/:id', admin, async (req, res) => {
  await run('DELETE FROM reviews WHERE id = ?', [Number(req.params.id)]);
  res.json({ message: 'Review deleted.' });
});

/** Manually (re)send the review invitation for a completed appointment. */
router.post('/appointments/:id/review-invite', desk, async (req, res) => {
  const id = Number(req.params.id);
  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [id]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });
  if (appointment.status !== 'completed') {
    return res.status(409).json({ message: 'Only completed consultations can be reviewed.' });
  }

  const existing = await get('SELECT id FROM reviews WHERE appointment_id = ?', [id]);
  if (existing) return res.status(409).json({ message: 'This patient has already left a review.' });

  const [doctor, clinic] = await Promise.all([
    get('SELECT name FROM doctors WHERE id = ?', [appointment.doctor_id]),
    get("SELECT value FROM clinic_info WHERE key = 'clinic_name'"),
  ]);

  const { token } = await createReviewInvite(id);
  await notifier.sendToPatient(
    appointment,
    reviewInviteMessage(
      appointment,
      doctor?.name || 'your doctor',
      reviewLinkFor(token, requestOrigin(req)),
      clinic?.value || 'our clinic',
    ),
  );

  res.json({ message: 'Review invitation sent.' });
});

// ------------------------------------------------- doctor sign-in devices

/**
 * Doctors stay signed in for a long time, so the admin needs to be able to see
 * where and cut one off — a lost phone is the scenario this exists for.
 */
router.get('/doctors/:id/devices', admin, async (req, res) => {
  const devices = await listDevicesFor('doctor', Number(req.params.id));
  res.json(
    devices.map((device) => ({
      id: device.family_id,
      label: device.device_label || 'Unknown device',
      last_used_at: device.last_used_at,
      expires_at: device.expires_at,
    })),
  );
});

router.delete('/doctors/:id/devices/:familyId', admin, async (req, res) => {
  await revokeRefreshFamily('doctor', Number(req.params.id), String(req.params.familyId));
  res.json({ message: 'That device has been signed out.' });
});

router.post('/doctors/:id/sign-out-everywhere', admin, async (req, res) => {
  await revokeRefreshTokensFor('doctor', Number(req.params.id));
  res.json({ message: 'The doctor has been signed out on all devices.' });
});

// ---------------------------------------------------------------- FAQ

router.get('/faqs', admin, async (_req, res) => {
  res.json(await all('SELECT * FROM faqs ORDER BY sort_order ASC, id ASC'));
});

router.post('/faqs', admin, async (req, res) => {
  const { question, answer } = req.body || {};
  if (!question || !answer) return res.status(400).json({ message: 'A question and an answer are both required.' });

  const next = await get('SELECT COALESCE(MAX(sort_order), 0) + 1 AS position FROM faqs');
  const { id } = await run(
    'INSERT INTO faqs (question, answer, sort_order, enabled, updated_at) VALUES (?, ?, ?, ?, ?)',
    [
      String(question).slice(0, 300),
      String(answer).slice(0, 2000),
      Number(req.body.sort_order) || next.position,
      req.body.enabled === false ? 0 : 1,
      new Date().toISOString(),
    ],
  );
  res.status(201).json({ message: 'Question added.', faq: await get('SELECT * FROM faqs WHERE id = ?', [id]) });
});

router.patch('/faqs/:id', admin, async (req, res) => {
  const id = Number(req.params.id);
  const faq = await get('SELECT id FROM faqs WHERE id = ?', [id]);
  if (!faq) return res.status(404).json({ message: 'Question not found.' });

  await patchRow('faqs', id, ['question', 'answer', 'sort_order', 'enabled', 'updated_at'], req.body);
  res.json({ message: 'Question updated.', faq: await get('SELECT * FROM faqs WHERE id = ?', [id]) });
});

router.delete('/faqs/:id', admin, async (req, res) => {
  await run('DELETE FROM faqs WHERE id = ?', [Number(req.params.id)]);
  res.json({ message: 'Question deleted.' });
});

export default router;
