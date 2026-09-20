import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { all, get, run } from '../db/sqlite.js';
import { generateSlots, utcToClinicDate } from '../domain/availability.js';
import { createAppointment, holdSlot, releaseHold, BookingError } from '../domain/booking.js';
import { resolveMeetingToken } from '../domain/tokens.js';
import { resolveReviewInvite, markInviteUsed } from '../domain/reviews.js';
import { SITE_DEFAULTS } from '../domain/siteContent.js';
import { config } from '../config.js';

const router = Router();

// Booking endpoints are the abuse-prone ones (Section 9).
const bookingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many booking attempts. Please try again shortly.' },
});

const PUBLIC_DOCTOR_FIELDS = `
  id, name, specialty, qualifications, image, bio, consultation_fee, currency,
  languages, years_experience, slot_duration_minutes, enabled, status,
  verification, wait_time, timing_note, tags, rating, reviews_note
`;

async function clinicInfo() {
  const rows = await all('SELECT key, value FROM clinic_info');
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

// ------------------------------------------------------------- content

router.get('/clinic-info', async (_req, res) => {
  res.json(await clinicInfo());
});

router.get('/doctors', async (_req, res) => {
  const doctors = await all(
    `SELECT ${PUBLIC_DOCTOR_FIELDS} FROM doctors WHERE enabled = 1 AND status != 'inactive' ORDER BY id ASC`,
  );
  res.json(doctors);
});

router.get('/doctors/:id', async (req, res) => {
  const doctor = await get(`SELECT ${PUBLIC_DOCTOR_FIELDS} FROM doctors WHERE id = ? AND enabled = 1`, [
    Number(req.params.id),
  ]);
  if (!doctor) return res.status(404).json({ message: 'Doctor not found.' });

  const [services, availability] = await Promise.all([
    all(
      `SELECT s.*, ds.price_override FROM services s
       JOIN doctor_services ds ON ds.service_id = s.id
       WHERE ds.doctor_id = ? AND s.status = 'active' ORDER BY s.sort_order ASC`,
      [doctor.id],
    ),
    all('SELECT weekday, start_time, end_time FROM doctor_availability WHERE doctor_id = ? AND enabled = 1', [
      doctor.id,
    ]),
  ]);

  return res.json({ ...doctor, services, availability });
});

router.get('/doctors/:id/availability', async (req, res) => {
  const date = String(req.query.date || utcToClinicDate(new Date().toISOString()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'date must be in YYYY-MM-DD format.' });
  }

  const slots = await generateSlots(Number(req.params.id), date);
  return res.json({ date, timezone: config.clinicTimezone, slots });
});

router.get('/services', async (_req, res) => {
  const services = await all("SELECT * FROM services WHERE status = 'active' ORDER BY sort_order ASC, id ASC");
  const links = await all('SELECT * FROM doctor_services');
  res.json(
    services.map((service) => ({
      ...service,
      doctor_ids: links.filter((link) => link.service_id === service.id).map((link) => link.doctor_id),
    })),
  );
});

router.get('/faqs', async (_req, res) => {
  res.json(await all('SELECT id, question, answer FROM faqs WHERE enabled = 1 ORDER BY sort_order ASC, id ASC'));
});

router.get('/blog', async (_req, res) => {
  res.json(await all("SELECT * FROM blogs WHERE status IS NULL OR status = 'published' ORDER BY id DESC"));
});

router.get('/blog/:slug', async (req, res) => {
  const post = await get('SELECT * FROM blogs WHERE slug = ? OR id = ?', [req.params.slug, Number(req.params.slug) || 0]);
  if (!post) return res.status(404).json({ message: 'Post not found.' });
  return res.json(post);
});

/**
 * Aggregate feed used by the public site. Kept in the shape the existing
 * frontend already consumes so the design layer did not have to change.
 */
