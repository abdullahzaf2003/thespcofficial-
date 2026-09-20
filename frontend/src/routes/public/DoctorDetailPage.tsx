import { useEffect, useState } from 'react';
import { request, WEEKDAYS, type Doctor, type Service, type Slot, type AvailabilityWindow } from '../../lib/api';
import { SiteHeader, SiteFooter, SiteLink, type SiteGeneral } from './SiteChrome';

/** Doctor detail page: full bio, services offered, and an availability preview (Section 4.2.2). */

type DoctorDetail = Doctor & {
  languages?: string;
  services: Service[];
  availability: AvailabilityWindow[];
};

const DEFAULT_GENERAL: SiteGeneral = {
  site_name: 'Surgeons Poly Clinic',
  site_subtitle: 'Model Town, Lahore • Open 24/7',
  address: '422, Block Q, Model Town, Lahore',
  status: 'Open 24/7',
  call_phone: '042-34500888',
  alternate_phone: '042-38900939',
  whatsapp_number: '923084213201',
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function DoctorDetailPage({ doctorId }: { doctorId: string }) {
  const [general, setGeneral] = useState<SiteGeneral>(DEFAULT_GENERAL);
  const [doctor, setDoctor] = useState<DoctorDetail | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [date, setDate] = useState(todayIso());
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const info = await request<Record<string, string>>('/api/clinic-info');
        setGeneral({
          site_name: info.clinic_name || DEFAULT_GENERAL.site_name,
          site_subtitle: info.clinic_subtitle || DEFAULT_GENERAL.site_subtitle,
          address: info.address || DEFAULT_GENERAL.address,
          status: info.opening_hours || DEFAULT_GENERAL.status,
          call_phone: info.phone_primary || DEFAULT_GENERAL.call_phone,
          alternate_phone: info.phone_secondary,
          whatsapp_number: info.whatsapp_number || DEFAULT_GENERAL.whatsapp_number,
        });
      } catch {
        /* defaults are fine */
      }
    })();
  }, []);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    void (async () => {
      try {
        const payload = await request<DoctorDetail>(`/api/doctors/${encodeURIComponent(doctorId)}`);
        setDoctor(payload);
        document.title = `${payload.name} — ${payload.specialty}`;
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [doctorId]);

  useEffect(() => {
    if (!doctor) return;
    void (async () => {
      try {
        const payload = await request<{ slots: Slot[] }>(`/api/doctors/${doctor.id}/availability?date=${date}`);
        setSlots(payload.slots || []);
      } catch {
        setSlots([]);
      }
    })();
  }, [doctor, date]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white">
        <SiteHeader general={general} />
        <p className="py-24 text-center text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (notFound || !doctor) {
    return (
      <div className="min-h-screen bg-white">
        <SiteHeader general={general} />
        <div className="mx-auto max-w-3xl px-4 py-24 text-center">
          <h1 className="text-3xl font-black text-slate-900">Doctor not found</h1>
          <p className="mt-2 text-slate-600">This profile may no longer be available.</p>
          <SiteLink to="/#doctors" className="mt-6 inline-block rounded-full bg-brand px-6 py-3 font-semibold text-white">
            See all doctors
          </SiteLink>
        </div>
        <SiteFooter general={general} />
      </div>
    );
  }

  const openSlots = slots.filter((slot) => slot.available);

  return (
    <div className="min-h-screen bg-white text-slate-800">
      <SiteHeader general={general} />

      <main>
        <section className="bg-canvas">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:grid-cols-[280px_1fr] md:items-start">
            {doctor.image ? (
              <img src={doctor.image} alt={doctor.name} className="w-full rounded-3xl object-cover shadow-lg" />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center rounded-3xl bg-white text-6xl font-black text-slate-300 shadow-lg">
                {doctor.name.slice(0, 1)}
              </div>
            )}

            <div>
              <SiteLink to="/#doctors" className="text-sm font-semibold text-accent">← All doctors</SiteLink>
              <h1 className="mt-3 text-4xl font-black text-slate-900">{doctor.name}</h1>
              <div className="mt-2 text-lg font-semibold text-accent">{doctor.specialty}</div>
              {doctor.qualifications && <div className="mt-2 text-sm text-slate-600">{doctor.qualifications}</div>}

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <div className="rounded-2xl bg-white p-4 shadow-sm">
                  <div className="text-2xl font-black text-brand">
                    Rs. {(doctor.consultation_fee ?? 0).toLocaleString('en-PK')}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Consultation</div>
                </div>
                <div className="rounded-2xl bg-white p-4 shadow-sm">
                  <div className="text-2xl font-black text-brand">{doctor.years_experience || '—'}</div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Years experience</div>
                </div>
                <div className="rounded-2xl bg-white p-4 shadow-sm">
                  <div className="text-2xl font-black text-brand">{doctor.slot_duration_minutes ?? 20} min</div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Per consultation</div>
                </div>
              </div>

              <SiteLink to="/#booking" className="mt-6 inline-block rounded-full bg-brand px-6 py-3 font-semibold text-white">
                Book with {doctor.name.split(' ').slice(-1)[0]}
              </SiteLink>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16">
          <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
            <div>
              {doctor.bio && (
                <>
                  <h2 className="text-2xl font-black text-slate-900">About</h2>
                  <p className="mt-3 leading-7 text-slate-600">{doctor.bio}</p>
                </>
              )}

              {doctor.services?.length > 0 && (
                <div className="mt-10">
                  <h2 className="text-2xl font-black text-slate-900">Services offered</h2>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {doctor.services.map((service) => (
                      <div key={service.id} className="rounded-2xl border border-slate-200 p-4">
                        <div className="font-bold text-slate-900">{service.name}</div>
                        <p className="mt-1 text-sm text-slate-600">{service.description}</p>
                        <div className="mt-2 text-sm font-semibold text-accent">
                          Rs. {(service.price ?? 0).toLocaleString('en-PK')} • {service.duration_minutes} min
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {doctor.languages && (
                <div className="mt-10">
                  <h2 className="text-2xl font-black text-slate-900">Languages</h2>
                  <p className="mt-2 text-slate-600">{doctor.languages}</p>
                </div>
              )}
            </div>

            <aside>
              <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                <h2 className="text-xl font-black text-slate-900">Availability</h2>

                {doctor.availability?.length > 0 && (
                  <ul className="mt-4 space-y-1 text-sm text-slate-600">
                    {[...doctor.availability]
                      .sort((a, b) => a.weekday - b.weekday)
                      .map((row) => (
                        <li key={`${row.weekday}-${row.start_time}`} className="flex justify-between">
                          <span>{WEEKDAYS[row.weekday]}</span>
                          <span className="font-medium text-slate-800">{row.start_time} – {row.end_time}</span>
                        </li>
                      ))}
                  </ul>
                )}

                <div className="mt-6 border-t border-slate-200 pt-4">
                  <label className="mb-2 block text-xs font-semibold text-slate-600">Check a specific day</label>
                  <input
                    type="date"
                    min={todayIso()}
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  />

                  <div className="mt-3">
                    {openSlots.length === 0 ? (
                      <p className="text-sm text-slate-500">No free slots on this date.</p>
                    ) : (
                      <>
                        <p className="mb-2 text-xs font-semibold text-slate-500">{openSlots.length} slots free</p>
                        <div className="flex flex-wrap gap-2">
                          {openSlots.slice(0, 12).map((slot) => (
                            <span key={slot.start} className="rounded-lg bg-soft px-2 py-1 text-xs font-semibold text-brand">
                              {slot.time}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <SiteLink to="/#booking" className="mt-5 block rounded-xl bg-brand px-4 py-3 text-center font-bold text-white">
                    Book an appointment
                  </SiteLink>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </main>

      <SiteFooter general={general} />
    </div>
  );
}
