import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Authed, type Appointment } from '../../lib/api';
import { Button, Badge, Modal, Field, inputClass } from '../../components/ui';

/**
 * Appointment list with filters, the patient join link, and the desk actions
 * (resend, cancel).
 *
 * The join link is fetched per appointment on demand rather than arriving with
 * the list, because the token in it is the whole credential for joining that
 * patient's call.
 */

type Props = { authed: Authed; notify: (message: string) => void };

type MeetingLink = {
  link: string;
  opensAt: string;
  expiresAt: string;
  patientName: string;
};

const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' });

const STATUS_STYLES: Record<string, string> = {
  confirmed: 'bg-blue-100 text-blue-700',
  in_reception: 'bg-amber-100 text-amber-800',
  with_doctor: 'bg-soft text-brand',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
  no_show: 'bg-slate-200 text-slate-600',
  pending_payment: 'bg-orange-100 text-orange-700',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * navigator.clipboard needs a secure context, which rules it out on plain-HTTP
 * LAN addresses. Falls back to a hidden textarea so copying still works there.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}

function LinkRow({ link, onCopy }: { link: MeetingLink; onCopy: () => void }) {
  return (
    <div className="mt-2 rounded-xl bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          value={link.link}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={`Join link for ${link.patientName}`}
          className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-700"
        />
        <Button onClick={onCopy}>Copy</Button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Works from {timeFmt.format(new Date(link.opensAt))} until {timeFmt.format(new Date(link.expiresAt))}. Single
        patient, single appointment — it stops working once the consultation is completed.
      </p>
    </div>
  );
}


/**
 * Reschedule dialog.
 *
 * The API has always accepted a new `slot_start`, but the console had no way
 * to send one, so moving an appointment meant a manual API call. This offers
 * the doctor's real free slots for the chosen day rather than a bare
 * date-time box, so the desk cannot book into a gap that is already taken or
 * outside the doctor's hours.
 */
