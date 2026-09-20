import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { run, all, get } from './sqlite.js';
import { config } from '../config.js';
import { SITE_DEFAULTS } from '../domain/siteContent.js';

/**
 * Seeds only what is missing. Safe to run on every boot, and safe to run
 * against the clinic.db that already ships in the repo.
 *
 * Content values come from src/imports/pasted_text/surgeons-poly-clinic-content.md.
 */

const CLINIC_INFO = {
  clinic_name: 'Surgeons Poly Clinic',
  clinic_subtitle: 'Model Town, Lahore • Open 24/7',
  address: '422, Block Q, Model Town, Lahore',
  location: 'Model Town, Lahore',
  phone_primary: '042-34500888',
  phone_secondary: '042-38900939',
  whatsapp_number: '923084213201',
  calling_hours: 'Mon–Sun, 9:00 AM to 11:00 PM',
  opening_hours: 'Open 24/7',
  consultation_fee: '3000',
  currency: 'PKR',
  timezone: config.clinicTimezone,
  // Every editable heading and paragraph on the public site. These are only
  // ever inserted when missing, so once the clinic edits a line in the
  // dashboard a redeploy never overwrites it.
  ...SITE_DEFAULTS,
};

const SERVICES = [
  {
    name: 'General Surgery',
    slug: 'general-surgery',
    description: 'Hernia, appendicitis, lumps, gallbladder, and soft tissue surgical care.',
    category: 'Surgical',
    icon: 'sparkle',
    sort_order: 1,
  },
  {
    name: 'Breast Surgery',
    slug: 'breast-surgery',
    description: 'Breast lump evaluation, surgical review, and female breast health support.',
    category: 'Surgical',
    icon: 'heart',
    sort_order: 2,
  },
  {
    name: 'ENT Care',
    slug: 'ent-care',
    description: 'Sinus treatment, hearing issues, tonsils, throat infection, and nasal problems.',
    category: 'ENT',
    icon: 'circle',
    sort_order: 3,
  },
  {
    name: 'Thyroid & Neck',
    slug: 'thyroid-neck',
    description: 'Swollen glands, thyroid assessment, and neck-related surgical referral care.',
    category: 'Surgical',
    icon: 'sparkle',
    sort_order: 4,
  },
  {
    name: 'Minor Procedures',
    slug: 'minor-procedures',
    description: 'Biopsies, cyst removal, skin lesions, and wound/diagnostic procedure care.',
    category: 'Procedures',
    icon: 'diamond',
    sort_order: 5,
  },
];

/** The clinic's own questions and answers, from docs/site-content.xlsx. */
const FAQS = [
  {
    question: 'Do you offer emergency consultation?',
    answer: 'Yes. The clinic remains open 24/7 and emergency support is available around the clock.',
  },
  {
    question: 'How do I book an appointment?',
    answer:
      'You can book online here on the website, or call 042-34500888 or 042-38900939 to confirm doctor availability and consultation timing.',
  },
  {
    question: 'What is the standard consultation fee?',
    answer: 'The standard consultation fee is Rs. 3,000.',
  },
  {
    question: 'How does the online video consultation work?',
    answer:
      'After you book, you receive a confirmation straight away. Your video link arrives by email and WhatsApp shortly before your appointment. You join our reception first, who verify your payment, and they then connect you to your doctor.',
  },
];

