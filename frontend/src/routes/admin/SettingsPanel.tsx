import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, type Authed } from '../../lib/api';
import { Field, inputClass, Button, Modal, Card, Badge } from '../../components/ui';

/**
 * Clinic details (rendered in the public header, contact block and footer)
 * and staff account management.
 */

type Props = { authed: Authed; notify: (message: string) => void; role: string };

type StaffRow = { id: number; email: string; name?: string; role: string; status?: string; created_at?: string };

const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'clinic_name', label: 'Clinic name' },
  { key: 'clinic_subtitle', label: 'Subtitle', hint: 'Shown under the name in the site header.' },
  { key: 'address', label: 'Address' },
  { key: 'location', label: 'Location' },
  { key: 'phone_primary', label: 'Primary phone', hint: 'Used for the tel: link on the Call Now button.' },
  { key: 'phone_secondary', label: 'Secondary phone' },
  { key: 'whatsapp_number', label: 'WhatsApp number', hint: 'Digits only, with country code, e.g. 923084213201.' },
  { key: 'opening_hours', label: 'Opening hours' },
  { key: 'calling_hours', label: 'Calling hours' },
  { key: 'consultation_fee', label: 'Standard consultation fee (PKR)' },
  { key: 'timezone', label: 'Timezone', hint: 'Appointment times are generated and displayed in this zone.' },
];


/**
 * The devices the signed-in person is currently signed in on.
 *
 * Sessions are long — 30 days and sliding for doctors — which is only a safe
 * trade if there is an obvious way to cut one off. This is that: plain
 * language, one button, no jargon about tokens.
 */
function MyDevices({ authed, notify }: { authed: Authed; notify: (message: string) => void }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDevices(await authed<DeviceRow[]>('/api/auth/devices'));
    } catch {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, [authed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut(id: string) {
    setBusy(id);
    try {
      await authed(`/api/auth/devices/${id}`, { method: 'DELETE' });
      notify('That device has been signed out.');
      await load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not sign that device out.');
    } finally {
      setBusy('');
    }
  }

  async function signOutAll() {
    if (!window.confirm('Sign out on every device, including this one?')) return;
    try {
      await authed('/api/auth/logout-all', { method: 'POST' });
      window.location.reload();
    } catch {
      notify('Could not sign out everywhere.');
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">Where you are signed in</h2>
          <p className="text-sm text-slate-500">
            You stay signed in on these devices. If one is lost or is not yours, sign it out here.
          </p>
        </div>
        <Button variant="danger" onClick={() => void signOutAll()}>
          Sign out everywhere
        </Button>
      </div>

      <Card>
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {!loading && !devices.length && <p className="text-sm text-slate-500">No other devices.</p>}

        <ul className="divide-y divide-slate-100">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  {device.label} {device.current && <Badge tone="green">This device</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  Last used {device.last_used_at ? new Date(device.last_used_at).toLocaleString('en-GB') : 'unknown'}
                </p>
              </div>
              {!device.current && (
                <Button variant="ghost" onClick={() => void signOut(device.id)} disabled={busy === device.id}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

type DeviceRow = {
  id: string;
  label: string;
  last_used_at?: string;
  expires_at?: string;
  current?: boolean;
};

export default function SettingsPanel({ authed, notify, role }: Props) {
  const [info, setInfo] = useState<Record<string, string>>({});
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingStaff, setAddingStaff] = useState(false);
  const [staffForm, setStaffForm] = useState({ email: '', name: '', password: '', role: 'receptionist' });

  const isAdmin = role === 'admin';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const requests: Promise<unknown>[] = [authed<Record<string, string>>('/api/admin/clinic-info')];
      if (isAdmin) requests.push(authed<StaffRow[]>('/api/admin/staff'));

      const [infoPayload, staffPayload] = await Promise.all(requests);
      setInfo(infoPayload as Record<string, string>);
      if (staffPayload) setStaff(staffPayload as StaffRow[]);
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, [authed, notify, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveInfo = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await authed('/api/admin/clinic-info', { method: 'PUT', body: info });
      notify('Clinic details updated. The website picks this up on the next load.');
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not save clinic details.');
    } finally {
      setSaving(false);
    }
  };

  const addStaff = async (event: FormEvent) => {
    event.preventDefault();
    if (staffForm.password.length < 10) return notify('Password must be at least 10 characters.');
    try {
      await authed('/api/admin/staff', { method: 'POST', body: staffForm });
      notify('Staff account created.');
      setAddingStaff(false);
      setStaffForm({ email: '', name: '', password: '', role: 'receptionist' });
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not create the account.');
    }
  };

  if (loading) return <p className="text-sm text-slate-500">Loading settings…</p>;

  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-lg font-black text-slate-900">Clinic details</h2>
        <p className="mb-4 text-sm text-slate-500">
          These values feed the public website — header, contact cards, phone and WhatsApp links.
        </p>

        <form onSubmit={saveInfo}>
          <Card>
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <input
                    value={info[field.key] ?? ''}
                    onChange={(e) => setInfo({ ...info, [field.key]: e.target.value })}
                    className={inputClass}
                    disabled={!isAdmin}
                  />
                </Field>
              ))}
            </div>
            {isAdmin ? (
              <div className="mt-4 flex justify-end">
                <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save clinic details'}</Button>
              </div>
            ) : (
              <p className="mt-4 text-xs text-slate-500">Only an admin can change these.</p>
            )}
          </Card>
        </form>
      </div>

      <MyDevices authed={authed} notify={notify} />

      {isAdmin && (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-slate-900">Staff accounts</h2>
              <p className="text-sm text-slate-500">
                Receptionists can run the reception room and appointments; admins can also manage content.
              </p>
            </div>
            <Button onClick={() => setAddingStaff(true)}>Add staff</Button>
          </div>

          <Card>
            <ul className="divide-y divide-slate-100">
              {staff.map((person) => (
                <li key={person.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div>
                    <div className="font-semibold text-slate-900">{person.name || person.email}</div>
                    <div className="text-xs text-slate-500">{person.email}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={person.role === 'admin' ? 'green' : 'slate'}>{person.role}</Badge>
                    {person.status === 'inactive' && <Badge tone="red">Inactive</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {addingStaff && (
        <Modal title="Add staff account" onClose={() => setAddingStaff(false)}>
          <form onSubmit={addStaff} className="space-y-4">
            <Field label="Name">
              <input value={staffForm.name} onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Email" required>
              <input required type="email" value={staffForm.email} onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Password" required hint="At least 10 characters.">
              <input required type="text" value={staffForm.password} onChange={(e) => setStaffForm({ ...staffForm, password: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Role" required>
              <select value={staffForm.role} onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })} className={inputClass}>
                <option value="receptionist">Receptionist</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setAddingStaff(false)}>Cancel</Button>
              <Button type="submit">Create account</Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
