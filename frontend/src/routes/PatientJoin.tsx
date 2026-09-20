import { useCallback, useEffect, useMemo, useState } from 'react';
import { request, ApiError } from '../lib/api';
import { useCallSession, type SignalMessage } from '../lib/useCallSession';
import { VideoStage, CallControls, ConnectionBadge } from '../components/VideoStage';
import { Logo } from './public/SiteChrome';

/**
 * Patient join page (/j/:token).
 *
 * No login: the signed token in the URL is the whole credential. The patient
 * always lands in the reception room; when the receptionist hands them off,
 * this page swaps its peer connection to the doctor without the URL, the tab,
 * or the socket changing.
 */

type SessionInfo = {
  joinable: boolean;
  reason?: string;
  message?: string;
  opensAt?: string | null;
  mode?: string;
  appointment?: {
    id: number;
    patient_name: string;
    slot_start: string;
    status: string;
    payment_status: string;
  };
  doctor?: { id: number; name: string; specialty: string; image?: string };
};

const formatWhen = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-lg rounded-3xl bg-white p-8 text-center shadow-xl ring-1 ring-slate-200">
        {children}
      </div>
    </div>
  );
}

export default function PatientJoin({ token }: { token: string }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [banner, setBanner] = useState('');
  const [stage, setStage] = useState<'reception' | 'doctor'>('reception');
  const [endedMessage, setEndedMessage] = useState('');
  const [countdown, setCountdown] = useState('');

  const loadSession = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await request<SessionInfo>(`/api/video/session/${encodeURIComponent(token)}`);
      setSession(payload);
      setLoadError('');
    } catch (caught) {
      if (caught instanceof ApiError) {
        // 425 (too early) and 403 still carry a useful body.
        setSession({ joinable: false, reason: caught.code, message: caught.message });
        setLoadError(caught.message);
      } else {
        setLoadError('We could not open this link. Please check your connection.');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const handleMessage = useCallback((message: SignalMessage) => {
    switch (message.type) {
      case 'room_changed':
        if (message.room?.startsWith('doctor:')) {
          setStage('doctor');
          setBanner(message.message || 'Connecting you to your doctor…');
        } else {
          setStage('reception');
          setBanner(message.message || 'Returning you to reception…');
        }
        window.setTimeout(() => setBanner(''), 5000);
        break;
      case 'payment_verified':
        setBanner('Payment verified. Please wait while reception connects you to your doctor.');
        window.setTimeout(() => setBanner(''), 6000);
        break;
      case 'session_ended':
        setEndedMessage(message.message || 'Your consultation has ended.');
        break;
      default:
        break;
    }
  }, []);

  const canJoin = Boolean(session?.joinable) && !endedMessage;

  const call = useCallSession({
    role: 'patient',
    token,
    enabled: canJoin,
    onMessage: handleMessage,
  });

  // Countdown for a link opened before its window.
  useEffect(() => {
    if (session?.reason !== 'too_early' || !session.opensAt) return;
    const tick = () => {
      const remaining = new Date(session.opensAt!).getTime() - Date.now();
      if (remaining <= 0) {
        void loadSession();
        return;
      }
      const minutes = Math.floor(remaining / 60_000);
      const seconds = Math.floor((remaining % 60_000) / 1000);
      setCountdown(`${minutes}:${String(seconds).padStart(2, '0')}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [session, loadSession]);

  const doctorName = session?.doctor?.name || 'your doctor';

  const waitingMessage = useMemo(() => {
    if (stage === 'doctor') return `Connecting to ${doctorName}. Please wait a moment.`;
    return 'You are in the waiting room. A receptionist will join you shortly to verify your payment.';
  }, [stage, doctorName]);

  if (loading) {
    return (
      <Shell>
        <div className="text-sm text-slate-500">Opening your consultation…</div>
      </Shell>
    );
  }

  if (endedMessage) {
    return (
      <Shell>
        <div className="mb-3 text-3xl">✓</div>
        <h1 className="text-2xl font-black text-slate-900">Consultation complete</h1>
        <p className="mt-3 text-sm text-slate-600">{endedMessage}</p>
        <p className="mt-2 text-sm text-slate-500">
          This link is now closed. Please contact the clinic if you need a follow-up appointment.
        </p>
      </Shell>
    );
  }

  if (!session?.joinable) {
    return (
      <Shell>
        <h1 className="text-2xl font-black text-slate-900">
          {session?.reason === 'too_early' ? 'Not quite yet' : 'This link is not available'}
        </h1>
        <p className="mt-3 text-sm text-slate-600">{session?.message || loadError}</p>
        {session?.reason === 'too_early' && countdown && (
          <div className="mt-6 rounded-2xl bg-soft p-5">
            <div className="text-xs font-bold uppercase tracking-widest text-accent">Opens in</div>
            <div className="mt-1 font-mono text-4xl font-black text-brand">{countdown}</div>
            <p className="mt-2 text-xs text-slate-600">Keep this page open — it will let you in automatically.</p>
          </div>
        )}
        <button
          type="button"
          onClick={() => void loadSession()}
          className="mt-6 rounded-full border border-brand px-5 py-2 text-sm font-semibold text-brand"
        >
          Try again
        </button>
      </Shell>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <Logo className="h-8 w-auto" />
            <div className="border-l border-slate-200 pl-3 text-xs text-slate-500">
              {session.appointment ? formatWhen(session.appointment.slot_start) : 'Video consultation'}
            </div>
          </div>
          <ConnectionBadge status={call.status} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              stage === 'doctor' ? 'bg-brand text-white' : 'bg-soft text-accent'
            }`}
          >
            {stage === 'doctor' ? `With ${doctorName}` : 'Reception — waiting room'}
          </span>
          {session.appointment?.payment_status === 'verified' && (
            <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
              Payment verified
            </span>
          )}
        </div>

        {banner && (
          <div className="mb-4 rounded-2xl bg-brand px-4 py-3 text-sm font-semibold text-white">{banner}</div>
        )}

        {call.mediaError && (
          <div className="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
            We could not access your camera or microphone ({call.mediaError}). You can still see and hear the clinic,
            but they will not see you. Check your browser permissions and refresh.
          </div>
        )}

        {call.error && <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{call.error}</div>}

        <VideoStage
          peers={call.peers}
          remotes={call.remotes}
          localStream={call.localStream}
          localLabel={session.appointment?.patient_name || 'You'}
          emptyMessage={waitingMessage}
        />

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <CallControls
            micOn={call.micOn}
            camOn={call.camOn}
            onToggleMic={call.toggleMic}
            onToggleCam={call.toggleCam}
            disabled={!call.localStream}
          />
          <p className="text-xs text-slate-500">
            Please do not close this window — you will be connected to the doctor from here.
          </p>
        </div>
      </main>
    </div>
  );
}
