import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { request, ApiError, type Slot } from '../lib/api';
import { SiteHeader, SiteFooter, SiteLink, telHref, whatsappHref } from './public/SiteChrome';

/**
 * Public clinic website.
 *
 * The visual design is unchanged from the original build. What changed is the
 * booking module underneath it: slots now come from real per-doctor
 * availability, the chosen slot is held while the form is filled in, and both
 * email and WhatsApp are mandatory (Section 5.3).
 */

const SERVICE_IMAGES = [
  'https://images.unsplash.com/photo-1584515933487-779824d29309?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1538108149393-fbbd818959ec?auto=format&fit=crop&w=900&q=80',
];
const DOCTOR_IMAGES = [
  'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=700&q=80&crop=faces',
  'https://images.unsplash.com/photo-1537368910025-700350fe46c7?auto=format&fit=crop&w=700&q=80&crop=faces',
  'https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?auto=format&fit=crop&w=700&q=80&crop=faces',
  'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=700&q=80&crop=faces',
];

const DEFAULT_GENERAL = {
  site_name: 'Surgeons Poly Clinic',
  site_subtitle: 'Model Town, Lahore • Open 24/7',
  location: 'Model Town, Lahore',
  address: '422, Block Q, Model Town, Lahore',
  status: 'Open 24/7',
  tagline: 'Verified specialists • 24/7 emergency care',
  hero_title_line_1: 'Trusted Surgical',
  hero_title_line_2: '& ENT Care in',
  hero_title_line_3: 'Lahore',
  hero_intro:
    'Surgeons Poly Clinic is a small multi-specialty medical centre in Model Town, Lahore, focused on General Surgery and ENT care with experienced doctors, transparent consultation fees, and emergency support available around the clock.',
  hero_primary_cta: 'Book Appointment',
  hero_secondary_cta: 'Call 042-34500888',
  services_eyebrow: 'Clinics & Specialties',
  services_heading: 'Complete Surgical & ENT Services',
  services_intro:
    'Surgeons Poly Clinic offers a focused range of surgical and ENT services, including general surgery, breast health care, thyroid and neck evaluation, sinus and hearing treatment, and routine minor procedures.',
  doctors_eyebrow: 'Most Experienced Doctors',
  doctors_heading: 'Most Experienced Doctors in Surgeons Poly Clinic — Lahore',
  doctors_intro: '',
  why_choose_title: 'Why Patients Choose Us',
  experience_quote: 'Experienced Care.',
  why_choose_description:
    'Surgeons Poly Clinic provides focused surgical and ENT care in a compact multi-specialty setting, with verified specialists, transparent consultation rates, and emergency coverage available 24/7.',
  about_body: '',
  location_badge: 'Model Town, Lahore',
  stat_1_value: '2',
  stat_1_label: 'Active doctors',
  stat_2_value: '18+',
  stat_2_label: 'Years experience',
  stat_3_value: '24/7',
  stat_3_label: 'Emergency access',
  emergency_title: 'Emergency access',
  emergency_description: 'Open 24/7 for emergency cases and immediate surgical support.',
  faq_heading: 'Questions patients ask',
  faq_intro: '',
  booking_heading: 'Book a consultation',
  booking_intro: 'Choose a doctor and a time.',
  reviews_heading: 'What our patients say',
  reviews_intro: 'Reviews from patients who completed a consultation with us.',
  contact_heading: 'Get in Touch',
  contact_intro: 'We are open 24/7 for emergencies. Call ahead to confirm doctor availability and consultation timing.',
  call_phone: '042-34500888',
  alternate_phone: '042-38900939',
  consultation_fee: 'Rs. 3,000',
  consultation_fee_amount: 3000,
  whatsapp_number: '923084213201',
  email_public: '',
  maps_url: '',
  calling_hours: '',
  footer_note: '',
};

type Doctor = {
  id: number;
  name: string;
  specialty: string;
  qualifications?: string;
  image?: string;
  bio?: string;
  verification?: string;
  wait_time?: string;
  timing_note?: string;
  tags?: string;
  years_experience?: number;
  consultation_fee?: number;
};

