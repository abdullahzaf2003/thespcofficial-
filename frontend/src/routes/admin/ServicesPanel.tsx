import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, type Authed, type Service, type AdminDoctor } from '../../lib/api';
import { Field, inputClass, Button, Modal, Card, EmptyState, Badge } from '../../components/ui';

/** Service catalogue: price, duration, category, and which doctors offer it. */

type Props = { authed: Authed; notify: (message: string) => void };

type AdminService = Service & { status?: string; icon?: string; image?: string; sort_order?: number; currency?: string };

const BLANK = {
  name: '',
  description: '',
  category: 'Surgical',
  icon: '',
  image: '',
  price: 3000,
  duration_minutes: 20,
  sort_order: 0,
  doctor_ids: [] as number[],
};

export default function ServicesPanel({ authed, notify }: Props) {
  const [services, setServices] = useState<AdminService[]>([]);
  const [doctors, setDoctors] = useState<AdminDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...BLANK });
  const [editing, setEditing] = useState<AdminService | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [serviceRows, doctorRows, publicRows] = await Promise.all([
        authed<AdminService[]>('/api/admin/services'),
        authed<AdminDoctor[]>('/api/admin/doctors'),
        // The public feed carries the doctor links, which the admin list omits.
        authed<Service[]>('/api/services'),
      ]);
      const links = new Map(publicRows.map((row) => [row.id, row.doctor_ids || []]));
      setServices(serviceRows.map((row) => ({ ...row, doctor_ids: links.get(row.id) || [] })));
      setDoctors(doctorRows);
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load services.');
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

  const openEdit = (service: AdminService) => {
    setForm({
      name: service.name || '',
      description: service.description || '',
      category: service.category || 'Surgical',
      icon: service.icon || '',
      image: service.image || '',
      price: service.price ?? 0,
      duration_minutes: service.duration_minutes ?? 20,
      sort_order: service.sort_order ?? 0,
      doctor_ids: service.doctor_ids || [],
    });
    setEditing(service);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (editing) {
        await authed(`/api/admin/services/${editing.id}`, { method: 'PATCH', body: form });
        notify('Service updated.');
      } else {
        await authed('/api/admin/services', { method: 'POST', body: form });
        notify('Service created.');
      }
      setEditing(null);
      setCreating(false);
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not save the service.');
    }
  };

  const toggleActive = async (service: AdminService) => {
    try {
      if (service.status === 'inactive') {
        await authed(`/api/admin/services/${service.id}`, { method: 'PATCH', body: { status: 'active' } });
      } else {
        await authed(`/api/admin/services/${service.id}`, { method: 'DELETE' });
      }
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not change status.');
    }
  };

  const toggleDoctor = (doctorId: number) => {
    setForm((current) => ({
      ...current,
      doctor_ids: current.doctor_ids.includes(doctorId)
        ? current.doctor_ids.filter((id) => id !== doctorId)
        : [...current.doctor_ids, doctorId],
    }));
  };

  const dialog = (creating || editing) && (
    <Modal title={editing ? `Edit ${editing.name}` : 'Add service'} onClose={() => { setCreating(false); setEditing(null); }} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Category">
            <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputClass} placeholder="Surgical / ENT / Procedures" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputClass} />
            </Field>
          </div>
          <Field label="Price (PKR)">
            <input type="number" min={0} value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} className={inputClass} />
          </Field>
          <Field label="Duration (minutes)">
            <input type="number" min={5} step={5} value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: Number(e.target.value) })} className={inputClass} />
          </Field>
          <Field label="Image URL">
            <input value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Sort order" hint="Lower numbers appear first on the website.">
            <input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} className={inputClass} />
          </Field>
        </div>

        <Field label="Offered by">
          <div className="flex flex-wrap gap-2">
            {doctors.map((doctor) => (
              <button
                key={doctor.id}
                type="button"
                onClick={() => toggleDoctor(doctor.id)}
                aria-pressed={form.doctor_ids.includes(doctor.id)}
                className={`rounded-full border px-3 py-1 text-sm font-semibold ${
                  form.doctor_ids.includes(doctor.id)
                    ? 'border-accent bg-soft text-brand'
                    : 'border-slate-200 text-slate-600'
                }`}
              >
                {doctor.name}
              </button>
            ))}
          </div>
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={() => { setCreating(false); setEditing(null); }}>Cancel</Button>
          <Button type="submit">{editing ? 'Save changes' : 'Create service'}</Button>
        </div>
      </form>
    </Modal>
  );

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">Services</h2>
          <p className="text-sm text-slate-500">What the clinic offers, and at what price.</p>
        </div>
        <Button onClick={openCreate}>Add service</Button>
      </div>

      {loading ? (
        <EmptyState>Loading services…</EmptyState>
      ) : services.length === 0 ? (
        <EmptyState>No services yet.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {services.map((service) => (
            <Card key={service.id} className={service.status === 'inactive' ? 'opacity-60' : ''}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-bold text-slate-900">{service.name}</h3>
                {service.status === 'inactive' ? <Badge tone="red">Hidden</Badge> : <Badge tone="green">Live</Badge>}
              </div>
              <div className="mt-1 text-xs uppercase tracking-wide text-accent">{service.category}</div>
              <p className="mt-2 text-sm text-slate-600">{service.description}</p>
              <div className="mt-3 text-sm font-semibold text-slate-800">
                Rs. {(service.price ?? 0).toLocaleString('en-PK')} • {service.duration_minutes} min
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {service.doctor_ids?.length
                  ? doctors.filter((d) => service.doctor_ids?.includes(d.id)).map((d) => d.name).join(', ')
                  : 'No doctors linked'}
              </div>
              <div className="mt-4 flex gap-2">
                <Button variant="ghost" onClick={() => openEdit(service)}>Edit</Button>
                <Button variant={service.status === 'inactive' ? 'ghost' : 'danger'} onClick={() => void toggleActive(service)}>
                  {service.status === 'inactive' ? 'Show' : 'Hide'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {dialog}
    </section>
  );
}
