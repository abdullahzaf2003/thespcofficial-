import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Authed } from '../../lib/api';
import { Button, Card, EmptyState, Badge } from '../../components/ui';

/**
 * Review moderation.
 *
 * Reviews can only be written by a patient who completed a consultation and
 * followed the one-time link sent afterwards, so this queue is about tone and
 * accuracy rather than spam. Nothing reaches the website until it is approved
 * here.
 */

type Props = { authed: Authed; notify: (message: string) => void; role: string };

type Review = {
  id: number;
  patient_name: string;
  doctor_name: string;
  rating: number;
  message: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  appointment_date?: string;
  moderated_by?: string;
  moderated_at?: string;
};

const TABS: { key: 'pending' | 'approved' | 'rejected'; label: string }[] = [
  { key: 'pending', label: 'Waiting for you' },
  { key: 'approved', label: 'On the website' },
  { key: 'rejected', label: 'Hidden' },
];

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-amber-400" aria-label={`${rating} out of 5`}>
      {'★'.repeat(rating)}
      <span className="text-slate-300">{'★'.repeat(5 - rating)}</span>
    </span>
  );
}

export default function ReviewsPanel({ authed, notify, role }: Props) {
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await authed<{ reviews: Review[]; counts: Record<string, number> }>(
        `/api/admin/reviews?status=${tab}`,
      );
      setReviews(payload.reviews);
      setCounts(payload.counts);
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load reviews.');
    } finally {
      setLoading(false);
    }
  }, [authed, notify, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  async function moderate(id: number, status: Review['status']) {
    setBusyId(id);
    try {
      const result = await authed<{ message: string }>(`/api/admin/reviews/${id}`, {
        method: 'PATCH',
        body: { status },
      });
      notify(result.message);
      await load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not update that review.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: number) {
    if (!window.confirm('Delete this review permanently? This cannot be undone.')) return;
    setBusyId(id);
    try {
      await authed(`/api/admin/reviews/${id}`, { method: 'DELETE' });
      notify('Review deleted.');
      await load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not delete that review.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-lg font-black text-slate-900">Patient reviews</h2>
        <p className="mt-1 text-sm text-slate-500">
          Patients are invited to review after a completed consultation. A review appears on the website only once you
          approve it.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                tab === item.key ? 'bg-brand text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {item.label}
              {counts[item.key] ? (
                <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${tab === item.key ? 'bg-white/20' : 'bg-slate-100'}`}>
                  {counts[item.key]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </Card>

      {loading && <EmptyState>Loading reviews…</EmptyState>}

      {!loading && !reviews.length && (
        <EmptyState>
          {tab === 'pending'
            ? 'Nothing waiting. New reviews will show up here after patients complete a consultation.'
            : tab === 'approved'
              ? 'No reviews are on the website yet.'
              : 'Nothing hidden.'}
        </EmptyState>
      )}

      {!loading &&
        reviews.map((review) => (
          <Card key={review.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Stars rating={review.rating} />
                  <span className="font-bold text-slate-900">{review.patient_name}</span>
                  {review.status === 'approved' && <Badge tone="green">On the website</Badge>}
                  {review.status === 'rejected' && <Badge tone="red">Hidden</Badge>}
                  {review.status === 'pending' && <Badge tone="amber">Waiting</Badge>}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Saw {review.doctor_name}
                  {review.appointment_date ? ` on ${review.appointment_date}` : ''}
                  {review.moderated_by ? ` · reviewed by ${review.moderated_by}` : ''}
                </p>
              </div>
            </div>

            <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{review.message}</p>

            <div className="flex flex-wrap gap-2">
              {review.status !== 'approved' && (
                <Button onClick={() => void moderate(review.id, 'approved')} disabled={busyId === review.id}>
                  Publish on website
                </Button>
              )}
              {review.status !== 'rejected' && (
                <Button variant="ghost" onClick={() => void moderate(review.id, 'rejected')} disabled={busyId === review.id}>
                  {review.status === 'approved' ? 'Take off the website' : 'Hide'}
                </Button>
              )}
              {role === 'admin' && (
                <Button variant="danger" onClick={() => void remove(review.id)} disabled={busyId === review.id}>
                  Delete
                </Button>
              )}
            </div>
          </Card>
        ))}
    </div>
  );
}
