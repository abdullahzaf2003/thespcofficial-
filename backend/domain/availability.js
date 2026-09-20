import { all, get, run } from '../db/sqlite.js';
import { config } from '../config.js';

/**
 * Slot generation (Section 3.2).
 *
 * Slots are never pre-materialised. They are computed per request from the
 * doctor's weekly template plus date overrides, minus anything already booked
 * or currently held. Only a `slot_holds` row is ever written, and only when a
 * patient starts the booking form.
 */

// --------------------------------------------------------------- timezone

/** Milliseconds to add to a UTC instant to get wall-clock time in `timeZone`. */
function zoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** "2026-09-18" + "18:00" in clinic time -> UTC Date. */
export function clinicTimeToUtc(dateStr, timeStr, timeZone = config.clinicTimezone) {
  const naive = new Date(`${dateStr}T${timeStr.padStart(5, '0')}:00Z`);
  // Two passes so the offset is sampled on the correct side of a DST change.
  const firstPass = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  return new Date(naive.getTime() - zoneOffsetMs(firstPass, timeZone));
}

/** Weekday (0 = Sunday) of a clinic-local calendar date. */
export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** UTC instant -> "HH:MM" in clinic time, for display. */
export function utcToClinicTime(iso, timeZone = config.clinicTimezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** UTC instant -> "YYYY-MM-DD" in clinic time. */
export function utcToClinicDate(iso, timeZone = config.clinicTimezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return parts;
}

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number);
  return hours * 60 + minutes;
};

const toTimeString = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// ------------------------------------------------------------- generation

/**
 * Returns the working windows for a doctor on a clinic-local date, after
 * applying date overrides. An empty array means the doctor is not working.
 */
export async function workingWindowsFor(doctorId, dateStr) {
  const overrides = await all('SELECT * FROM doctor_date_overrides WHERE doctor_id = ? AND date = ?', [
    doctorId,
    dateStr,
  ]);

  if (overrides.some((override) => override.kind === 'closed')) return [];

  const custom = overrides.filter((override) => override.kind === 'custom' && override.start_time && override.end_time);
  if (custom.length) {
    return custom.map((override) => ({ start_time: override.start_time, end_time: override.end_time }));
  }

  return all('SELECT start_time, end_time FROM doctor_availability WHERE doctor_id = ? AND weekday = ? AND enabled = 1', [
    doctorId,
    weekdayOf(dateStr),
  ]);
}

/**
 * Computes bookable slots for one doctor on one clinic-local date.
 * Past slots are dropped, so this is always safe to expose publicly.
 */
export async function generateSlots(doctorId, dateStr, { includeUnavailable = true } = {}) {
  const doctor = await get('SELECT id, slot_duration_minutes, status FROM doctors WHERE id = ?', [doctorId]);
  if (!doctor || doctor.status === 'inactive') return [];

  const step = Number(doctor.slot_duration_minutes) || 20;
  const windows = await workingWindowsFor(doctorId, dateStr);
  if (!windows.length) return [];

  const nowIso = new Date().toISOString();

  const [booked, held] = await Promise.all([
    all(
      `SELECT slot_start FROM appointments
       WHERE doctor_id = ? AND slot_start IS NOT NULL AND status NOT IN ('cancelled', 'no_show')`,
      [doctorId],
    ),
    all('SELECT slot_start FROM slot_holds WHERE doctor_id = ? AND expires_at > ?', [doctorId, nowIso]),
  ]);

  const taken = new Set([...booked, ...held].map((row) => row.slot_start));

  const slots = [];
  for (const window of windows) {
    const from = toMinutes(window.start_time);
    const to = toMinutes(window.end_time);

    for (let minute = from; minute + step <= to; minute += step) {
      const start = clinicTimeToUtc(dateStr, toTimeString(minute));
      const end = clinicTimeToUtc(dateStr, toTimeString(minute + step));
      const startIso = start.toISOString();

      if (start.getTime() <= Date.now()) continue; // future slots only

      const available = !taken.has(startIso);
      if (!available && !includeUnavailable) continue;

      slots.push({
        start: startIso,
        end: end.toISOString(),
        time: toTimeString(minute),
        available,
      });
    }
  }

  return slots.sort((a, b) => a.start.localeCompare(b.start));
}

/** True when `slotStart` is a real slot boundary inside the doctor's hours. */
export async function isValidSlot(doctorId, slotStartIso) {
  const dateStr = utcToClinicDate(slotStartIso);
  const slots = await generateSlots(doctorId, dateStr);
  return slots.some((slot) => slot.start === slotStartIso);
}

// ----------------------------------------------------------------- holds

export async function releaseExpiredHolds() {
  const { changes } = await run('DELETE FROM slot_holds WHERE expires_at <= ?', [new Date().toISOString()]);
  if (changes) console.log(`[holds] released ${changes} expired hold(s)`);
  return changes;
}
