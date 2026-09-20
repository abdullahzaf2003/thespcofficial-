import { useEffect, useState } from 'react';
import { request, ApiError } from '../../lib/api';
import { SiteLink, Logo } from './SiteChrome';

/**
 * The review form, reachable only through the one-time link sent after a
 * completed consultation.
 *
 * Because the invite is tied to an appointment, the page already knows who the
 * patient saw and when — so the form is two fields, not six, and the review
 * cannot be submitted by someone who was never a patient.
 */

type Invite = {
  patient_name: string;
  doctor_name: string;
  doctor_id: number;
  appointment_date: string;
};

function Stars({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating out of 5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={value === star}
          aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`}
          onClick={() => onChange(star)}
          className={`rounded-lg p-1 text-4xl leading-none transition ${
            star <= value ? 'text-amber-400' : 'text-slate-300 hover:text-amber-200'
          }`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-lg rounded-card bg-white p-8 shadow-card">
        <Logo className="mb-6 h-9 w-auto" />
        {children}
      </div>
    </div>
  );
}

export default function ReviewPage({ token }: { token: string }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');

  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setInvite(await request<Invite>(`/api/reviews/invite/${encodeURIComponent(token)}`));
      } catch (caught) {
        setProblem(caught instanceof ApiError ? caught.message : 'This review link could not be opened.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');

    if (!rating) return setError('Please choose a star rating.');
    if (!message.trim()) return setError('Please tell us a little about your visit.');

    setSaving(true);
    try {
      await request(`/api/reviews/invite/${encodeURIComponent(token)}`, {
        method: 'POST',
        body: { rating, message },
      });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Your review could not be sent. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Shell>
        <div className="py-8 text-center text-slate-500">Loading…</div>
      </Shell>
    );
  }

  if (problem) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-brand">Review link</h1>
        <p className="mt-3 text-slate-600">{problem}</p>
        <SiteLink to="/" className="mt-6 inline-block rounded-lg bg-brand px-5 py-2.5 font-medium text-white hover:bg-brand-600">
          Go to the website
        </SiteLink>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-soft text-3xl text-accent">✓</div>
          <h1 className="mt-5 text-2xl font-bold text-brand">Thank you</h1>
          <p className="mt-3 text-slate-600">
            Our team reads every review before it appears on the website. We appreciate you taking the time.
          </p>
          <SiteLink to="/" className="mt-6 inline-block rounded-lg bg-brand px-5 py-2.5 font-medium text-white hover:bg-brand-600">
            Back to the website
          </SiteLink>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-bold text-brand">How was your consultation?</h1>
      <p className="mt-2 text-slate-600">
        {invite?.patient_name}, you saw <span className="font-medium text-slate-900">{invite?.doctor_name}</span>
        {invite?.appointment_date ? ` on ${invite.appointment_date}` : ''}.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-slate-700">Your rating</label>
          <div className="mt-2">
            <Stars value={rating} onChange={setRating} />
          </div>
        </div>

        <div>
          <label htmlFor="review_message" className="block text-sm font-medium text-slate-700">
            What would you like to say?
          </label>
          <textarea
            id="review_message"
            rows={5}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={2000}
            placeholder="How were you treated? Was everything explained clearly?"
            className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <p className="mt-1 text-xs text-slate-400">{message.length}/2000</p>
        </div>

        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-lg bg-accent px-5 py-3 font-medium text-white transition hover:bg-accent-600 disabled:opacity-60"
        >
          {saving ? 'Sending…' : 'Send review'}
        </button>

        <p className="text-center text-xs text-slate-400">
          Your review is checked by our team before it is published. Your contact details are never shown.
        </p>
      </form>
    </Shell>
  );
}
