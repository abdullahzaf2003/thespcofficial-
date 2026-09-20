import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, WEEKDAYS, type Authed, type AdminDoctor, type AvailabilityWindow, type DateOverride } from '../../lib/api';
import { Field, inputClass, Button, Modal, Card, EmptyState, Badge, ImageField, type Uploader } from '../../components/ui';

/**
 * Doctor management: profile CRUD, portal credentials, and the weekly
 * availability template plus one-off date overrides that slot generation
 * reads from.
 */

type Props = { authed: Authed; notify: (message: string) => void; upload: Uploader };

const BLANK = {
  name: '',
  specialty: '',
  qualifications: '',
  bio: '',
  image: '',
  username: '',
  password: '',
  consultation_fee: 3000,
  years_experience: 0,
  slot_duration_minutes: 20,
  languages: 'English, Urdu',
  verification: 'PMC Verified',
  wait_time: '',
  timing_note: '',
  tags: '',
  start_time: '18:00',
  end_time: '21:00',
};

export default function DoctorsPanel({ authed, notify, upload }: Props) {
  const [doctors, setDoctors] = useState<AdminDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminDoctor | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [newCredentials, setNewCredentials] = useState<{ username: string; password: string } | null>(null);
  const [availabilityFor, setAvailabilityFor] = useState<AdminDoctor | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDoctors(await authed<AdminDoctor[]>('/api/admin/doctors'));
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load doctors.');
    } finally {
      setLoading(false);
    }
  }, [authed, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setForm({ ...BLANK });
    setCreating(true);
  };

  const openEdit = (doctor: AdminDoctor) => {
    setForm({
      ...BLANK,
      name: doctor.name || '',
      specialty: doctor.specialty || '',
      qualifications: doctor.qualifications || '',
      bio: doctor.bio || '',
      image: doctor.image || '',
      verification: doctor.verification || '',
      wait_time: doctor.wait_time || '',
      timing_note: doctor.timing_note || '',
      tags: doctor.tags || '',
      username: doctor.username || '',
      password: '',
      consultation_fee: doctor.consultation_fee ?? 3000,
      years_experience: doctor.years_experience ?? 0,
      slot_duration_minutes: doctor.slot_duration_minutes ?? 20,
      languages: doctor.languages || 'English, Urdu',
    });
    setEditing(doctor);
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await authed<{ credentials: { username: string; password: string } }>('/api/admin/doctors', {
        method: 'POST',
        body: form,
      });
      setCreating(false);
      // The generated password is only ever shown here — it is stored hashed.
      setNewCredentials(result.credentials);
      notify('Doctor created.');
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not create the doctor.');
    }
  };

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const body: Record<string, unknown> = { ...form };
    if (!body.password) delete body.password;
    delete body.username; // usernames are immutable once issued
    delete body.start_time;
    delete body.end_time;

    try {
      await authed(`/api/admin/doctors/${editing.id}`, { method: 'PATCH', body });
      setEditing(null);
      notify('Doctor updated.');
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not update the doctor.');
    }
  };

  const toggleActive = async (doctor: AdminDoctor) => {
    const reactivating = doctor.status === 'inactive' || doctor.enabled === 0;
    try {
      if (reactivating) {
        await authed(`/api/admin/doctors/${doctor.id}`, { method: 'PATCH', body: { enabled: 1, status: 'active' } });
        notify(`${doctor.name} reactivated.`);
      } else {
        await authed(`/api/admin/doctors/${doctor.id}`, { method: 'DELETE' });
        notify(`${doctor.name} deactivated. Their appointment history is kept.`);
      }
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not change status.');
    }
  };

  const formFields = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Full name" required>
        <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Specialty" required>
        <input required value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} className={inputClass} placeholder="ENT Specialist • ENT Surgeon" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Qualifications">
          <input value={form.qualifications} onChange={(e) => setForm({ ...form, qualifications: e.target.value })} className={inputClass} placeholder="MBBS · FCPS" />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Bio">
          <textarea rows={3} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} className={inputClass} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <ImageField
          label="Photo"
          value={form.image}
          onChange={(url) => setForm({ ...form, image: url })}
          upload={upload}
          preset="portrait"
          hint="A photo straight off a phone is fine — it is resized automatically."
        />
      </div>
      <Field label="Verification badge" hint="Shown next to the name, e.g. PMC Verified. Leave blank for none.">
        <input value={form.verification} onChange={(e) => setForm({ ...form, verification: e.target.value })} className={inputClass} placeholder="PMC Verified" />
      </Field>
      <Field label="Typical wait" hint="Shown on the profile card.">
        <input value={form.wait_time} onChange={(e) => setForm({ ...form, wait_time: e.target.value })} className={inputClass} placeholder="15–30 Min" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Clinic hours (as written to patients)" hint="Plain text for the website. The bookable slots come from the working hours below, not from this.">
          <input value={form.timing_note} onChange={(e) => setForm({ ...form, timing_note: e.target.value })} className={inputClass} placeholder="Mon–Sat • 7:00 PM – 9:00 PM" />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Areas of care" hint="Separate with the | character, e.g. General Surgery|Breast Care|ENT">
          <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} className={inputClass} placeholder="General Surgery|Breast Care|ENT" />
        </Field>
      </div>
      <Field label="Consultation fee (PKR)">
        <input type="number" min={0} value={form.consultation_fee} onChange={(e) => setForm({ ...form, consultation_fee: Number(e.target.value) })} className={inputClass} />
      </Field>
      <Field label="Years of experience">
        <input type="number" min={0} value={form.years_experience} onChange={(e) => setForm({ ...form, years_experience: Number(e.target.value) })} className={inputClass} />
      </Field>
      <Field label="Slot length (minutes)" hint="Changes the appointment grid for future bookings.">
        <input type="number" min={5} step={5} value={form.slot_duration_minutes} onChange={(e) => setForm({ ...form, slot_duration_minutes: Number(e.target.value) })} className={inputClass} />
      </Field>
      <Field label="Languages">
        <input value={form.languages} onChange={(e) => setForm({ ...form, languages: e.target.value })} className={inputClass} />
      </Field>
    </div>
  );

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">Doctors</h2>
          <p className="text-sm text-slate-500">Profiles, portal credentials and working hours.</p>
        </div>
        <Button onClick={openCreate}>Add doctor</Button>
      </div>

      {loading ? (
        <EmptyState>Loading doctors…</EmptyState>
      ) : doctors.length === 0 ? (
        <EmptyState>No doctors yet.</EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {doctors.map((doctor) => {
            const inactive = doctor.status === 'inactive' || doctor.enabled === 0;
            return (
              <Card key={doctor.id} className={inactive ? 'opacity-60' : ''}>
                <div className="flex gap-4">
                  {doctor.image ? (
                    <img src={doctor.image} alt={doctor.name} className="h-20 w-20 shrink-0 rounded-2xl object-cover" />
                  ) : (
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-2xl font-black text-slate-400">
                      {doctor.name.slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold text-slate-900">{doctor.name}</h3>
                      {inactive ? <Badge tone="red">Inactive</Badge> : <Badge tone="green">Active</Badge>}
                    </div>
                    <div className="text-sm text-accent">{doctor.specialty}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      Rs. {(doctor.consultation_fee ?? 0).toLocaleString('en-PK')} • {doctor.slot_duration_minutes ?? 20} min slots
                      {doctor.years_experience ? ` • ${doctor.years_experience} yrs` : ''}
                    </div>
                    <div className="mt-1 font-mono text-xs text-slate-400">login: {doctor.username || 'none'}</div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={() => openEdit(doctor)}>Edit</Button>
                  <Button variant="ghost" onClick={() => setAvailabilityFor(doctor)}>Working hours</Button>
                  <Button variant={inactive ? 'ghost' : 'danger'} onClick={() => void toggleActive(doctor)}>
                    {inactive ? 'Reactivate' : 'Deactivate'}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {creating && (
        <Modal title="Add doctor" onClose={() => setCreating(false)} wide>
          <form onSubmit={submitCreate} className="space-y-4">
            {formFields}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Portal username" hint="Left blank, one is generated from the name.">
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Portal password" hint="Left blank, a strong one is generated and shown once.">
                <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Default start time">
                <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Default end time">
                <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} className={inputClass} />
              </Field>
            </div>
            <p className="text-xs text-slate-500">Monday to Saturday hours are created from these times, and can be edited afterwards.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit">Create doctor</Button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)} wide>
          <form onSubmit={submitEdit} className="space-y-4">
            {formFields}
            <Field label="Reset portal password" hint="Leave blank to keep the current password.">
              <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={inputClass} placeholder="New password" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit">Save changes</Button>
            </div>
          </form>
        </Modal>
      )}

      {newCredentials && (
        <Modal title="Portal credentials" onClose={() => setNewCredentials(null)}>
          <p className="text-sm text-slate-600">
            Give these to the doctor now. The password is stored hashed and <strong>cannot be shown again</strong> — you
            would have to reset it.
          </p>
          <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 font-mono text-sm">
            <div>username: <strong>{newCredentials.username}</strong></div>
            <div>password: <strong>{newCredentials.password}</strong></div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => setNewCredentials(null)}>Done</Button>
          </div>
        </Modal>
      )}

      {availabilityFor && (
        <AvailabilityEditor
          doctor={availabilityFor}
          authed={authed}
          notify={notify}
          onClose={() => setAvailabilityFor(null)}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------ availability editor

function AvailabilityEditor({
  doctor,
  authed,
  notify,
  onClose,
}: {
  doctor: AdminDoctor;
  authed: Authed;
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Record<number, { enabled: boolean; start_time: string; end_time: string }>>({});
  const [overrides, setOverrides] = useState<DateOverride[]>([]);
  const [newOverride, setNewOverride] = useState({ date: '', kind: 'closed', start_time: '09:00', end_time: '17:00', reason: '' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const payload = await authed<{ template: AvailabilityWindow[]; overrides: DateOverride[] }>(
          `/api/admin/doctors/${doctor.id}/availability`,
        );
        const next: Record<number, { enabled: boolean; start_time: string; end_time: string }> = {};
        for (let weekday = 0; weekday <= 6; weekday += 1) {
          const existing = payload.template.find((row) => row.weekday === weekday);
          next[weekday] = existing
            ? { enabled: true, start_time: existing.start_time, end_time: existing.end_time }
            : { enabled: false, start_time: '18:00', end_time: '21:00' };
        }
        setRows(next);
        setOverrides(payload.overrides);
      } catch (caught) {
        notify(caught instanceof ApiError ? caught.message : 'Could not load availability.');
      } finally {
        setLoading(false);
      }
    })();
  }, [doctor.id, authed, notify]);

  const save = async () => {
    const template = Object.entries(rows)
      .filter(([, row]) => row.enabled)
      .map(([weekday, row]) => ({ weekday: Number(weekday), start_time: row.start_time, end_time: row.end_time }));

    try {
      await authed(`/api/admin/doctors/${doctor.id}/availability`, { method: 'PUT', body: { template } });
      notify('Working hours updated.');
      onClose();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not save working hours.');
    }
  };

  const addOverride = async () => {
    if (!newOverride.date) return notify('Pick a date for the override.');
    try {
      await authed(`/api/admin/doctors/${doctor.id}/overrides`, {
        method: 'POST',
        body:
          newOverride.kind === 'closed'
            ? { date: newOverride.date, kind: 'closed', reason: newOverride.reason }
            : newOverride,
      });
      const payload = await authed<{ overrides: DateOverride[] }>(`/api/admin/doctors/${doctor.id}/availability`);
      setOverrides(payload.overrides);
      setNewOverride({ date: '', kind: 'closed', start_time: '09:00', end_time: '17:00', reason: '' });
      notify('Override added.');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not add the override.');
    }
  };

  const removeOverride = async (id: number) => {
    try {
      await authed(`/api/admin/overrides/${id}`, { method: 'DELETE' });
      setOverrides((current) => current.filter((row) => row.id !== id));
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not remove the override.');
    }
  };

  return (
    <Modal title={`Working hours — ${doctor.name}`} onClose={onClose} wide>
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Weekly template</h3>
            <div className="space-y-2">
              {WEEKDAYS.map((label, weekday) => {
                const row = rows[weekday];
                if (!row) return null;
                return (
                  <div key={weekday} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3">
                    <label className="flex w-32 items-center gap-2 text-sm font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) => setRows({ ...rows, [weekday]: { ...row, enabled: e.target.checked } })}
                      />
                      {label}
                    </label>
                    <input
                      type="time"
                      value={row.start_time}
                      disabled={!row.enabled}
                      onChange={(e) => setRows({ ...rows, [weekday]: { ...row, start_time: e.target.value } })}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-sm disabled:opacity-40"
                    />
                    <span className="text-slate-400">to</span>
                    <input
                      type="time"
                      value={row.end_time}
                      disabled={!row.enabled}
                      onChange={(e) => setRows({ ...rows, [weekday]: { ...row, end_time: e.target.value } })}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-sm disabled:opacity-40"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Date overrides</h3>
            <p className="mb-3 text-xs text-slate-500">
              Holidays and one-off changes. These win over the weekly template for that date.
            </p>

            {overrides.length > 0 && (
              <ul className="mb-3 space-y-2">
                {overrides.map((override) => (
                  <li key={override.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm">
                    <span>
                      <strong>{override.date}</strong> —{' '}
                      {override.kind === 'closed' ? 'closed' : `${override.start_time} to ${override.end_time}`}
                      {override.reason ? ` (${override.reason})` : ''}
                    </span>
                    <button onClick={() => void removeOverride(override.id)} className="text-xs font-semibold text-red-600">
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-2">
              <Field label="Date">
                <input type="date" value={newOverride.date} onChange={(e) => setNewOverride({ ...newOverride, date: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Type">
                <select value={newOverride.kind} onChange={(e) => setNewOverride({ ...newOverride, kind: e.target.value })} className={inputClass}>
                  <option value="closed">Closed all day</option>
                  <option value="custom">Different hours</option>
                </select>
              </Field>
              {newOverride.kind === 'custom' && (
                <>
                  <Field label="Start">
                    <input type="time" value={newOverride.start_time} onChange={(e) => setNewOverride({ ...newOverride, start_time: e.target.value })} className={inputClass} />
                  </Field>
                  <Field label="End">
                    <input type="time" value={newOverride.end_time} onChange={(e) => setNewOverride({ ...newOverride, end_time: e.target.value })} className={inputClass} />
                  </Field>
                </>
              )}
              <div className="sm:col-span-2">
                <Field label="Reason">
                  <input value={newOverride.reason} onChange={(e) => setNewOverride({ ...newOverride, reason: e.target.value })} className={inputClass} placeholder="Eid holiday" />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Button variant="ghost" type="button" onClick={() => void addOverride()}>Add override</Button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()}>Save working hours</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
