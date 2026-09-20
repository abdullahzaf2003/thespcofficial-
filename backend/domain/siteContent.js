/**
 * Every piece of text on the public website that staff can edit.
 *
 * This list is the single source of truth for three things at once: the seed
 * defaults, the validation on `PUT /api/admin/site-content`, and the form the
 * dashboard renders. Adding an editable field means adding one entry here —
 * the dashboard grows the input by itself, so nobody has to touch React to let
 * the clinic reword a heading.
 *
 * `group` drives the section headings in the dashboard; `type` picks the input
 * control. Keys are also the `clinic_info` primary keys, so they are stable.
 */

export const SITE_FIELDS = [
  // ------------------------------------------------------------ identity
  { key: 'clinic_name', label: 'Clinic name', group: 'Clinic details', type: 'text', max: 120 },
  { key: 'clinic_subtitle', label: 'Subtitle under the name', group: 'Clinic details', type: 'text', max: 160 },
  { key: 'tagline', label: 'Tagline', group: 'Clinic details', type: 'text', max: 160, hint: 'Small line above the main heading.' },

  // --------------------------------------------------------------- hero
  { key: 'hero_title_line_1', label: 'Headline — line 1', group: 'Home page banner', type: 'text', max: 80 },
  { key: 'hero_title_line_2', label: 'Headline — line 2', group: 'Home page banner', type: 'text', max: 80 },
  { key: 'hero_title_line_3', label: 'Headline — line 3 (highlighted)', group: 'Home page banner', type: 'text', max: 80 },
  { key: 'hero_intro', label: 'Introduction paragraph', group: 'Home page banner', type: 'textarea', max: 800 },
  { key: 'hero_primary_cta', label: 'Main button text', group: 'Home page banner', type: 'text', max: 40 },
  { key: 'hero_secondary_cta', label: 'Second button text', group: 'Home page banner', type: 'text', max: 40 },

  // ----------------------------------------------------------- sections
  { key: 'services_eyebrow', label: 'Services — small label above', group: 'Section headings', type: 'text', max: 60 },
  { key: 'services_heading', label: 'Services heading', group: 'Section headings', type: 'text', max: 120 },
  { key: 'services_intro', label: 'Services intro', group: 'Section headings', type: 'textarea', max: 400 },
  { key: 'doctors_eyebrow', label: 'Doctors — small label above', group: 'Section headings', type: 'text', max: 60 },
  { key: 'doctors_heading', label: 'Doctors heading', group: 'Section headings', type: 'text', max: 160 },
  { key: 'doctors_intro', label: 'Doctors intro', group: 'Section headings', type: 'textarea', max: 400 },
  { key: 'booking_heading', label: 'Booking heading', group: 'Section headings', type: 'text', max: 120 },
  { key: 'booking_intro', label: 'Booking intro', group: 'Section headings', type: 'textarea', max: 400 },
  { key: 'reviews_heading', label: 'Reviews heading', group: 'Section headings', type: 'text', max: 120 },
  { key: 'reviews_intro', label: 'Reviews intro', group: 'Section headings', type: 'textarea', max: 400 },
  { key: 'contact_heading', label: 'Contact heading', group: 'Section headings', type: 'text', max: 120 },
  { key: 'contact_intro', label: 'Contact intro', group: 'Section headings', type: 'textarea', max: 400 },

  // -------------------------------------------------- why patients choose us
  { key: 'why_choose_title', label: 'Heading', group: 'Why patients choose us', type: 'text', max: 120 },
  { key: 'experience_quote', label: 'Pull quote', group: 'Why patients choose us', type: 'text', max: 80, hint: 'The short bold line, e.g. "Experienced Care."' },
  { key: 'why_choose_description', label: 'Paragraph', group: 'Why patients choose us', type: 'textarea', max: 800 },
  { key: 'about_body', label: 'About the clinic', group: 'Why patients choose us', type: 'textarea', max: 1600, hint: 'The longer description used on the about block and for search engines.' },
  { key: 'location_badge', label: 'Location badge', group: 'Why patients choose us', type: 'text', max: 60 },

  // -------------------------------------------------------------- stats
  { key: 'stat_1_value', label: 'Stat 1 — number', group: 'Clinic figures', type: 'text', max: 20 },
  { key: 'stat_1_label', label: 'Stat 1 — caption', group: 'Clinic figures', type: 'text', max: 60 },
  { key: 'stat_2_value', label: 'Stat 2 — number', group: 'Clinic figures', type: 'text', max: 20 },
  { key: 'stat_2_label', label: 'Stat 2 — caption', group: 'Clinic figures', type: 'text', max: 60 },
  { key: 'stat_3_value', label: 'Stat 3 — number', group: 'Clinic figures', type: 'text', max: 20 },
  { key: 'stat_3_label', label: 'Stat 3 — caption', group: 'Clinic figures', type: 'text', max: 60 },

  // ---------------------------------------------------------- emergency
  { key: 'emergency_title', label: 'Emergency heading', group: 'Emergency banner', type: 'text', max: 120 },
  { key: 'emergency_description', label: 'Emergency text', group: 'Emergency banner', type: 'textarea', max: 400 },

  // ------------------------------------------------------------- FAQ
  { key: 'faq_heading', label: 'FAQ heading', group: 'Questions & answers', type: 'text', max: 120 },
  { key: 'faq_intro', label: 'FAQ intro', group: 'Questions & answers', type: 'textarea', max: 400, hint: 'The questions themselves are edited on the FAQ tab.' },

  // ------------------------------------------------------------ contact
  { key: 'address', label: 'Street address', group: 'Contact details', type: 'text', max: 240 },
  { key: 'location', label: 'Area (short)', group: 'Contact details', type: 'text', max: 120 },
  { key: 'phone_primary', label: 'Phone', group: 'Contact details', type: 'text', max: 40 },
  { key: 'phone_secondary', label: 'Second phone', group: 'Contact details', type: 'text', max: 40 },
  { key: 'whatsapp_number', label: 'WhatsApp number', group: 'Contact details', type: 'text', max: 40, hint: 'Country code, no + or spaces. e.g. 923084213201' },
  { key: 'email_public', label: 'Public email address', group: 'Contact details', type: 'text', max: 160 },
  { key: 'maps_url', label: 'Google Maps link', group: 'Contact details', type: 'text', max: 500 },

  // -------------------------------------------------------------- hours
  { key: 'opening_hours', label: 'Opening hours', group: 'Hours & fees', type: 'text', max: 160 },
  { key: 'calling_hours', label: 'Phone hours', group: 'Hours & fees', type: 'text', max: 160 },
  { key: 'consultation_fee', label: 'Consultation fee (number only)', group: 'Hours & fees', type: 'text', max: 20 },
  { key: 'currency', label: 'Currency', group: 'Hours & fees', type: 'text', max: 10 },

  // ---------------------------------------------------------------- SEO
  { key: 'seo_title', label: 'Browser tab / search title', group: 'Search engines', type: 'text', max: 160 },
  { key: 'seo_description', label: 'Search result description', group: 'Search engines', type: 'textarea', max: 320 },

  // ------------------------------------------------------------- footer
  { key: 'footer_note', label: 'Footer note', group: 'Footer', type: 'textarea', max: 400 },
];