function RescheduleDialog({
  appointment,
  authed,
  notify,
  onClose,
  onDone,
}: {
  appointment: Appointment;
  authed: Authed;
  notify: (message: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [date, setDate] = useState(() => (appointment.slot_start || '').slice(0, 10));
  const [slots, setSlots] = useState<{ start: string; time: string; available: boolean }[]>([]);
  const [chosen, setChosen] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    setChosen('');
    void (async () => {
      try {
        const payload = await authed<{ slots: { start: string; time: string; available: boolean }[] }>(
          `/api/admin/doctors/${appointment.doctor_id}/slots?date=${date}`,
        );
        setSlots(payload.slots || []);
      } catch (caught) {
        notify(caught instanceof ApiError ? caught.message : 'Could not load times for that day.');
        setSlots([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [date, appointment.doctor_id, authed, notify]);

  async function save() {
    if (!chosen) return;
    setSaving(true);
    try {
      await authed(`/api/admin/appointments/${appointment.id}`, {
        method: 'PATCH',
        body: { slot_start: chosen },
      });
      notify('Appointment moved. The patient has been notified.');
      onDone();
      onClose();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not move that appointment.');
    } finally {
      setSaving(false);
    }
  }

  const free = slots.filter((slot) => slot.available);

  return (
    <Modal title={`Move ${appointment.patient_name}'s appointment`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Currently {appointment.slot_start ? dateTimeFmt.format(new Date(appointment.slot_start)) : '—'} with{' '}
          {appointment.doctor_name}.
        </p>

        <Field label="New date">
          <input
            type="date"
            value={date}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(event) => setDate(event.target.value)}
            className={inputClass}
          />
        </Field>

        <div>
          <span className="mb-2 block text-xs font-semibold text-slate-600">Available times</span>

          {loading && <p className="text-sm text-slate-500">Checking the doctor's diary…</p>}

          {!loading && !free.length && (
            <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
              {appointment.doctor_name} has no free slots on that day. Try another date.
            </p>
          )}

          {!loading && free.length > 0 && (
            <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {free.map((slot) => (
                <button
                  key={slot.start}
                  type="button"
                  onClick={() => setChosen(slot.start)}
                  className={`rounded-xl px-2 py-2 text-sm font-semibold transition ${
                    chosen === slot.start
                      ? 'bg-brand text-white'
                      : 'border border-slate-200 text-slate-700 hover:border-accent hover:bg-soft'
                  }`}
                >
                  {slot.time}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!chosen || saving}>
            {saving ? 'Moving…' : 'Move appointment'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function AppointmentsPanel({ authed, notify }: Props) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [filters, setFilters] = useState({ status: '', date: '' });
  const [loading, setLoading] = useState(true);
  const [links, setLinks] = useState<Record<number, MeetingLink>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.date) params.set('date', filters.date);

    try {
      setAppointments(await authed<Appointment[]>(`/api/admin/appointments?${params.toString()}`));
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load appointments.');
    } finally {
      setLoading(false);
    }
  }, [authed, filters, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchLink = async (appointmentId: number): Promise<MeetingLink | null> => {
    if (links[appointmentId]) return links[appointmentId];
    setBusyId(appointmentId);
    try {
      const payload = await authed<MeetingLink>(`/api/admin/appointments/${appointmentId}/meeting-link`);
      setLinks((current) => ({ ...current, [appointmentId]: payload }));
      return payload;
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not get the link.');
      return null;
    } finally {
      setBusyId(null);
    }
  };

  /** One click: fetch if needed, then copy. */
  const copyLink = async (appointmentId: number) => {
    const payload = await fetchLink(appointmentId);
    if (!payload) return;
    notify((await copyText(payload.link)) ? 'Join link copied to the clipboard.' : 'Could not copy — select the link and copy it manually.');
  };

  /** Manually (re)send the post-consultation review invitation. */
  const inviteReview = async (appointmentId: number) => {
    setBusyId(appointmentId);
    try {
      const result = await authed<{ message: string }>(`/api/admin/appointments/${appointmentId}/review-invite`, {
        method: 'POST',
      });
      notify(result.message);
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not send the review invitation.');
    } finally {
      setBusyId(null);
    }
  };

  const hideLink = (appointmentId: number) => {
    setLinks((current) => {
      const next = { ...current };
      delete next[appointmentId];
      return next;
    });
  };

  const resendLink = async (appointmentId: number) => {
    try {
      await authed(`/api/admin/appointments/${appointmentId}/resend-link`, { method: 'POST' });
      notify('Meeting link sent by email and WhatsApp.');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not resend the link.');
    }
  };

  const cancelAppointment = async (appointmentId: number) => {
    try {
      await authed(`/api/admin/appointments/${appointmentId}`, {
        method: 'PATCH',
        body: { status: 'cancelled', reason: 'Cancelled by clinic' },
      });
      notify('Appointment cancelled and the patient has been notified.');
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not cancel.');
    }
  };

  const linkable = (appointment: Appointment) =>
    !['cancelled', 'completed', 'no_show'].includes(appointment.status);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="filter-status" className="block text-xs font-semibold text-slate-500">Status</label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
            className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {['confirmed', 'in_reception', 'with_doctor', 'completed', 'cancelled', 'no_show'].map((status) => (
              <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-date" className="block text-xs font-semibold text-slate-500">Date</label>
          <input
            id="filter-date"
            type="date"
            value={filters.date}
            onChange={(event) => setFilters({ ...filters, date: event.target.value })}
            className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
        </div>
        <Button variant="ghost" onClick={() => setFilters({ status: '', date: '' })}>Clear</Button>
        <Button variant="ghost" onClick={() => void load()}>Refresh</Button>
      </div>

      {loading ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 ring-1 ring-slate-200">Loading…</p>
      ) : appointments.length === 0 ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 ring-1 ring-slate-200">
          No appointments match these filters.
        </p>
      ) : (
        <div className="space-y-3">
          {appointments.map((appointment) => (
            <div key={appointment.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-slate-900">{appointment.patient_name}</span>
                    <StatusPill status={appointment.status} />
                    <Badge tone={appointment.payment_status === 'verified' ? 'green' : 'amber'}>
                      {appointment.payment_status?.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {appointment.doctor_name}
                    {' • '}
                    {appointment.slot_start ? dateTimeFmt.format(new Date(appointment.slot_start)) : '—'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {appointment.email} • +{appointment.patient_whatsapp}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {linkable(appointment) && (
                    <>
                      <Button onClick={() => void copyLink(appointment.id)} disabled={busyId === appointment.id}>
                        {busyId === appointment.id ? 'Getting…' : 'Copy join link'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => (links[appointment.id] ? hideLink(appointment.id) : void fetchLink(appointment.id))}
                      >
                        {links[appointment.id] ? 'Hide' : 'Show link'}
                      </Button>
                      <Button variant="ghost" onClick={() => void resendLink(appointment.id)}>Resend</Button>
                      <Button variant="ghost" onClick={() => setRescheduling(appointment)}>Reschedule</Button>
                      <Button variant="danger" onClick={() => void cancelAppointment(appointment.id)}>Cancel</Button>
                    </>
                  )}
                  {appointment.status === 'completed' && (
                    <Button variant="ghost" onClick={() => void inviteReview(appointment.id)} disabled={busyId === appointment.id}>
                      Ask for a review
                    </Button>
                  )}
                </div>
              </div>

              {links[appointment.id] && (
                <LinkRow link={links[appointment.id]} onCopy={() => void copyLink(appointment.id)} />
              )}

              {appointment.note && (
                <p className="mt-2 rounded-xl bg-slate-50 p-2 text-xs text-slate-600">{appointment.note}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {rescheduling && (
        <RescheduleDialog
          appointment={rescheduling}
          authed={authed}
          notify={notify}
          onClose={() => setRescheduling(null)}
          onDone={() => void load()}
        />
      )}
    </section>
  );
}
