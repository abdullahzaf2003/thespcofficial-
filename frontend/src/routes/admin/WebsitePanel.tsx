import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, type Authed } from '../../lib/api';
import { inputClass, Button, Card, EmptyState } from '../../components/ui';

/**
 * Edits the text on the public website.
 *
 * The form is generated from field definitions the API sends
 * (backend/domain/siteContent.js), so a new editable heading appears here
 * automatically — nobody has to touch this file to let the clinic reword a
 * section. Fields are grouped the way someone thinks about the page ("Home
 * page banner", "Contact details") rather than by database key.
 *
 * Only changed fields are sent, so two people editing different sections do
 * not overwrite each other.
 */

type Props = { authed: Authed; notify: (message: string) => void };

type FieldDef = {
  key: string;
  label: string;
  group: string;
  type: 'text' | 'textarea';
  max: number;
  hint?: string;
};

export default function WebsitePanel({ authed, notify }: Props) {
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await authed<{ fields: FieldDef[]; values: Record<string, string> }>('/api/admin/site-content');
      setFields(payload.fields);
      setValues(payload.values);
      setDraft({});
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load the website text.');
    } finally {
      setLoading(false);
    }
  }, [authed, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, FieldDef[]>();
    for (const field of fields) {
      const list = byGroup.get(field.group) || [];
      list.push(field);
      byGroup.set(field.group, list);
    }
    return [...byGroup.entries()];
  }, [fields]);

  const changed = Object.keys(draft).filter((key) => draft[key] !== (values[key] ?? ''));

  const valueOf = (key: string) => draft[key] ?? values[key] ?? '';

  const set = (key: string, next: string) => setDraft((current) => ({ ...current, [key]: next }));

  async function save() {
    if (!changed.length) return;
    setSaving(true);
    try {
      const body = Object.fromEntries(changed.map((key) => [key, draft[key]]));
      const result = await authed<{ message: string; values: Record<string, string> }>('/api/admin/site-content', {
        method: 'PUT',
        body,
      });
      setValues(result.values);
      setDraft({});
      notify(result.message);
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not save your changes.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <EmptyState>Loading the website text…</EmptyState>;

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">Website text</h2>
          <p className="text-sm text-slate-500">
            Everything here appears on the public website. Changes go live as soon as you save — no deploy needed.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {changed.length > 0 && (
            <span className="text-xs font-semibold text-amber-700">
              {changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}
            </span>
          )}
          <Button variant="ghost" onClick={() => setDraft({})} disabled={!changed.length || saving}>
            Undo
          </Button>
          <Button onClick={save} disabled={!changed.length || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </Card>

      {groups.map(([group, groupFields]) => (
        <Card key={group}>
          <h3 className="mb-4 text-sm font-black uppercase tracking-wide text-slate-500">{group}</h3>

          <div className="grid gap-4 md:grid-cols-2">
            {groupFields.map((field) => {
              const value = valueOf(field.key);
              const isChanged = changed.includes(field.key);

              return (
                <div key={field.key} className={field.type === 'textarea' ? 'md:col-span-2' : ''}>
                  <label className="block">
                    <span className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-600">
                      {field.label}
                      {isChanged && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800">edited</span>}
                    </span>

                    {field.type === 'textarea' ? (
                      <textarea
                        rows={3}
                        value={value}
                        maxLength={field.max}
                        onChange={(event) => set(field.key, event.target.value)}
                        className={inputClass}
                      />
                    ) : (
                      <input
                        value={value}
                        maxLength={field.max}
                        onChange={(event) => set(field.key, event.target.value)}
                        className={inputClass}
                      />
                    )}
                  </label>

                  <div className="mt-1 flex justify-between gap-2 text-xs text-slate-400">
                    <span>{field.hint || ''}</span>
                    <span className="shrink-0">
                      {value.length}/{field.max}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}

      {/* Repeated at the bottom so a long form does not need scrolling back up. */}
      <Card className="flex items-center justify-between gap-3">
        <span className="text-sm text-slate-500">
          {changed.length ? `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}.` : 'Everything is saved.'}
        </span>
        <Button onClick={save} disabled={!changed.length || saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </Card>
    </div>
  );
}