// Working hours per doctor, applied Monday (1) through Saturday (6).
const DOCTOR_DEFAULTS = {
  'Asst. Prof. Dr. Ayesha Choudary': {
    username: 'dr.ayesha',
    // docs/site-content.xlsx lists "Mon–Sat • 7:00 PM – 9:00 PM".
    start_time: '19:00',
    end_time: '21:00',
    years_experience: 18,
    // Served from frontend/public/doctors/.
    photo: '/doctors/ayesha-choudary.webp',
    services: ['general-surgery', 'breast-surgery', 'thyroid-neck', 'minor-procedures'],
    verification: 'PMC Verified',
    wait_time: '15–30 Min',
    timing_note: 'Mon–Sat • 7:00 PM – 9:00 PM',
    tags: 'General Surgery|Breast Care|ENT',
  },
  'Dr. Zafar Iqbal': {
    username: 'dr.zafar',
    // The content pack says only "By Appointment" for this doctor, which is
    // not a bookable window. These hours are a placeholder so the doctor is
    // reachable at all — confirm them with the clinic before launch.
    start_time: '17:00',
    end_time: '20:00',
    years_experience: 22,
    photo: '/doctors/zafar-iqbal.webp',
    services: ['ent-care', 'minor-procedures'],
    verification: 'PMC Verified',
    wait_time: 'Under 15 Min',
    timing_note: 'By Appointment',
    tags: 'ENT Care|Sinus|Hearing',
  },
};

async function seedStaff() {
  const staff = [
    { email: config.seedAdminEmail, password: config.seedAdminPassword, name: 'Clinic Admin', role: 'admin' },
    {
      email: config.seedReceptionEmail,
      password: config.seedReceptionPassword,
      name: 'Front Desk',
      role: 'receptionist',
    },
  ];

  for (const person of staff) {
    const email = person.email.trim().toLowerCase();
    const existing = await get('SELECT id, role FROM admin_users WHERE email = ?', [email]);
    if (existing) {
      // Backfill role/name on rows created by the previous schema.
      if (!existing.role) {
        await run('UPDATE admin_users SET role = ?, name = ? WHERE id = ?', [person.role, person.name, existing.id]);
      }
      continue;
    }
    await run('INSERT INTO admin_users (email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?)', [
      email,
      bcrypt.hashSync(person.password, 10),
      person.name,
      person.role,
      'active',
    ]);
    console.log(`[seed] created ${person.role}: ${email}`);
  }
}