type Faq = { id: number; question: string; answer: string };
type Blog = { id: number; title: string; slug?: string; excerpt?: string; content?: string; image?: string; author?: string };
type Review = { id: number; patient_name: string; doctor_name?: string; rating: number; message: string };
type ServiceRow = {
  id: number;
  name: string;
  slug?: string;
  description?: string;
  category?: string;
  image?: string;
  price?: number;
  currency?: string;
  duration_minutes?: number;
  doctor_ids?: number[];
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function PublicSite() {
  const [site, setSite] = useState({
    general: DEFAULT_GENERAL,
    doctors: [] as Doctor[],
    services: [] as ServiceRow[],
    blogs: [] as Blog[],
    reviews: [] as Review[],
    faqs: [] as Faq[],
  });

  /**
   * Whether the booking API answered.
   *
   * The website is static and served from a CDN, so it stays up even when the
   * API does not. Without this flag the page would look completely normal
   * while the booking form quietly did nothing — the patient would try once
   * and leave. The clinic's fallback is the telephone, so say so.
   */
  const [apiReachable, setApiReachable] = useState(true);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  const [bookingForm, setBookingForm] = useState({
    patient_name: '',
    email: '',
    patient_whatsapp: '',
    note: '',
  });
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [holdToken, setHoldToken] = useState<string | null>(null);
  const [bookingMessage, setBookingMessage] = useState('');
  const [bookingError, setBookingError] = useState('');
  const [submitting, setSubmitting] = useState(false);


  const doctors = site.doctors;
  const reviews = site.reviews;
  const blogs = site.blogs;

  const fetchSiteContent = async () => {
    try {
      const payload = await request<{
        general?: Partial<typeof DEFAULT_GENERAL>;
        doctors?: Doctor[];
        services?: ServiceRow[];
        blogs?: Blog[];
        reviews?: Review[];
        faqs?: Faq[];
      }>('/api/site-content');

      setSite({
        general: { ...DEFAULT_GENERAL, ...(payload.general || {}) },
        doctors: payload.doctors || [],
        services: payload.services || [],
        blogs: payload.blogs || [],
        reviews: payload.reviews || [],
        faqs: payload.faqs || [],
      });
      setApiReachable(true);
    } catch (error) {
      console.error('Site load failed', error);
      setApiReachable(false);
    }
  };

  useEffect(() => {
    void fetchSiteContent();
  }, []);

  useEffect(() => {
    if (!doctors.length || selectedDoctorId) return;
    setSelectedDoctorId(doctors[0].id);
  }, [doctors, selectedDoctorId]);

  useEffect(() => {
    if (!selectedDoctorId) return;
    void loadSlots(selectedDoctorId, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoctorId, selectedDate]);

  // Release a hold if the patient navigates away mid-booking.
  useEffect(() => {
    if (!holdToken) return;
    const release = () =>
      navigator.sendBeacon?.(`/api/appointments/hold/${holdToken}`) ??
      void request(`/api/appointments/hold/${holdToken}`, { method: 'DELETE' }).catch(() => {});
    window.addEventListener('beforeunload', release);
    return () => window.removeEventListener('beforeunload', release);
  }, [holdToken]);

  const loadSlots = async (doctorId: number, date: string) => {
    setSlotsLoading(true);
    try {
      const payload = await request<{ slots: Slot[] }>(`/api/doctors/${doctorId}/availability?date=${date}`);
      setSlots(payload.slots || []);
    } catch (error) {
      console.error('Slot load failed', error);
      setSlots([]);
    } finally {
      setSlotsLoading(false);
      setSelectedSlot(null);
      setHoldToken(null);
    }
  };

  /** Holds the slot as soon as it is picked, so nobody else can take it. */
  const pickSlot = async (slot: Slot) => {
    if (!selectedDoctorId) return;
    setBookingError('');

    if (holdToken) {
      await request(`/api/appointments/hold/${holdToken}`, { method: 'DELETE' }).catch(() => {});
      setHoldToken(null);
    }

    try {
      const hold = await request<{ holdToken: string }>('/api/appointments/hold', {
        method: 'POST',
        body: { doctor_id: selectedDoctorId, slot_start: slot.start },
      });
      setSelectedSlot(slot);
      setHoldToken(hold.holdToken);
    } catch (error) {
      setBookingError(error instanceof ApiError ? error.message : 'That time is no longer available.');
      setSelectedSlot(null);
      void loadSlots(selectedDoctorId, selectedDate);
    }
  };

  const handleBookingSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBookingError('');
    setBookingMessage('');

    if (!selectedSlot) {
      setBookingError('Please choose an appointment time.');
      return;
    }

    setSubmitting(true);
    try {
      const payload = await request<{ notice: string; appointment: { appointment_date: string; appointment_time: string; doctor_name: string } }>(
        '/api/appointments',
        {
          method: 'POST',
          body: {
            patient_name: bookingForm.patient_name,
            email: bookingForm.email,
            patient_whatsapp: bookingForm.patient_whatsapp,
            doctor_id: selectedDoctorId,
            service_id: selectedServiceId,
            slot_start: selectedSlot.start,
            hold_token: holdToken,
            note: bookingForm.note,
          },
        },
      );

      setBookingMessage(
        `Your appointment with ${payload.appointment.doctor_name} is confirmed for ${payload.appointment.appointment_date} at ${payload.appointment.appointment_time}. ${payload.notice}`,
      );
      setBookingForm({ patient_name: '', email: '', patient_whatsapp: '', note: '' });
      setSelectedSlot(null);
      setHoldToken(null);
      if (selectedDoctorId) void loadSlots(selectedDoctorId, selectedDate);
    } catch (error) {
      setBookingError(error instanceof ApiError ? error.message : 'Booking failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedDoctor = doctors.find((doctor) => doctor.id === selectedDoctorId) || doctors[0];
  const selectedService = site.services.find((service) => service.id === selectedServiceId) || null;
  const faqs = site.faqs || [];
  const stats = [
    { value: site.general.stat_1_value, label: site.general.stat_1_label },
    { value: site.general.stat_2_value, label: site.general.stat_2_label },
    { value: site.general.stat_3_value, label: site.general.stat_3_label },
  ].filter((stat) => stat.value && stat.label);
  const whatsappLink = whatsappHref(site.general.whatsapp_number);
  const phoneHref = telHref(site.general.call_phone);

  /**
   * Services grouped by category, which is what Section 4.2.3 asks for: a
   * browsable list with price and duration, not four decorative cards. The
   * fallback below only applies to an empty database — once the clinic has
   * services, the list is entirely theirs.
   */
  const serviceGroups = useMemo(() => {
    const rows = site.services.length
      ? site.services
      : [
          { id: -1, name: 'General Surgery', category: 'Surgical', description: 'Hernia, appendicitis, lumps, gallbladder, and soft tissue surgical care.' },
          { id: -2, name: 'Breast Care', category: 'Surgical', description: 'Breast lumps, assessment, and surgical review.' },
          { id: -3, name: 'ENT Care', category: 'ENT', description: 'Sinus care, hearing issues, tonsils, throat infections, and nasal health.' },
          { id: -4, name: 'Minor Procedures', category: 'Procedures', description: 'Quick assessments and minor treatment planning.' },
        ];

    const byCategory = new Map<string, ServiceRow[]>();
    for (const service of rows as ServiceRow[]) {
      const key = service.category || 'Other services';
      byCategory.set(key, [...(byCategory.get(key) || []), service]);
    }
    return [...byCategory.entries()];
  }, [site.services]);

  /**
   * Picking a service jumps to the booking form with it already chosen, and
   * with a doctor who actually offers it — the click-through the requirements
   * ask for. Without the doctor switch you could land on the form with a
   * service the selected doctor does not provide.
   */
  const chooseService = (service: ServiceRow) => {
    if (service.id > 0) {
      setSelectedServiceId(service.id);
      const offering = service.doctor_ids || [];
      if (offering.length && !offering.includes(selectedDoctorId ?? -1)) {
        setSelectedDoctorId(offering[0]);
      }
    }
    document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth' });
  };

  const money = (amount?: number, currency?: string) =>
    amount ? `${currency || 'Rs.'} ${Number(amount).toLocaleString('en-PK')}` : null;

  return (
    <div className="min-h-screen bg-white text-slate-800">
      <SiteHeader general={site.general} onHome />

      {!apiReachable && (
        <div role="alert" className="bg-warn-soft px-4 py-3 text-center text-sm text-slate-800">
          <span className="font-semibold">Online booking is temporarily unavailable.</span>{' '}
          Please call{' '}
          <a href={phoneHref} className="font-semibold text-brand underline underline-offset-2">
            {site.general.call_phone}
          </a>{' '}
          — the clinic is open and answering as usual.
        </div>
      )}

      <main>
        <section className="relative overflow-hidden bg-canvas">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-24">
            <div>
              <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-soft px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-accent">
                <span className="h-2 w-2 rounded-full bg-accent-400" />
                {site.general.tagline}
              </div>
              <h1 className="text-4xl font-black leading-tight text-slate-900 md:text-6xl">
                {site.general.hero_title_line_1}
                <br />
                {site.general.hero_title_line_2}{' '}
                <span className="italic text-accent">{site.general.hero_title_line_3}</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-600">{site.general.hero_intro}</p>

              <div className="mt-8 flex flex-wrap gap-4">
                <a href={phoneHref} className="inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 font-semibold text-white shadow-lg shadow-blue-950/10">{site.general.call_phone}</a>
                <a href={whatsappLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-brand px-6 py-3 font-semibold text-brand">WhatsApp</a>
              </div>

              <div className="mt-10 grid gap-5 sm:grid-cols-3">
                <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                  <div className="text-2xl font-black text-brand">24/7</div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Emergency</div>
                </div>
                <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                  <div className="text-2xl font-black text-brand">18+</div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Years</div>
                </div>
                <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                  <div className="text-2xl font-black text-brand">{site.general.consultation_fee}</div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Consultation</div>
                </div>
              </div>
            </div>

            <div className="rounded-[28px] bg-white p-5 shadow-[0_30px_80px_rgba(0,0,0,0.12)] ring-1 ring-slate-200">
              <div className="mb-4 flex items-center gap-3">
                <img src={selectedDoctor?.image || DOCTOR_IMAGES[0]} alt={selectedDoctor?.name || 'Doctor'} className="h-16 w-16 rounded-2xl object-cover object-center" />
                <div>
                  <div className="text-lg font-bold text-slate-900">{selectedDoctor?.name || 'Asst. Prof. Dr. Ayesha Choudary'}</div>
                  <div className="text-sm text-accent">{selectedDoctor?.specialty || 'General Surgeon • Breast Surgeon'}</div>
                </div>
              </div>

              <div className="rounded-2xl bg-canvas p-4">
                <div className="mb-3 flex items-center justify-between pb-3 text-sm text-slate-600">
                  <span className="font-semibold text-accent">Next available</span>
                  <span>{slots.find((slot) => slot.available)?.time || 'Check the calendar'}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center text-xs">
                  <div className="rounded-xl bg-white p-3">
                    <div className="font-black text-slate-800">{site.general.consultation_fee}</div>
                    <div className="text-slate-500">Fee</div>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <div className="font-black text-slate-800">20 min</div>
                    <div className="text-slate-500">Per slot</div>
                  </div>
                </div>
              </div>

              <div className="mt-4 text-sm text-slate-600">
                We schedule patient visits in 20-minute slots. Your video consultation link is sent by email and
                WhatsApp 5 minutes before your appointment.
              </div>
              <a href="#booking" className="mt-4 inline-flex w-full justify-center rounded-xl bg-brand px-4 py-3 font-bold text-white">Book Appointment</a>
            </div>
          </div>
        </section>

        <section id="services" className="mx-auto max-w-7xl px-4 py-20">
          <div className="mb-10 text-center">
            <div className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-accent">{site.general.services_eyebrow}</div>
            <h2 className="text-4xl font-black text-slate-900">{site.general.services_heading}</h2>
            {site.general.services_intro && (
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600">{site.general.services_intro}</p>
            )}
          </div>

          <div className="space-y-12">
            {serviceGroups.map(([category, services]) => (
              <div key={category}>
                <div className="mb-5 flex items-center gap-4">
                  <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-accent">{category}</h3>
                  <span className="h-px flex-1 bg-slate-200" />
                  <span className="text-xs text-slate-400">
                    {services.length} {services.length === 1 ? 'service' : 'services'}
                  </span>
                </div>

                <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                  {services.map((service) => {
                    const price = money(service.price, service.currency);
                    const bookable = service.id > 0;

                    return (
                      <div
                        key={service.id}
                        className="flex flex-col rounded-card bg-white p-6 shadow-card ring-1 ring-slate-200 transition hover:shadow-lift"
                      >
                        <h4 className="text-lg font-bold text-slate-900">{service.name}</h4>

                        {(price || service.duration_minutes) && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold">
                            {price && <span className="rounded-full bg-soft px-2.5 py-1 text-brand">{price}</span>}
                            {service.duration_minutes ? (
                              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">
                                {service.duration_minutes} min
                              </span>
                            ) : null}
                          </div>
                        )}

                        {service.description && (
                          <p className="mt-3 flex-1 text-sm leading-6 text-slate-600">{service.description}</p>
                        )}

                        {bookable && (
                          <button
                            onClick={() => chooseService(service)}
                            className="mt-5 self-start rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
                          >
                            Book this
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Why Patients Choose Us — the clinic's own copy, with the figures
            it quotes. All of it is editable from the dashboard. */}
        <section id="about" className="bg-brand py-20 text-white">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              {site.general.location_badge && (
                <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-sky-100">
                  <span className="h-2 w-2 rounded-full bg-accent-400" />
                  {site.general.location_badge}
                </div>
              )}

              <h2 className="text-4xl font-black">{site.general.why_choose_title}</h2>

              {site.general.experience_quote && (
                <p className="mt-4 font-display text-2xl italic text-accent-400">{site.general.experience_quote}</p>
              )}

              <p className="mt-4 max-w-xl leading-7 text-slate-200">{site.general.why_choose_description}</p>

              {site.general.about_body && (
                <p className="mt-4 max-w-xl text-sm leading-7 text-slate-300">{site.general.about_body}</p>
              )}
            </div>

            {stats.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
                {stats.map((stat) => (
                  <div key={stat.label} className="rounded-card bg-white/5 p-6 text-center lg:text-left">
                    <div className="font-display text-4xl font-bold text-accent-400">{stat.value}</div>
                    <div className="mt-1 text-sm text-slate-300">{stat.label}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section id="doctors" className="bg-slate-50 py-20">
          <div className="mx-auto max-w-7xl px-4">
            <div className="mb-10">
              <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-accent">{site.general.doctors_eyebrow}</div>
              <h2 className="text-4xl font-black text-slate-900">{site.general.doctors_heading}</h2>
              {site.general.doctors_intro && (
                <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">{site.general.doctors_intro}</p>
              )}
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              {doctors.map((doctor, index) => (
                <div key={doctor.id} className="grid overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm md:grid-cols-[220px_1fr]">
                  <img src={doctor.image || DOCTOR_IMAGES[index % DOCTOR_IMAGES.length]} alt={doctor.name} className="h-64 w-full object-cover md:h-full" />
                  <div className="p-6">
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <h3 className="text-xl font-bold text-slate-900">{doctor.name}</h3>
                      {/* The precise regulator wording rather than a vague
                          "Verified" badge — it is a factual claim. */}
                      {doctor.verification && (
                        <span className="shrink-0 rounded-full bg-soft px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-accent">
                          {doctor.verification}
                        </span>
                      )}
                    </div>
                    <div className="mb-2 text-sm font-semibold text-accent">{doctor.specialty}</div>
                    <div className="mb-3 text-sm text-slate-600">{doctor.qualifications || 'Certified clinical specialist'}</div>

                    {/* The practical details a patient actually decides on. */}
                    <div className="mb-3 flex flex-wrap gap-2 text-xs font-semibold">
                      {doctor.years_experience ? (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
                          {doctor.years_experience} years experience
                        </span>
                      ) : null}
                      {doctor.wait_time && (
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">Wait: {doctor.wait_time}</span>
                      )}
                      {doctor.consultation_fee ? (
                        <span className="rounded-full bg-soft px-2.5 py-1 text-brand">
                          Rs. {Number(doctor.consultation_fee).toLocaleString('en-PK')}
                        </span>
                      ) : null}
                    </div>

                    {doctor.timing_note && (
                      <div className="mb-3 text-sm text-slate-600">
                        <span className="font-semibold text-slate-800">Clinic hours:</span> {doctor.timing_note}
                      </div>
                    )}

                    {doctor.tags && (
                      <div className="mb-3 flex flex-wrap gap-1.5">
                        {doctor.tags.split('|').filter(Boolean).map((tag) => (
                          <span key={tag} className="rounded-md bg-canvas px-2 py-0.5 text-xs text-slate-600">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <p className="mb-4 text-sm leading-6 text-slate-600">{doctor.bio || 'Experienced practitioner with patient-focused surgical and ENT care.'}</p>
                    <button
                      onClick={() => {
                        setSelectedDoctorId(doctor.id);
                        document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth' });
                      }}
                      className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white"
                    >
                      Book Appointment
                    </button>
                    <SiteLink
                      to={`/doctors/${doctor.id}`}
                      className="ml-3 text-sm font-semibold text-accent"
                    >
                      View profile →
                    </SiteLink>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="booking" className="mx-auto max-w-7xl px-4 py-20">
          <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
            <div className="rounded-3xl bg-brand p-8 text-white">
              <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-sky-200">Appointment Schedule</div>
              <h3 className="text-3xl font-black">{site.general.booking_heading}</h3>
              <p className="mt-3 text-sm text-slate-200">{site.general.booking_intro}</p>
              <div className="mt-6 rounded-2xl bg-white/5 p-4">
                <div className="text-sm text-sky-100">Selected doctor</div>
                <div className="mt-1 text-xl font-bold">{selectedDoctor?.name || 'Select a doctor'}</div>
                <div className="mt-2 text-sm text-slate-200">{selectedDoctor?.specialty || 'Specialist consultation'}</div>

                {/* Confirms the click-through from the services list landed,
                    and gives a way out of it. */}
                {selectedService && (
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/10 pt-3">
                    <div>
                      <div className="text-xs text-sky-100">For</div>
                      <div className="text-sm font-semibold">{selectedService.name}</div>
                    </div>
                    <button
                      onClick={() => setSelectedServiceId(null)}
                      className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold hover:bg-white/20"
                    >
                      Change
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-4 rounded-2xl bg-white/5 p-4 text-sm text-slate-200">
                <p className="font-semibold text-white">How your consultation works</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-slate-300">
                  <li>You receive a confirmation right away.</li>
                  <li>Your video link arrives 5 minutes before, by email and WhatsApp.</li>
                  <li>You join reception, who verify your payment.</li>
                  <li>Reception connects you to your doctor.</li>
                </ol>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              {/* The form is useless without the doctor list, so replace it
                  outright rather than showing inputs that cannot submit. */}
              {!apiReachable ? (
                <div className="py-6 text-center">
                  <h3 className="text-xl font-bold text-slate-900">Booking is temporarily offline</h3>
                  <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-600">
                    We cannot take online bookings right now, but the clinic is open and answering the phone as usual.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-3">
                    <a href={phoneHref} className="rounded-full bg-brand px-6 py-3 font-semibold text-white">
                      Call {site.general.call_phone}
                    </a>
                    <a
                      href={whatsappLink}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full border border-brand px-6 py-3 font-semibold text-brand"
                    >
                      WhatsApp us
                    </a>
                  </div>
                  {site.general.alternate_phone && (
                    <p className="mt-4 text-sm text-slate-500">
                      Or{' '}
                      <a href={telHref(site.general.alternate_phone)} className="font-semibold text-accent">
                        {site.general.alternate_phone}
                      </a>
                    </p>
                  )}
                </div>
              ) : (
              <form onSubmit={handleBookingSubmit} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="patient_name" className="mb-1 block text-xs font-semibold text-slate-600">Full name *</label>
                    <input
                      id="patient_name"
                      required
                      value={bookingForm.patient_name}
                      onChange={(event) => setBookingForm({ ...bookingForm, patient_name: event.target.value })}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      placeholder="Full name"
                    />
                  </div>
                  <div>
                    <label htmlFor="patient_whatsapp" className="mb-1 block text-xs font-semibold text-slate-600">WhatsApp number *</label>
                    <input
                      id="patient_whatsapp"
                      required
                      type="tel"
                      value={bookingForm.patient_whatsapp}
                      onChange={(event) => setBookingForm({ ...bookingForm, patient_whatsapp: event.target.value })}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      placeholder="03XX XXXXXXX"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="email" className="mb-1 block text-xs font-semibold text-slate-600">Email *</label>
                  <input
                    id="email"
                    required
                    type="email"
                    value={bookingForm.email}
                    onChange={(event) => setBookingForm({ ...bookingForm, email: event.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    placeholder="you@example.com"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    We send your meeting link to both your email and WhatsApp, so either one will get you in.
                  </p>
                </div>

                <div>
                  <label htmlFor="doctor" className="mb-1 block text-xs font-semibold text-slate-600">Doctor</label>
                  <select
                    id="doctor"
                    value={String(selectedDoctorId || '')}
                    onChange={(event) => setSelectedDoctorId(Number(event.target.value))}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  >
                    {doctors.map((doctor) => (
                      <option key={doctor.id} value={doctor.id}>{doctor.name}</option>
                    ))}
                  </select>
                </div>

                <div className="mb-4 flex items-center justify-between gap-3">
                  <h3 className="text-2xl font-black text-slate-900">Available Slots</h3>
                  <input
                    type="date"
                    min={todayIso()}
                    value={selectedDate}
                    onChange={(event) => setSelectedDate(event.target.value)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    aria-label="Appointment date"
                  />
                </div>

                {slotsLoading ? (
                  <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Checking availability…</p>
                ) : slots.length === 0 ? (
                  <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
                    No slots available on this date. {selectedDoctor?.name || 'This doctor'} may not be working — try
                    another day, or call {site.general.call_phone}.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {slots.map((slot) => (
                      <button
                        key={slot.start}
                        type="button"
                        onClick={() => void pickSlot(slot)}
                        className={`rounded-xl border px-3 py-3 text-sm font-semibold ${
                          slot.available
                            ? 'border-accent bg-soft text-brand'
                            : 'border-slate-200 bg-slate-100 text-slate-400 line-through'
                        } ${selectedSlot?.start === slot.start ? 'ring-2 ring-accent' : ''}`}
                        disabled={!slot.available}
                        aria-pressed={selectedSlot?.start === slot.start}
                      >
                        {slot.time}
                      </button>
                    ))}
                  </div>
                )}

                {selectedSlot && (
                  <p className="rounded-xl bg-soft p-3 text-sm text-brand">
                    Holding {selectedSlot.time} for you while you finish this form.
                  </p>
                )}

                <textarea
                  value={bookingForm.note}
                  onChange={(event) => setBookingForm({ ...bookingForm, note: event.target.value })}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  rows={3}
                  placeholder="Reason for appointment"
                  aria-label="Reason for appointment"
                />

                <button
                  type="submit"
                  disabled={submitting || !selectedSlot}
                  className="w-full rounded-xl bg-brand px-4 py-3 font-bold text-white disabled:opacity-50"
                >
                  {submitting ? 'Booking…' : 'Book Consultation'}
                </button>

                {bookingError && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{bookingError}</div>}
                {bookingMessage && <div className="rounded-xl bg-green-50 p-3 text-sm text-green-800">{bookingMessage}</div>}
              </form>
              )}
            </div>
          </div>
        </section>

        <section id="reviews" className="bg-canvas py-20">
          <div className="mx-auto max-w-7xl px-4">
            <div className="mb-10 text-center">
              <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-accent">Patient Reviews</div>
              <h2 className="text-4xl font-black text-slate-900">{site.general.reviews_heading}</h2>
              {site.general.reviews_intro && (
                <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600">{site.general.reviews_intro}</p>
              )}
            </div>

            <div className="mb-8 grid gap-5 lg:grid-cols-3">
              {reviews.length > 0 ? reviews.slice(0, 3).map((review) => (
                <div key={review.id} className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <div className="mb-3 text-yellow-500">{'★'.repeat(review.rating || 5)}</div>
                  <p className="text-sm leading-6 text-slate-600">“{review.message}”</p>
                  <div className="mt-4 border-t border-slate-200 pt-3 text-sm font-semibold text-slate-800">{review.patient_name}</div>
                  <div className="text-xs text-slate-500">{review.doctor_name || 'Clinic Team'}</div>
                </div>
              )) : (
                <div className="rounded-3xl bg-white p-5 text-sm text-slate-500 ring-1 ring-slate-200">No reviews yet. Be the first patient to share feedback.</div>
              )}
            </div>

            {/* The open "leave a review" form is gone. Reviews are now invited
                after a completed consultation and checked before publishing,
                so anyone could no longer post to the home page. */}
            <div className="mx-auto max-w-3xl rounded-card bg-white p-6 text-center shadow-card ring-1 ring-slate-200">
              <h3 className="text-lg font-bold text-slate-900">Been to see us?</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
                After your consultation we send you a link by email and WhatsApp so you can tell us how it went. Every
                review is read by our team before it appears here.
              </p>
            </div>
          </div>
        </section>

        {/* Emergency access. Deliberately loud and above the contact block —
            someone scanning this page in an emergency should not have to read. */}
        {site.general.emergency_title && (
          <section className="mx-auto max-w-7xl px-4 pt-20">
            <div className="flex flex-col items-start justify-between gap-5 rounded-card bg-danger-soft p-8 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-2xl font-black text-danger">{site.general.emergency_title}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
                  {site.general.emergency_description}
                </p>
              </div>
              <a
                href={phoneHref}
                className="shrink-0 rounded-full bg-danger px-6 py-3 font-semibold text-white transition hover:opacity-90"
              >
                Call {site.general.call_phone}
              </a>
            </div>
          </section>
        )}

        {/* Questions patients ask. Answers the phone calls the desk would
            otherwise field, and gives search engines something to index. */}
        {faqs.length > 0 && (
          <section id="faq" className="mx-auto max-w-4xl px-4 py-20">
            <div className="mb-10 text-center">
              <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-accent">FAQ</div>
              <h2 className="text-4xl font-black text-slate-900">{site.general.faq_heading}</h2>
              {site.general.faq_intro && (
                <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600">{site.general.faq_intro}</p>
              )}
            </div>

            <div className="space-y-3">
              {faqs.map((faq, index) => (
                <details
                  key={faq.id}
                  // The first one starts open, so the pattern is obvious
                  // without anyone having to click to discover it.
                  open={index === 0}
                  className="group rounded-card bg-white p-5 shadow-card ring-1 ring-slate-200"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-slate-900">
                    {faq.question}
                    <span className="shrink-0 text-xl text-accent transition group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-600">{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        <section id="contact" className="mx-auto max-w-7xl px-4 py-20">
          <div className="mb-10 text-center">
            <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-accent">Contact</div>
            <h2 className="text-4xl font-black text-slate-900">{site.general.contact_heading}</h2>
            {site.general.contact_intro && (
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600">{site.general.contact_intro}</p>
            )}
          </div>

          <div className="grid gap-5 md:grid-cols-3">
            <div className="rounded-3xl bg-canvas p-6">
              <div className="text-sm font-bold uppercase tracking-wide text-accent">Address</div>
              <div className="mt-3 text-lg font-bold text-slate-900">{site.general.address}</div>
              {site.general.maps_url && (
                <a
                  href={site.general.maps_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block text-sm font-semibold text-accent hover:text-brand"
                >
                  Open in Google Maps →
                </a>
              )}
            </div>
            <div className="rounded-3xl bg-canvas p-6">
              <div className="text-sm font-bold uppercase tracking-wide text-accent">Phone</div>
              <a href={phoneHref} className="mt-3 block text-lg font-bold text-slate-900">{site.general.call_phone}</a>
              <a href={whatsappLink} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent">WhatsApp: {site.general.whatsapp_number}</a>
            </div>
            <div className="rounded-3xl bg-canvas p-6">
              <div className="text-sm font-bold uppercase tracking-wide text-accent">Hours</div>
              <div className="mt-3 text-lg font-bold text-slate-900">{site.general.status}</div>
              {site.general.calling_hours && (
                <div className="mt-2 text-sm text-slate-600">Phone: {site.general.calling_hours}</div>
              )}
              {site.general.email_public && (
                <a href={`mailto:${site.general.email_public}`} className="mt-3 block text-sm font-semibold text-accent hover:text-brand">
                  {site.general.email_public}
                </a>
              )}
            </div>
          </div>
        </section>

        {blogs.length > 0 && (
          <section className="mx-auto max-w-7xl px-4 pb-20">
            <div className="mb-8 text-center">
              <div className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-accent">Latest Articles</div>
              <h2 className="text-4xl font-black text-slate-900">Health updates and guidance</h2>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              {blogs.slice(0, 2).map((blog) => (
                <SiteLink
                  key={blog.id}
                  to={`/blog/${blog.slug || blog.id}`}
                  className="group overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 transition hover:shadow-lg"
                >
                  <article>
                    <img src={blog.image || SERVICE_IMAGES[0]} alt={blog.title} className="h-60 w-full object-cover" />
                    <div className="p-6">
                      <div className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-accent">{blog.author || 'Clinic Team'}</div>
                      <h3 className="text-2xl font-black text-slate-900 group-hover:text-brand">{blog.title}</h3>
                      <p className="mt-3 text-sm leading-6 text-slate-600">{blog.excerpt || blog.content}</p>
                    </div>
                  </article>
                </SiteLink>
              ))}
            </div>

            <div className="mt-8 text-center">
              <SiteLink to="/blog" className="inline-block rounded-full border border-brand px-6 py-3 font-semibold text-brand">
                Read all articles
              </SiteLink>
            </div>
          </section>
        )}
      </main>

      <SiteFooter general={site.general} />
    </div>
  );
}