router.get('/site-content', async (_req, res) => {
  const info = await clinicInfo();
  const [doctors, blogs, reviews, sections, serviceRows, serviceLinks, faqs] = await Promise.all([
    all(`SELECT ${PUBLIC_DOCTOR_FIELDS} FROM doctors WHERE enabled = 1 AND status != 'inactive' ORDER BY id ASC`),
    all("SELECT * FROM blogs WHERE status IS NULL OR status = 'published' ORDER BY id DESC"),
    all("SELECT * FROM reviews WHERE status = 'approved' ORDER BY id DESC"),
    all('SELECT * FROM site_sections WHERE enabled = 1 ORDER BY id ASC'),
    all("SELECT * FROM services WHERE status = 'active' ORDER BY sort_order ASC, id ASC"),
    all('SELECT * FROM doctor_services'),
    all('SELECT id, question, answer FROM faqs WHERE enabled = 1 ORDER BY sort_order ASC, id ASC'),
  ]);

  // The home page needs to know which doctors offer each service: clicking
  // "Book this" switches to a doctor who actually provides it, rather than
  // leaving whoever was selected. Without these ids the click-through would
  // silently land on the wrong doctor.
  const services = serviceRows.map((service) => ({
    ...service,
    doctor_ids: serviceLinks.filter((link) => link.service_id === service.id).map((link) => link.doctor_id),
  }));

  // Everything here now comes out of `clinic_info`, which the dashboard edits.
  // `SITE_DEFAULTS` is the fallback for a key the clinic has never touched, so
  // a fresh database and an edited one render the same shape.
  const text = (key) => info[key] ?? SITE_DEFAULTS[key] ?? '';

  res.json({
    general: {
      site_name: info.clinic_name,
      site_subtitle: info.clinic_subtitle,
      location: info.location,
      address: info.address,
      status: info.opening_hours,
      tagline: text('tagline'),
      hero_title_line_1: text('hero_title_line_1'),
      hero_title_line_2: text('hero_title_line_2'),
      hero_title_line_3: text('hero_title_line_3'),
      hero_intro: text('hero_intro'),
      hero_primary_cta: text('hero_primary_cta'),
      hero_secondary_cta: text('hero_secondary_cta'),

      services_heading: text('services_heading'),
      services_intro: text('services_intro'),
      doctors_heading: text('doctors_heading'),
      doctors_intro: text('doctors_intro'),
      booking_heading: text('booking_heading'),
      booking_intro: text('booking_intro'),
      reviews_heading: text('reviews_heading'),
      reviews_intro: text('reviews_intro'),
      contact_heading: text('contact_heading'),
      contact_intro: text('contact_intro'),

      call_phone: info.phone_primary,
      alternate_phone: info.phone_secondary,
      email_public: text('email_public'),
      maps_url: text('maps_url'),
      calling_hours: info.calling_hours,
      consultation_fee: `Rs. ${Number(info.consultation_fee || 3000).toLocaleString('en-PK')}`,
      consultation_fee_amount: Number(info.consultation_fee || 3000),
      whatsapp_number: info.whatsapp_number,
      timezone: info.timezone || config.clinicTimezone,

      services_eyebrow: text('services_eyebrow'),
      doctors_eyebrow: text('doctors_eyebrow'),

      why_choose_title: text('why_choose_title'),
      experience_quote: text('experience_quote'),
      why_choose_description: text('why_choose_description'),
      about_body: text('about_body'),
      location_badge: text('location_badge'),

      stat_1_value: text('stat_1_value'),
      stat_1_label: text('stat_1_label'),
      stat_2_value: text('stat_2_value'),
      stat_2_label: text('stat_2_label'),
      stat_3_value: text('stat_3_value'),
      stat_3_label: text('stat_3_label'),

      emergency_title: text('emergency_title'),
      emergency_description: text('emergency_description'),

      faq_heading: text('faq_heading'),
      faq_intro: text('faq_intro'),

      seo_title: text('seo_title'),
      seo_description: text('seo_description'),
      footer_note: text('footer_note'),
    },
    faqs,
    doctors,
    services,
    blogs,
    reviews,
    sections,
  });
});

// ------------------------------------------------------------- booking

/** Temporarily locks a slot while the patient completes the form (3.2). */
router.post('/appointments/hold', bookingLimiter, async (req, res, next) => {
  try {
    const hold = await holdSlot({
      doctorId: Number(req.body?.doctor_id),
      slotStart: String(req.body?.slot_start || ''),
    });
    res.status(201).json({ ...hold, holdMinutes: config.slotHoldMinutes });
  } catch (error) {
    next(error);
  }
});