export const SITE_FIELD_MAP = new Map(SITE_FIELDS.map((field) => [field.key, field]));

/**
 * Keys that exist in `clinic_info` but are not free text the admin should be
 * retyping — they are set by configuration, not by the content editor.
 */
export const RESERVED_KEYS = new Set(['timezone']);

/**
 * Validates a partial update. Returns `{ values, errors }`: unknown keys are
 * rejected rather than silently stored, so the table cannot be used as an
 * arbitrary key-value dump by a compromised admin session.
 */
export function validateSiteContent(body) {
  const values = {};
  const errors = [];

  for (const [key, raw] of Object.entries(body || {})) {
    const field = SITE_FIELD_MAP.get(key);
    if (!field) {
      errors.push(`"${key}" is not an editable field.`);
      continue;
    }

    const value = String(raw ?? '').trim();
    if (value.length > field.max) {
      errors.push(`${field.label} must be ${field.max} characters or fewer.`);
      continue;
    }
    values[key] = value;
  }

  return { values, errors };
}

/**
 * Seed defaults.
 *
 * This is the clinic's own copy, taken from `docs/site-content.xlsx` and
 * `docs/clinic-content.md` — not invented placeholder text. It is inserted
 * only where a key does not already exist, so once the clinic edits a line in
 * the dashboard no deploy will ever overwrite it.
 */