async function seedDoctors() {
  const count = await get('SELECT COUNT(*) AS total FROM doctors');
  if (!count || Number(count.total) === 0) {
    await run(
      `INSERT INTO doctors (name, specialty, qualifications, image, bio, enabled)
       VALUES (?, ?, ?, ?, ?, 1), (?, ?, ?, ?, ?, 1)`,
      [
        'Asst. Prof. Dr. Ayesha Choudary',
        'General Surgeon • Breast Surgeon',
        'M.B.B.S. Punjab University (1996) · F.C.P.S. Surgery (2004)',
        '',
        'Experienced general and breast surgeon focused on patient-reassuring, evidence-based care.',
        'Dr. Zafar Iqbal',
        'ENT Specialist • ENT Surgeon',
        'MBBS · FCPS ENT',
        '',
        'ENT specialist helping patients with sinus, hearing, throat, and breathing concerns.',
      ],
    );
  }

  const doctors = await all('SELECT * FROM doctors');

  for (const doctor of doctors) {
    const defaults = DOCTOR_DEFAULTS[doctor.name];
    const updates = {};

    if (!doctor.socket_room_id) {
      // Stable per-doctor room id. Persistent across days by design (8.1).
      updates.socket_room_id = `doctor-${doctor.id}-${crypto.randomBytes(6).toString('hex')}`;
    }
    if (!doctor.username && defaults) updates.username = defaults.username;
    if (!doctor.password_hash) updates.password_hash = bcrypt.hashSync(config.seedDoctorPassword, 10);
    if (!doctor.years_experience && defaults) updates.years_experience = defaults.years_experience;
    if (!doctor.status) updates.status = 'active';

    // Profile detail from the clinic's content pack. Each is filled only when
    // empty, so anything the admin has typed in the dashboard wins.
    //
    // Deliberately NOT seeded: the star rating and review count that appear in
    // the content pack ("4.6 · 534 reviews", "99% Patient Satisfaction"). Those
    // came from a third-party directory listing, and publishing them next to
    // this clinic's own verified, moderated reviews would present numbers the
    // clinic cannot evidence. The columns exist and are editable if the clinic
    // decides it wants them.
    for (const field of ['verification', 'wait_time', 'timing_note', 'tags']) {
      if (defaults?.[field] && !doctor[field]) updates[field] = defaults[field];
    }

    // Replace the placeholder stock photos with the clinic's real ones. An
    // image the admin has set themselves is left alone.
    if (defaults?.photo && (!doctor.image || doctor.image.includes('unsplash.com'))) {
      updates.image = defaults.photo;
    }

    const keys = Object.keys(updates);
    if (keys.length) {
      await run(
        `UPDATE doctors SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((key) => updates[key]), doctor.id],
      );
    }

    const hasAvailability = await get('SELECT id FROM doctor_availability WHERE doctor_id = ?', [doctor.id]);
    if (!hasAvailability) {
      const window = defaults || { start_time: '18:00', end_time: '21:00' };
      for (let weekday = 1; weekday <= 6; weekday += 1) {
        await run(
          'INSERT INTO doctor_availability (doctor_id, weekday, start_time, end_time, enabled) VALUES (?, ?, ?, ?, 1)',
          [doctor.id, weekday, window.start_time, window.end_time],
        );
      }
    }
  }
}

async function seedServices() {
  for (const service of SERVICES) {
    const existing = await get('SELECT id FROM services WHERE slug = ?', [service.slug]);
    if (existing) continue;
    await run(
      `INSERT INTO services (name, slug, description, category, icon, price, currency, duration_minutes, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        service.name,
        service.slug,
        service.description,
        service.category,
        service.icon,
        3000,
        'PKR',
        20,
        service.sort_order,
      ],
    );
  }

  // Link doctors to the services they offer.
  for (const [doctorName, defaults] of Object.entries(DOCTOR_DEFAULTS)) {
    const doctor = await get('SELECT id FROM doctors WHERE name = ?', [doctorName]);
    if (!doctor) continue;
    for (const slug of defaults.services) {
      const service = await get('SELECT id FROM services WHERE slug = ?', [slug]);
      if (!service) continue;
      await run('INSERT OR IGNORE INTO doctor_services (doctor_id, service_id) VALUES (?, ?)', [
        doctor.id,
        service.id,
      ]);
    }
  }
}

async function seedFaqs() {
  // Only seeds an empty table: once the clinic edits or removes a question,
  // a redeploy must not bring it back.
  const count = await get('SELECT COUNT(*) AS total FROM faqs');
  if (count && Number(count.total) > 0) return;

  for (const [index, faq] of FAQS.entries()) {
    await run('INSERT INTO faqs (question, answer, sort_order, enabled) VALUES (?, ?, ?, 1)', [
      faq.question,
      faq.answer,
      index + 1,
    ]);
  }
  console.log(`[seed] created ${FAQS.length} FAQ entries`);
}

async function seedClinicInfo() {
  for (const [key, value] of Object.entries(CLINIC_INFO)) {
    await run('INSERT OR IGNORE INTO clinic_info (key, value, updated_at) VALUES (?, ?, ?)', [
      key,
      value,
      new Date().toISOString(),
    ]);
  }
}

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Posts created before the blog gained slugs and a draft/publish workflow. */
async function backfillBlogPosts() {
  const posts = await all('SELECT id, title, slug, status, published_at, created_at FROM blogs');

  for (const post of posts) {
    const updates = {};
    if (!post.slug) updates.slug = `${slugify(post.title)}-${post.id}`;
    if (!post.status) updates.status = 'published';
    if (!post.published_at) updates.published_at = post.created_at || new Date().toISOString();

    const keys = Object.keys(updates);
    if (!keys.length) continue;
    await run(`UPDATE blogs SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`, [
      ...keys.map((key) => updates[key]),
      post.id,
    ]);
  }
}

export async function seed() {
  await seedStaff();
  await seedDoctors();
  await seedServices();
  await seedClinicInfo();
  await seedFaqs();
  await backfillBlogPosts();
}
