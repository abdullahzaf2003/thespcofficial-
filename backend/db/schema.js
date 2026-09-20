import { run, all, get } from './sqlite.js';

/**
 * Idempotent schema setup.
 *
 * The repo ships an existing clinic.db, so every change here is additive:
 * CREATE TABLE IF NOT EXISTS for new entities, and ALTER TABLE ADD COLUMN
 * (guarded by a PRAGMA lookup) for tables that already hold data.
 *
 * All timestamps are ISO-8601 UTC strings. They sort lexicographically, which
 * is what the slot and reminder queries rely on.
 */

async function columnNames(table) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function addColumns(table, definitions) {
  const existing = await columnNames(table);
  for (const [name, definition] of Object.entries(definitions)) {
    if (existing.has(name)) continue;
    await run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export async function migrate() {
  // ---------------------------------------------------------------- staff
  await run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumns('admin_users', {
    name: "TEXT DEFAULT ''",
    role: "TEXT DEFAULT 'admin'", // admin | receptionist
    status: "TEXT DEFAULT 'active'",
  });

  // -------------------------------------------------------------- doctors
  await run(`
    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      specialty TEXT,
      qualifications TEXT,
      image TEXT,
      bio TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumns('doctors', {
    username: 'TEXT',
    password_hash: 'TEXT',
    socket_room_id: 'TEXT',
    consultation_fee: 'INTEGER DEFAULT 3000',
    currency: "TEXT DEFAULT 'PKR'",
    languages: "TEXT DEFAULT 'English, Urdu'",
    years_experience: 'INTEGER DEFAULT 0',
    slot_duration_minutes: 'INTEGER DEFAULT 20',
    status: "TEXT DEFAULT 'active'",
    updated_at: 'TEXT',
    // Profile detail shown on the public cards, from docs/site-content.xlsx.
    verification: "TEXT DEFAULT ''",   // e.g. "PMC Verified"
    wait_time: "TEXT DEFAULT ''",      // e.g. "15-30 Min"
    timing_note: "TEXT DEFAULT ''",    // human-readable clinic hours
    tags: "TEXT DEFAULT ''",           // pipe-separated areas of care
    rating: "TEXT DEFAULT ''",         // see the note in seed.js before displaying
    reviews_note: "TEXT DEFAULT ''",
  });
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_doctors_username ON doctors(username) WHERE username IS NOT NULL');
  await run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_doctors_room ON doctors(socket_room_id) WHERE socket_room_id IS NOT NULL',
  );

  // Recurring weekly working hours. weekday: 0 = Sunday .. 6 = Saturday.
  await run(`
    CREATE TABLE IF NOT EXISTS doctor_availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      enabled INTEGER DEFAULT 1
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_availability_doctor ON doctor_availability(doctor_id, weekday)');

  // One-off changes: holidays (kind='closed') or replacement hours (kind='custom').
  await run(`
    CREATE TABLE IF NOT EXISTS doctor_date_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'closed',
      start_time TEXT,
      end_time TEXT,
      reason TEXT
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_overrides_doctor_date ON doctor_date_overrides(doctor_id, date)');

  // ------------------------------------------------------------- services
  await run(`
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      description TEXT,
      category TEXT,
      icon TEXT,
      image TEXT,
      price INTEGER DEFAULT 0,
      currency TEXT DEFAULT 'PKR',
      duration_minutes INTEGER DEFAULT 20,
      status TEXT DEFAULT 'active',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS doctor_services (
      doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      price_override INTEGER,
      PRIMARY KEY (doctor_id, service_id)
    )
  `);

  // ---------------------------------------------------------- slot holds
  // Materialised only while a patient is filling in the booking form (3.2).
  await run(`
    CREATE TABLE IF NOT EXISTS slot_holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      slot_start TEXT NOT NULL,
      slot_end TEXT NOT NULL,
      hold_token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_slot ON slot_holds(doctor_id, slot_start)');
  await run('CREATE INDEX IF NOT EXISTS idx_holds_expiry ON slot_holds(expires_at)');

  // --------------------------------------------------------- appointments
  await run(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      doctor_id INTEGER,
      doctor_name TEXT,
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL,
      note TEXT,
      meeting_link TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumns('appointments', {
    patient_whatsapp: "TEXT DEFAULT ''",
    service_id: 'INTEGER',
    slot_start: 'TEXT',
    slot_end: 'TEXT',
    payment_status: "TEXT DEFAULT 'unpaid'", // unpaid | pending_verification | verified
    meeting_token: 'TEXT',
    meeting_token_used_at: 'TEXT',
    reminder_sent_at: 'TEXT',
    receptionist_notes: "TEXT DEFAULT ''",
    doctor_notes: "TEXT DEFAULT ''",
    current_room: 'TEXT',
    joined_at: 'TEXT',
    completed_at: 'TEXT',
    cancelled_at: 'TEXT',
    updated_at: 'TEXT',
  });
  await run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_token ON appointments(meeting_token) WHERE meeting_token IS NOT NULL',
  );
  // The double-booking guard (Section 12). Cancelled and no-show rows free the
  // slot again, which is why this index is partial rather than a table constraint.
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_slot
    ON appointments(doctor_id, slot_start)
    WHERE slot_start IS NOT NULL AND status NOT IN ('cancelled', 'no_show')
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_appointments_reminder ON appointments(slot_start, reminder_sent_at)');

  // --------------------------------------------------- notification outbox
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      template TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      status TEXT DEFAULT 'queued',
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_notifications_appointment ON notifications(appointment_id)');

  // ----------------------------------------------------------- job queue
  // Durable so a restart does not drop pending "5 minutes before" reminders.
  await run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      dedupe_key TEXT,
      run_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at)');

  // Dedupe means "at most one PENDING job per key". An earlier version of this
  // index covered every row, so a completed recurring sweep permanently blocked
  // its own rescheduling. Replace it if we find the old definition.
  const dedupeIndex = await get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_dedupe'");
  if (dedupeIndex && !String(dedupeIndex.sql).includes("status = 'pending'")) {
    await run('DROP INDEX idx_jobs_dedupe');
  }
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
    ON jobs(dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status = 'pending'
  `);

  // ------------------------------------------------------ refresh tokens
  await run(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_refresh_subject ON refresh_tokens(subject_type, subject_id)');
  // Device fields exist so the dashboard can show a doctor "you are signed in
  // on 2 devices" and revoke one, which is the safety valve that makes the
  // 30-day doctor session acceptable.
  await addColumns('refresh_tokens', {
    user_agent: "TEXT DEFAULT ''",
    ip: "TEXT DEFAULT ''",
    device_label: "TEXT DEFAULT ''",
    last_used_at: 'TEXT',
    // Every rotation of one login keeps the same family id. Reuse of an
    // already-rotated token means the cookie was stolen, and kills the family.
    family_id: 'TEXT',
  });
  await run('CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id)');

  // -------------------------------------------------------- clinic config
  await run(`
    CREATE TABLE IF NOT EXISTS clinic_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    )
  `);

  // ------------------------------------------------- pre-existing content
  await run(`
    CREATE TABLE IF NOT EXISTS blogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      excerpt TEXT,
      content TEXT,
      image TEXT,
      author TEXT DEFAULT 'Admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumns('blogs', {
    slug: 'TEXT',
    status: "TEXT DEFAULT 'published'",
    tags: "TEXT DEFAULT ''",
    seo_title: "TEXT DEFAULT ''",
    seo_description: "TEXT DEFAULT ''",
    published_at: 'TEXT',
  });

  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_name TEXT NOT NULL,
      doctor_id INTEGER,
      doctor_name TEXT,
      rating INTEGER NOT NULL,
      message TEXT NOT NULL,
      appointment_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Reviews are invite-only and moderated: a review exists because a real
  // appointment completed, and it is public only once staff approve it.
  await addColumns('reviews', {
    status: "TEXT DEFAULT 'pending'", // pending | approved | rejected
    moderated_at: 'TEXT',
    moderated_by: 'TEXT',
    submitted_ip: "TEXT DEFAULT ''",
  });
  // One review per appointment — the invite is single-use by construction.
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_appointment
    ON reviews(appointment_id)
    WHERE appointment_id IS NOT NULL
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)');

  // Rows that predate moderation were already on the public site, so leaving
  // them 'pending' would silently delete content the clinic can see today.
  await run("UPDATE reviews SET status = 'approved' WHERE status IS NULL OR status = ''");

  // The invitation a patient receives after a completed consultation.
  await run(`
    CREATE TABLE IF NOT EXISTS review_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_review_invites_appointment ON review_invites(appointment_id)');

  // Frequently asked questions. Repeating structured content, so a table
  // rather than another clinic_info key — the dashboard edits these as rows.
  await run(`
    CREATE TABLE IF NOT EXISTS faqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_faqs_order ON faqs(enabled, sort_order)');

  await run(`
    CREATE TABLE IF NOT EXISTS site_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      title TEXT,
      content TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
