import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSession } from '../lib/auth';
import { ApiError, type Appointment } from '../lib/api';
import { useCallSession, type SignalMessage } from '../lib/useCallSession';
import { VideoStage, CallControls, ConnectionBadge } from '../components/VideoStage';
import AppointmentsPanel from './admin/AppointmentsPanel';
import DoctorsPanel from './admin/DoctorsPanel';
import ServicesPanel from './admin/ServicesPanel';
import BlogPanel from './admin/BlogPanel';
import SettingsPanel from './admin/SettingsPanel';
import WebsitePanel from './admin/WebsitePanel';
import ReviewsPanel from './admin/ReviewsPanel';
import FaqPanel from './admin/FaqPanel';
import { Logo } from './public/SiteChrome';

/**
 * Admin / receptionist console.
 *
 * The reception WebRTC room is persistent: the socket opens on sign-in and
 * stays open for the whole shift. Patients flow through it one at a time —
 * arrive, payment verified, handed off to a doctor — and the room itself is
 * never torn down.
 */

type Dashboard = {
  today: string;
  todaysAppointments: Appointment[];
  upcomingAppointments: Appointment[];
  summary: {
    doctors: number;
    services: number;
    blogs: number;
    appointments: number;
    patients: number;
    revenue: number;
    currency: string;
    byStatus: Record<string, number>;
  };
  onlineDoctors: { id: number; name: string }[];
};

type NotificationRow = {
  id: number;
  appointment_id: number | null;
  channel: string;
  template: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
};

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

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
 * Content tabs are admin-only. The backend enforces this too — these guards
 * just keep receptionists from seeing doors they cannot open.
 */
type Tab =
  | 'reception'
  | 'appointments'
  | 'doctors'
  | 'services'
  | 'website'
  | 'faq'
  | 'blog'
  | 'reviews'
  | 'notifications'
  | 'settings';

const DESK_TABS: Tab[] = ['reception', 'appointments', 'reviews', 'notifications', 'settings'];
const ADMIN_TABS: Tab[] = [
  'reception',
  'appointments',
  'doctors',
  'services',
  'website',
  'faq',
  'blog',
  'reviews',
  'notifications',
  'settings',
];

/** Tab keys are database-ish; these are what the staff actually read. */
const TAB_LABELS: Record<Tab, string> = {
  reception: 'Reception',
  appointments: 'Appointments',
  doctors: 'Doctors',
  services: 'Services',
  website: 'Website text',
  faq: 'Questions',
  blog: 'Blog',
  reviews: 'Reviews',
  notifications: 'Notifications',
  settings: 'Settings',
};

function LoginScreen({ onSubmit, error, busy }: { onSubmit: (email: string, password: string) => void; error: string; busy: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(email, password);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl ring-1 ring-slate-200">
        <div className="mb-6 text-center">
          <Logo className="mx-auto mb-5 h-11 w-auto" />
          <div className="text-sm font-bold uppercase tracking-[0.18em] text-accent">Staff Portal</div>
          <h1 className="mt-3 text-3xl font-black text-slate-900">Sign in</h1>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-3"
            placeholder="Email"
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
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        </form>
        <p className="mt-6 text-center text-xs text-slate-400">
          Doctors sign in at <a href="/doctor" className="font-semibold text-accent">/doctor</a>
        </p>
      </div>
    </div>
  );
}

