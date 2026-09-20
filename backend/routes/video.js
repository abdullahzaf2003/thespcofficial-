import { Router } from 'express';
import { get } from '../db/sqlite.js';
import { resolveMeetingToken } from '../domain/tokens.js';
import { media } from '../adapters/media.js';
import { hub, RECEPTION_ROOM } from '../realtime/signaling.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * Patient join page bootstrap. No login (Section 9) — the signed token in the
 * URL is the entire credential, and it only works inside the appointment window.
 */
router.get('/video/session/:token', async (req, res) => {
  const result = await resolveMeetingToken(req.params.token);

  if (!result.ok) {
    return res.status(result.reason === 'too_early' ? 425 : 403).json({
      joinable: false,
      reason: result.reason,
      message: result.message,
      opensAt: result.opensAt || null,
    });
  }

  const appointment = result.appointment;
  const doctor = await get('SELECT id, name, specialty, image FROM doctors WHERE id = ?', [appointment.doctor_id]);

  return res.json({
    joinable: true,
    ...media.getJoinConfig(),
    appointment: {
      id: appointment.id,
      patient_name: appointment.patient_name,
      slot_start: appointment.slot_start,
      slot_end: appointment.slot_end,
      status: appointment.status,
      payment_status: appointment.payment_status,
    },
    doctor,
    // The patient always starts in reception, whatever the stored pointer says.
    room: RECEPTION_ROOM,
  });
});

/** Receptionist -> doctor handoff (Section 8.2). Also available over the socket. */
router.post('/handoff', requireAuth('admin', 'receptionist'), async (req, res) => {
  const appointmentId = Number(req.body?.appointmentId);
  const doctorId = Number(req.body?.doctorId);

  if (!Number.isInteger(appointmentId) || !Number.isInteger(doctorId)) {
    return res.status(400).json({ message: 'appointmentId and doctorId are required.' });
  }

  try {
    const result = await hub.handoff({ appointmentId, doctorId, byName: req.auth.name });
    return res.json({ message: 'Patient handed off.', ...result });
  } catch (error) {
    return res.status(409).json({ message: error.message });
  }
});

router.post('/appointments/:id/complete', requireAuth('admin', 'receptionist', 'doctor'), async (req, res) => {
  const appointmentId = Number(req.params.id);
  const appointment = await get('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
  if (!appointment) return res.status(404).json({ message: 'Appointment not found.' });

  // A doctor may only close their own consultations.
  if (req.auth.role === 'doctor' && appointment.doctor_id !== req.auth.id) {
    return res.status(403).json({ message: 'This appointment belongs to another doctor.' });
  }

  try {
    const updated = await hub.completeSession(appointmentId, { notes: req.body?.notes });
    return res.json({ message: 'Consultation completed.', appointment: updated });
  } catch (error) {
    return res.status(409).json({ message: error.message });
  }
});

router.get('/video/online-doctors', requireAuth('admin', 'receptionist'), (_req, res) => {
  res.json({ doctors: hub.onlineDoctors() });
});

export default router;
