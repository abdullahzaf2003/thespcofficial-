import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useSession } from '../lib/auth';
import { ApiError, type Appointment } from '../lib/api';
import { useCallSession, type SignalMessage } from '../lib/useCallSession';
import { VideoStage, CallControls, ConnectionBadge } from '../components/VideoStage';
import { Logo } from './public/SiteChrome';

/**
 * Doctor portal.
 *
 * Signing in opens the doctor's persistent room and marks them available to
 * reception. Patients arrive in that room by handoff, one at a time; the room
 * stays open between them.
 */

type DoctorProfile = {
  id: number;
  name: string;
  specialty: string;
  qualifications?: string;
  consultation_fee?: number;
  room: string;
  availability: { weekday: number; start_time: string; end_time: string }[];
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function LoginScreen({ onSubmit, error, busy }: { onSubmit: (username: string, password: string) => void; error: string; busy: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(username, password);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl ring-1 ring-slate-200">
        <div className="mb-6 text-center">
          <Logo className="mx-auto mb-5 h-11 w-auto" />
          <div className="text-sm font-bold uppercase tracking-[0.18em] text-accent">Doctor Portal</div>
          <h1 className="mt-3 text-3xl font-black text-slate-900">Sign in</h1>
          <p className="mt-2 text-sm text-slate-500">Use the username and password the clinic gave you.</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <input
            required
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-3"
            placeholder="Username"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-3"
            placeholder="Password"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-brand px-4 py-3 font-bold text-white disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Open my room'}
          </button>
          {error && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          {/* Said plainly, because the common worry is "will I have to do this
              every time?" — and the answer being no is the point of the long
              session on the server. */}
          <p className="rounded-xl bg-soft px-3 py-2.5 text-center text-xs text-brand">
            You only need to do this once on this device. Bookmark this page and it will open ready to use.
          </p>
        </form>
      </div>
    </div>
  );
}

export default function DoctorApp() {
  const { user, token, restoring, error: authError, login, logout, authed } = useSession();
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<DoctorProfile | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [scope, setScope] = useState<'today' | 'upcoming' | 'completed'>('upcoming');
  const [active, setActive] = useState<Appointment | null>(null);
  const [notes, setNotes] = useState('');
  const [toast, setToast] = useState('');

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 4000);
  }, []);

  const handleMessage = useCallback(
    (message: SignalMessage) => {
      if (message.type === 'patient_joined' && message.appointment) {
        setActive(message.appointment);
        setNotes(message.appointment.doctor_notes || '');
        notify(`${message.appointment.patient_name} was handed over by ${message.handedOffBy || 'reception'}.`);
      }
      if (message.type === 'patient_left') {
        notify('The patient disconnected. They will reappear here if they rejoin.');
      }
      if (message.type === 'appointment_updated' && message.appointment?.status === 'completed') {
        setActive((current) => (current?.id === message.appointment.id ? null : current));
      }
    },
    [notify],
  );

  const call = useCallSession({
    role: 'doctor',
    token,
    enabled: Boolean(token),
    onMessage: handleMessage,
  });

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await authed<DoctorProfile>('/api/doctor/me'));
    } catch (caught) {
      if (caught instanceof ApiError) notify(caught.message);
    }
  }, [authed, notify]);

  const loadAppointments = useCallback(async () => {
    try {
      setAppointments(await authed<Appointment[]>(`/api/doctor/appointments?scope=${scope}`));
    } catch (caught) {
      if (caught instanceof ApiError) notify(caught.message);
    }
  }, [authed, scope, notify]);

  useEffect(() => {
    if (!token) return;
    void loadProfile();
  }, [token, loadProfile]);

  useEffect(() => {
    if (!token) return;
    void loadAppointments();
  }, [token, loadAppointments]);

  const saveNotes = async () => {
    if (!active) return;
    try {
      await authed(`/api/doctor/appointments/${active.id}/notes`, { method: 'PATCH', body: { notes } });
      notify('Notes saved.');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not save notes.');
    }
  };

  const completeConsultation = async () => {
    if (!active) return;
    try {
      await authed(`/api/doctor/appointments/${active.id}/complete`, { method: 'PATCH', body: { notes } });
      notify('Consultation completed. Your room stays open for the next patient.');
      setActive(null);
      setNotes('');
      void loadAppointments();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not complete the consultation.');
    }
  };

  const returnToReception = () => {
    if (!active) return;
    call.send({ type: 'return_to_reception', appointmentId: active.id });
    setActive(null);
    notify('Patient sent back to reception.');
  };

  if (restoring) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-500">Loading…</div>;
  }

  if (!user || !token) {
    return (
      <LoginScreen
        error={authError}
        busy={busy}
        onSubmit={async (username, password) => {
          setBusy(true);
          await login({ username, password }, 'doctor');
          setBusy(false);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-accent">Doctor Portal</div>
            <h1 className="text-2xl font-black text-slate-900">{profile?.name || user.name}</h1>
            <div className="text-sm text-slate-500">{profile?.specialty}</div>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionBadge status={call.status} />
            <span className="rounded-full bg-soft px-3 py-1 text-xs font-bold text-accent">
              {call.status === 'connected' ? 'Room open' : 'Room closed'}
            </span>
            <span className="hidden rounded-full bg-soft px-3 py-1 text-xs font-semibold text-brand sm:inline">
              Signed in on this device
            </span>
            {/* Confirmed, because a doctor who signs out by accident has to
                find their password again — the one thing this panel is built
                to avoid. */}
            <button
              onClick={() => {
                if (window.confirm('Sign out? You will need your username and password to get back in.')) {
                  void logout();
                }
              }}
              className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {toast && (
        <div className="mx-auto mt-4 max-w-7xl px-4">
          <div className="rounded-2xl bg-brand px-4 py-3 text-sm font-semibold text-white">{toast}</div>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-black text-slate-900">Consultation room</h2>
            <span className="text-xs text-slate-500">Stays open between patients</span>
          </div>

          {call.mediaError && (
            <div className="mb-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Camera/microphone unavailable ({call.mediaError}). Patients will not see or hear you.
            </div>
          )}
          {call.error && <div className="mb-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{call.error}</div>}

          <VideoStage
            peers={call.peers}
            remotes={call.remotes}
            localStream={call.localStream}
            localLabel={profile?.name || 'You'}
            emptyMessage="Your room is open and reception can see you are available. A patient will appear here when they are handed over."
          />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <CallControls
              micOn={call.micOn}
              camOn={call.camOn}
              onToggleMic={call.toggleMic}
              onToggleCam={call.toggleCam}
              disabled={!call.localStream}
            />
            {active && (
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={returnToReception}
                  className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
                >
                  Back to reception
                </button>
                <button
                  onClick={() => void completeConsultation()}
                  className="rounded-full bg-brand px-4 py-2 text-sm font-bold text-white"
                >
                  Complete consultation
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          {active ? (
            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <h3 className="mb-1 font-black text-slate-900">Current patient</h3>
              <div className="text-lg font-bold text-slate-900">{active.patient_name}</div>
              <div className="text-xs text-slate-500">
                {active.slot_start ? dateTimeFmt.format(new Date(active.slot_start)) : ''}
              </div>

              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Payment</dt>
                  <dd className={active.payment_status === 'verified' ? 'font-semibold text-green-700' : 'text-orange-600'}>
                    {active.payment_status?.replace(/_/g, ' ')}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Contact</dt>
                  <dd className="text-slate-700">+{active.patient_whatsapp}</dd>
                </div>
              </dl>

              {active.note && (
                <div className="mt-3 rounded-xl bg-slate-50 p-3">
                  <div className="text-xs font-semibold uppercase text-slate-500">Reason for visit</div>
                  <p className="mt-1 text-sm text-slate-700">{active.note}</p>
                </div>
              )}
              {active.receptionist_notes && (
                <div className="mt-3 rounded-xl bg-amber-50 p-3">
                  <div className="text-xs font-semibold uppercase text-amber-700">Reception notes</div>
                  <p className="mt-1 text-sm text-amber-900">{active.receptionist_notes}</p>
                </div>
              )}

              <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">Consultation notes</label>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={6}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                placeholder="Findings, advice, prescriptions, follow-up…"
              />
              <button
                onClick={() => void saveNotes()}
                className="mt-2 w-full rounded-xl border border-accent px-4 py-2 text-sm font-semibold text-accent"
              >
                Save notes
              </button>
            </div>
          ) : (
            <div className="rounded-2xl bg-white p-4 text-sm text-slate-500 shadow-sm ring-1 ring-slate-200">
              No patient in your room. Reception will hand the next one over.
            </div>
          )}

          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-black text-slate-900">My appointments</h3>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
              >
                <option value="upcoming">Upcoming</option>
                <option value="today">Today</option>
                <option value="completed">Completed</option>
              </select>
            </div>

            <div className="space-y-2">
              {appointments.map((appointment) => (
                <div key={appointment.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">{appointment.patient_name}</span>
                    <span className="text-xs text-slate-500">{appointment.appointment_time}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {appointment.appointment_date} • {appointment.status.replace(/_/g, ' ')}
                  </div>
                </div>
              ))}
              {appointments.length === 0 && <p className="text-sm text-slate-500">Nothing scheduled.</p>}
            </div>
          </div>

          {profile?.availability?.length ? (
            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <h3 className="mb-2 font-black text-slate-900">My weekly hours</h3>
              <ul className="space-y-1 text-sm text-slate-600">
                {profile.availability.map((row) => (
                  <li key={`${row.weekday}-${row.start_time}`} className="flex justify-between">
                    <span>{WEEKDAYS[row.weekday]}</span>
                    <span className="font-medium text-slate-800">
                      {row.start_time} – {row.end_time}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-400">Hours are managed by the clinic admin.</p>
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