export default function AdminApp() {
  const { user, token, restoring, error: authError, login, logout, authed, upload } = useSession();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('reception');

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [waiting, setWaiting] = useState<Record<number, Appointment>>({});
  const [onlineDoctors, setOnlineDoctors] = useState<{ id: number; name: string }[]>([]);
  const [handoffTarget, setHandoffTarget] = useState<Record<number, string>>({});
  const [toast, setToast] = useState('');
  const [pendingReviews, setPendingReviews] = useState(0);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 4000);
  }, []);

  // ------------------------------------------------------- live reception

  const handleMessage = useCallback((message: SignalMessage) => {
    switch (message.type) {
      case 'patient_joined':
        setWaiting((current) => ({ ...current, [message.appointment.id]: message.appointment }));
        break;
      case 'patient_left':
        setWaiting((current) => {
          const next = { ...current };
          // Keep the row but mark it offline so the receptionist can see a drop-out.
          if (next[message.appointmentId]) {
            next[message.appointmentId] = { ...next[message.appointmentId], current_room: null };
          }
          return next;
        });
        break;
      case 'patient_handed_off':
      case 'appointment_updated': {
        const id = message.appointmentId ?? message.appointment?.id;
        if (!id) break;
        setWaiting((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        break;
      }
      case 'presence':
        setOnlineDoctors(message.doctors || []);
        break;
      default:
        break;
    }
  }, []);

  const call = useCallSession({
    role: 'reception',
    token,
    enabled: Boolean(token),
    onMessage: handleMessage,
  });

  // ----------------------------------------------------------- data load

  const loadDashboard = useCallback(async () => {
    try {
      const payload = await authed<Dashboard>('/api/admin/dashboard');
      setDashboard(payload);
      setOnlineDoctors((current) => (current.length ? current : payload.onlineDoctors));
    } catch (caught) {
      if (caught instanceof ApiError) notify(caught.message);
    }
  }, [authed, notify]);

  const loadNotifications = useCallback(async () => {
    try {
      setNotifications(await authed<NotificationRow[]>('/api/admin/notifications?limit=60'));
    } catch (caught) {
      if (caught instanceof ApiError) notify(caught.message);
    }
  }, [authed, notify]);

  useEffect(() => {
    if (!token) return;
    void loadDashboard();
  }, [token, loadDashboard]);

  useEffect(() => {
    if (!token) return;
    if (tab === 'notifications') void loadNotifications();
  }, [token, tab, loadNotifications]);

  // Drives the badge on the Reviews tab, so a waiting review is noticed
  // without anyone having to go looking for it.
  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const payload = await authed<{ counts: Record<string, number> }>('/api/admin/reviews?status=pending');
        setPendingReviews(payload.counts.pending || 0);
      } catch {
        /* the badge is optional; a failure here must not break the console */
      }
    })();
  }, [token, tab, authed]);

  // ------------------------------------------------------------- actions

  const verifyPayment = async (appointmentId: number) => {
    try {
      const result = await authed<{ appointment: Appointment }>(
        `/api/admin/appointments/${appointmentId}/payment-status`,
        { method: 'PATCH', body: { payment_status: 'verified' } },
      );
      setWaiting((current) => ({ ...current, [appointmentId]: { ...current[appointmentId], ...result.appointment } }));
      notify('Payment marked as verified.');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not update payment.');
    }
  };

  const handoff = async (appointmentId: number) => {
    const doctorId = Number(handoffTarget[appointmentId] || waiting[appointmentId]?.doctor_id);
    if (!doctorId) return notify('Choose a doctor first.');

    try {
      await authed('/api/handoff', { method: 'POST', body: { appointmentId, doctorId } });
      notify('Patient handed off to the doctor.');
      void loadDashboard();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Handoff failed.');
    }
  };

  const waitingList = useMemo(() => Object.values(waiting), [waiting]);

  // ---------------------------------------------------------- rendering

  if (restoring) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-500">Loading…</div>;
  }

  if (!user || !token) {
    return (
      <LoginScreen
        error={authError}
        busy={busy}
        onSubmit={async (email, password) => {
          setBusy(true);
          await login({ email, password }, 'staff');
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
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-accent">
              {user.role === 'receptionist' ? 'Reception' : 'Administration'}
            </div>
            <h1 className="text-2xl font-black text-slate-900">Surgeons Poly Clinic</h1>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionBadge status={call.status} />
            <span className="text-sm text-slate-600">{user.name || user.email}</span>
            <button onClick={() => void logout()} className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">
              Sign out
            </button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-7xl flex-wrap gap-1 overflow-x-auto px-4">
          {(user.role === 'admin' ? ADMIN_TABS : DESK_TABS).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`whitespace-nowrap rounded-t-xl px-4 py-2 text-sm font-semibold ${
                tab === key ? 'bg-slate-100 text-brand' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {TAB_LABELS[key]}
              {key === 'reception' && waitingList.length > 0 && (
                <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
                  {waitingList.length}
                </span>
              )}
              {key === 'reviews' && pendingReviews > 0 && (
                <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">
                  {pendingReviews}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      {toast && (
        <div className="mx-auto mt-4 max-w-7xl px-4">
          <div className="rounded-2xl bg-brand px-4 py-3 text-sm font-semibold text-white">{toast}</div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-6">
        {tab === 'reception' && (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-black text-slate-900">Reception room</h2>
                <span className="text-xs text-slate-500">Always live while you are signed in</span>
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
                localLabel={user.name || 'Reception'}
                emptyMessage="No patient in the reception room right now. This room stays open — patients appear here automatically when they click their link."
              />

              <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <CallControls
                  micOn={call.micOn}
                  camOn={call.camOn}
                  onToggleMic={call.toggleMic}
                  onToggleCam={call.toggleCam}
                  disabled={!call.localStream}
                />
              </div>

              {dashboard && (
                <div className="mt-6 grid gap-3 sm:grid-cols-4">
                  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Today</div>
                    <div className="mt-1 text-2xl font-black text-brand">{dashboard.todaysAppointments.length}</div>
                  </div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Upcoming</div>
                    <div className="mt-1 text-2xl font-black text-brand">{dashboard.upcomingAppointments.length}</div>
                  </div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Patients</div>
                    <div className="mt-1 text-2xl font-black text-brand">{dashboard.summary.patients}</div>
                  </div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Verified revenue</div>
                    <div className="mt-1 text-2xl font-black text-brand">
                      Rs. {dashboard.summary.revenue.toLocaleString('en-PK')}
                    </div>
                  </div>
                </div>
              )}
            </section>

            <aside className="space-y-4">
              <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-black text-slate-900">Doctors online</h3>
                  <span className="text-xs text-slate-500">{onlineDoctors.length} available</span>
                </div>
                {onlineDoctors.length ? (
                  <ul className="space-y-2">
                    {onlineDoctors.map((doctor) => (
                      <li key={doctor.id} className="flex items-center gap-2 text-sm text-slate-700">
                        <span className="h-2 w-2 rounded-full bg-green-500" />
                        {doctor.name}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">
                    No doctors have opened their room yet. They appear here when they sign in at /doctor.
                  </p>
                )}
              </div>

              <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <h3 className="mb-3 font-black text-slate-900">Patients in reception</h3>

                {waitingList.length === 0 && <p className="text-sm text-slate-500">Nobody is waiting right now.</p>}

                <div className="space-y-4">
                  {waitingList.map((appointment) => (
                    <div key={appointment.id} className="rounded-2xl border border-slate-200 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-bold text-slate-900">{appointment.patient_name}</div>
                          <div className="text-xs text-slate-500">
                            {appointment.appointment_time} • booked with {appointment.doctor_name}
                          </div>
                        </div>
                        <StatusPill status={appointment.status} />
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
                            appointment.payment_status === 'verified'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-orange-100 text-orange-700'
                          }`}
                        >
                          {appointment.payment_status.replace(/_/g, ' ')}
                        </span>
                        {appointment.payment_status !== 'verified' && (
                          <button
                            onClick={() => void verifyPayment(appointment.id)}
                            className="rounded-full bg-accent px-3 py-1 text-xs font-bold text-white"
                          >
                            Verify payment
                          </button>
                        )}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <select
                          value={handoffTarget[appointment.id] ?? String(appointment.doctor_id)}
                          onChange={(event) =>
                            setHandoffTarget((current) => ({ ...current, [appointment.id]: event.target.value }))
                          }
                          className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
                        >
                          {onlineDoctors.length === 0 && <option value="">No doctors online</option>}
                          {onlineDoctors.map((doctor) => (
                            <option key={doctor.id} value={doctor.id}>
                              {doctor.name}
                              {doctor.id === appointment.doctor_id ? ' (booked)' : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => void handoff(appointment.id)}
                          disabled={onlineDoctors.length === 0}
                          className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
                        >
                          Hand off
                        </button>
                      </div>

                      {appointment.note && (
                        <p className="mt-3 rounded-xl bg-slate-50 p-2 text-xs text-slate-600">{appointment.note}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        )}

        {tab === 'appointments' && <AppointmentsPanel authed={authed} notify={notify} />}

        {tab === 'notifications' && (
          <section>
            <p className="mb-4 text-sm text-slate-600">
              Every message the system has queued. With no mail or WhatsApp provider configured, messages are logged
              here instead of being delivered — swap the notification adapter to send them for real.
            </p>
            <div className="space-y-3">
              {notifications.map((row) => (
                <div key={row.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-600">
                        {row.channel}
                      </span>
                      <span className="text-sm font-semibold text-slate-900">{row.template.replace(/_/g, ' ')}</span>
                    </div>
                    <span className="text-xs text-slate-500">
                      {row.recipient} • {timeFmt.format(new Date(row.created_at))}
                    </span>
                  </div>
                  {row.subject && <div className="mt-2 text-sm font-semibold text-slate-700">{row.subject}</div>}
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{row.body}</p>
                </div>
              ))}
              {notifications.length === 0 && <p className="text-sm text-slate-500">Nothing sent yet.</p>}
            </div>
          </section>
        )}

        {tab === 'doctors' && <DoctorsPanel authed={authed} notify={notify} upload={upload} />}
        {tab === 'website' && <WebsitePanel authed={authed} notify={notify} />}
        {tab === 'faq' && <FaqPanel authed={authed} notify={notify} />}
        {tab === 'reviews' && <ReviewsPanel authed={authed} notify={notify} role={user.role} />}
        {tab === 'services' && <ServicesPanel authed={authed} notify={notify} />}
        {tab === 'blog' && <BlogPanel authed={authed} notify={notify} upload={upload} />}
        {tab === 'settings' && <SettingsPanel authed={authed} notify={notify} role={user.role} />}
      </main>
    </div>
  );
}
