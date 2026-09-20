import { Router } from 'express';
import { run, all, get } from '../db/sqlite.js';
import { requireAuth } from '../middleware/auth.js';
import { utcToClinicDate } from '../domain/availability.js';
import { hub } from '../realtime/signaling.js';

const router = Router();
const doctorOnly = requireAuth('doctor');

/**
 * Every query here is filtered by req.auth.id, so a doctor can only ever read
 * or write their own appointments (Section 9).
 */

router.get('/me', doctorOnly, async (req, res) => {
  const doctor = await get('SELECT * FROM doctors WHERE id = ?', [req.auth.id]);
  if (!doctor) return res.status(404).json({ message: 'Doctor not found.' });

  const { password_hash, ...safe } = doctor;
  const availability = await all(
    'SELECT weekday, start_time, end_time FROM doctor_availability WHERE doctor_id = ? AND enabled = 1 ORDER BY weekday',
    [doctor.id],
  );
  return res.json({ ...safe, availability, room: `doctor:${doctor.id}` });
});

router.get('/appointments', doctorOnly, async (req, res) => {
  const scope = String(req.query.scope || 'upcoming');
  const today = utcToClinicDate(new Date().toISOString());

  let sql = 'SELECT * FROM appointments WHERE doctor_id = ?';
  const params = [req.auth.id];

  if (scope === 'today') {
    sql += ' AND appointment_date = ?';
    params.push(today);
  } else if (scope === 'upcoming') {
    sql += " AND slot_start >= ? AND status NOT IN ('cancelled', 'completed', 'no_show')";
    params.push(new Date(Date.now() - 3600_000).toISOString());
  } else if (scope === 'completed') {
    sql += " AND status = 'completed'";
  }

  const appointments = await all(`${sql} ORDER BY slot_start ASC LIMIT 200`, params);
  // Doctors never need the patient's meeting token.
  res.json(appointments.map(({ meeting_token, ...rest }) => rest));
});

router.get('/appointments/:id', doctorOnly, async (req, res) => {
  const appointment = await get('SELECT * FROM appointments WHERE id = ? AND doctor_id = ?', [
    Number(req.params.id),
    req.auth.id,
  ]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  const { meeting_token, ...safe } = appointment;
  const history = await all(
    'SELECT id, appointment_date, appointment_time, status, doctor_notes FROM appointments WHERE email = ? AND id != ? ORDER BY slot_start DESC LIMIT 10',
    [appointment.email, appointment.id],
  );
  return res.json({ ...safe, history });
});

router.patch('/appointments/:id/notes', doctorOnly, async (req, res) => {
  const id = Number(req.params.id);
  const appointment = await get('SELECT id FROM appointments WHERE id = ? AND doctor_id = ?', [id, req.auth.id]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  await run('UPDATE appointments SET doctor_notes = ?, updated_at = ? WHERE id = ?', [
    String(req.body?.notes || '').slice(0, 10_000),
    new Date().toISOString(),
    id,
  ]);
  return res.json({ message: 'Notes saved.' });
});

router.patch('/appointments/:id/complete', doctorOnly, async (req, res) => {
  const id = Number(req.params.id);
  const appointment = await get('SELECT id FROM appointments WHERE id = ? AND doctor_id = ?', [id, req.auth.id]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  try {
    const updated = await hub.completeSession(id, { notes: req.body?.notes });
    const { meeting_token, ...safe } = updated;
    return res.json({ message: 'Consultation completed.', appointment: safe });
  } catch (error) {
    return res.status(409).json({ message: error.message });
  }
});

export default router;