router.delete('/appointments/hold/:token', async (req, res) => {
  await releaseHold(req.params.token);
  res.json({ message: 'Hold released.' });
});

/** Back-compat slot list. `start` is the field new clients should send back. */
router.get('/appointments/slots', async (req, res) => {
  const { doctorId, date } = req.query;
  if (!doctorId || !date) return res.status(400).json({ message: 'doctorId and date are required.' });

  const slots = await generateSlots(Number(doctorId), String(date));
  return res.json({ date: String(date), timezone: config.clinicTimezone, slots });
});

router.post('/appointments', bookingLimiter, async (req, res, next) => {
  try {
    const appointment = await createAppointment(req.body || {});
    // The meeting token is deliberately not returned here: the link is only
    // delivered by email/WhatsApp shortly before the slot (Section 5.4).
    res.status(201).json({
      message: 'Appointment confirmed.',
      appointment: {
        id: appointment.id,
        patient_name: appointment.patient_name,
        doctor_name: appointment.doctor_name,
        slot_start: appointment.slot_start,
        slot_end: appointment.slot_end,
        appointment_date: appointment.appointment_date,
        appointment_time: appointment.appointment_time,
        status: appointment.status,
      },
      notice: `Your meeting link will be sent by email and WhatsApp ${config.reminderLeadMinutes} minutes before your appointment.`,
    });
  } catch (error) {
    next(error);
  }
});

/** Patients check their own appointment with the token from their link. */
router.get('/appointments/:token', async (req, res) => {
  const result = await resolveMeetingToken(req.params.token);
  if (!result.ok && !result.appointment) {
    return res.status(404).json({ message: result.message, reason: result.reason });
  }

  const appointment = result.appointment;
  return res.json({
    joinable: result.ok,
    reason: result.reason || null,
    message: result.message || null,
    opensAt: result.opensAt || null,
    appointment: {
      patient_name: appointment.patient_name,
      doctor_name: appointment.doctor_name,
      slot_start: appointment.slot_start,
      status: appointment.status,
      payment_status: appointment.payment_status,
    },
  });
});

// ------------------------------------------------------------- reviews

/** Only approved reviews are ever public. */
router.get('/reviews', async (_req, res) => {
  res.json(
    await all(
      `SELECT id, patient_name, doctor_id, doctor_name, rating, message, created_at
         FROM reviews WHERE status = 'approved' ORDER BY id DESC`,
    ),
  );
});

/**
 * The review form is reachable only through the one-time link sent after a
 * completed consultation. This endpoint tells the page whose appointment it
 * is, so the patient sees "How was your consultation with Dr X?" rather than
 * an anonymous form.
 */
router.get('/reviews/invite/:token', async (req, res) => {
  const result = await resolveReviewInvite(req.params.token);
  if (!result.ok) return res.status(400).json({ message: result.message });

  const { appointment } = result;
  return res.json({
    patient_name: appointment.patient_name,
    doctor_name: appointment.doctor_name,
    doctor_id: appointment.doctor_id,
    appointment_date: appointment.appointment_date,
  });
});

router.post('/reviews/invite/:token', bookingLimiter, async (req, res) => {
  const result = await resolveReviewInvite(req.params.token);
  if (!result.ok) return res.status(400).json({ message: result.message });

  const { appointment, invite } = result;
  const { rating, message } = req.body || {};

  const score = Number(rating);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ message: 'Please choose a rating between 1 and 5 stars.' });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ message: 'Please tell us a little about your visit.' });
  }

  // The patient's name comes from the appointment, not the form — one less
  // field to fill in, and it cannot be used to impersonate someone else.
  try {
    await run(
      `INSERT INTO reviews (patient_name, doctor_id, doctor_name, rating, message, appointment_id, status, submitted_ip)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        appointment.patient_name,
        appointment.doctor_id || null,
        appointment.doctor_name || 'Clinic Team',
        score,
        String(message).trim().slice(0, 2000),
        appointment.id,
        (req.ip || '').slice(0, 60),
      ],
    );
  } catch {
    return res.status(409).json({ message: 'A review for this appointment has already been submitted.' });
  }

  await markInviteUsed(invite.id);

  return res.status(201).json({
    message: 'Thank you. Our team will review your feedback before it appears on the website.',
  });
});

export default router;
export { BookingError };
