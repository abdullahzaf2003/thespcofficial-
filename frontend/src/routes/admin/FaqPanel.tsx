import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Authed } from '../../lib/api';
import { Field, inputClass, Button, Card, EmptyState, Badge } from '../../components/ui';

/**
 * Questions and answers shown on the public website.
 *
 * Kept as rows rather than another block of website text because they are
 * repeating content that gets added to over time — the clinic will want to
 * answer whatever patients keep phoning to ask.
 */

type Props = { authed: Authed; notify: (message: string) => void };

type Faq = {
  id: number;
  question: string;
  answer: string;
  sort_order: number;
  enabled: number;
};

const BLANK = { question: '', answer: '' };

export default function FaqPanel({ authed, notify }: Props) {
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...BLANK });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFaqs(await authed<Faq[]>('/api/admin/faqs'));
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load the questions.');
    } finally {
      setLoading(false);
    }
  }, [authed, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!form.question.trim() || !form.answer.trim()) {
      return notify('Please fill in both the question and the answer.');
    }

    setSaving(true);
    try {
      if (editingId) {
        await authed(`/api/admin/faqs/${editingId}`, { method: 'PATCH', body: form });
        notify('Question updated.');
      } else {
        await authed('/api/admin/faqs', { method: 'POST', body: form });
        notify('Question added to the website.');
      }
      setForm({ ...BLANK });
      setEditingId(null);
      await load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not save that question.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(faq: Faq) {
    try {
      await authed(`/api/admin/faqs/${faq.id}`, { method: 'PATCH', body: { enabled: faq.enabled ? 0 : 1 } });
      await load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not update that question.');
    }
  }

  /** Swaps sort_order with the neighbour, so "move up" is one obvious click. */
  async function move(index: number, direction: -1 | 1) {
    const target = faqs[index + direction];
    const current = faqs[index];
    if (!target || !current) return;

    try {
      await Promise.all([
        authed(`/api/admin/faqs/${current.id}`, { method: 'PATCH', body: { sort_order: target.sort_order } }),
        authed(`/api/admin/faqs/${target.id}`, { method: 'PATCH', body: { sort_order: current.sort_order } }),
      ]);
      await load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not reorder.');
    }
  }

  async function remove(faq: Faq) {
    if (!window.confirm(`Delete "${faq.question}"? This cannot be undone.`)) return;
    try {
      await authed(`/api/admin/faqs/${faq.id}`, { method: 'DELETE' });
      notify('Question deleted.');
      await load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not delete that question.');
    }
  }

  return (
    <section className="space-y-5">
      <Card>
        <h2 className="text-lg font-black text-slate-900">{editingId ? 'Edit question' : 'Add a question'}</h2>
        <p className="mt-1 text-sm text-slate-500">
          These appear on the public website. A good one to add is whatever patients keep calling to ask.
        </p>

        <div className="mt-4 space-y-4">
          <Field label="Question" required>
            <input
              value={form.question}
              onChange={(event) => setForm({ ...form, question: event.target.value })}
              className={inputClass}
              maxLength={300}
              placeholder="Do you offer emergency consultation?"
            />
          </Field>

          <Field label="Answer" required>
            <textarea
              rows={3}
              value={form.answer}
              onChange={(event) => setForm({ ...form, answer: event.target.value })}
              className={inputClass}
              maxLength={2000}
              placeholder="Yes. The clinic remains open 24/7…"
            />
          </Field>

          <div className="flex justify-end gap-2">
            {editingId && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingId(null);
                  setForm({ ...BLANK });
                }}
              >
                Cancel
              </Button>
            )}
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add to website'}
            </Button>
          </div>
        </div>
      </Card>

      {loading && <EmptyState>Loading questions…</EmptyState>}
      {!loading && !faqs.length && <EmptyState>No questions yet. Add the first one above.</EmptyState>}

      {faqs.map((faq, index) => (
        <Card key={faq.id} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-bold text-slate-900">{faq.question}</h3>
                {!faq.enabled && <Badge tone="slate">Hidden</Badge>}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{faq.answer}</p>
            </div>

            <div className="flex shrink-0 gap-1">
              <button
                onClick={() => void move(index, -1)}
                disabled={index === 0}
                aria-label="Move up"
                className="rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-600 disabled:opacity-30 hover:bg-slate-50"
              >
                ↑
              </button>
              <button
                onClick={() => void move(index, 1)}
                disabled={index === faqs.length - 1}
                aria-label="Move down"
                className="rounded-lg border border-slate-200 px-2 py-1 text-sm text-slate-600 disabled:opacity-30 hover:bg-slate-50"
              >
                ↓
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setEditingId(faq.id);
                setForm({ question: faq.question, answer: faq.answer });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              Edit
            </Button>
            <Button variant="ghost" onClick={() => void toggle(faq)}>
              {faq.enabled ? 'Hide from website' : 'Show on website'}
            </Button>
            <Button variant="danger" onClick={() => void remove(faq)}>
              Delete
            </Button>
          </div>
        </Card>
      ))}
    </section>
  );
}