export const SITE_DEFAULTS = {
  tagline: 'Verified specialists • 24/7 emergency care',

  hero_title_line_1: 'Trusted Surgical',
  hero_title_line_2: '& ENT Care in',
  hero_title_line_3: 'Lahore',
  hero_intro:
    'Surgeons Poly Clinic is a small multi-specialty medical centre in Model Town, Lahore, focused on General Surgery and ENT care with experienced doctors, transparent consultation fees, and emergency support available around the clock.',
  hero_primary_cta: 'Book Appointment',
  hero_secondary_cta: 'Call 042-34500888',

  services_eyebrow: 'Clinics & Specialties',
  services_heading: 'Complete Surgical & ENT Services',
  services_intro:
    'Surgeons Poly Clinic offers a focused range of surgical and ENT services, including general surgery, breast health care, thyroid and neck evaluation, sinus and hearing treatment, and routine minor procedures.',

  doctors_eyebrow: 'Most Experienced Doctors',
  doctors_heading: 'Most Experienced Doctors in Surgeons Poly Clinic — Lahore',
  doctors_intro: '',

  booking_heading: 'Book a consultation',
  booking_intro:
    'Choose a doctor and a time. Available slots come from each doctor\u2019s own working hours, so anything you can see is genuinely bookable.',

  reviews_heading: 'What our patients say',
  reviews_intro: 'Reviews from patients who completed a consultation with us.',

  why_choose_title: 'Why Patients Choose Us',
  experience_quote: 'Experienced Care.',
  why_choose_description:
    'Surgeons Poly Clinic provides focused surgical and ENT care in a compact multi-specialty setting, with verified specialists, transparent consultation rates, and emergency coverage available 24/7.',
  about_body:
    'Surgeons Poly Clinic & Medical Centre is a small multi-specialty medical clinic located in the heart of Lahore. It currently practices two active doctors with specialties in General Surgery and ENT. The clinic remains open 24/7 for emergency care, while individual consultation timings vary by doctor.',
  location_badge: 'Model Town, Lahore',

  stat_1_value: '2',
  stat_1_label: 'Active doctors',
  stat_2_value: '18+',
  stat_2_label: 'Years experience',
  stat_3_value: '24/7',
  stat_3_label: 'Emergency access',

  emergency_title: 'Emergency access',
  emergency_description: 'Open 24/7 for emergency cases and immediate surgical support.',

  faq_heading: 'Questions patients ask',
  faq_intro: '',

  contact_heading: 'Get in Touch',
  contact_intro: 'We are open 24/7 for emergencies. Call ahead to confirm doctor availability and consultation timing.',

  email_public: '',
  maps_url: 'https://maps.google.com/?q=422+Block+Q+Model+Town+Lahore',

  seo_title: 'Surgeons Poly Clinic — General Surgery & ENT Care in Model Town, Lahore',
  seo_description:
    'Book a consultation with experienced general surgeons and ENT specialists in Model Town, Lahore. Transparent Rs. 3,000 consultation fee, online video consultations, and 24/7 emergency support.',

  footer_note: 'Surgeons Poly Clinic, 422 Block Q, Model Town, Lahore. Open 24/7 for emergencies.',
};
