/**
 * API client.
 *
 * Requests go to a relative /api path, which Vite proxies to the Express
 * server, so the browser stays same-origin (no CORS, and the httpOnly refresh
 * cookie is sent automatically).
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}) as Record<string, unknown>);

  if (!response.ok) {
    const data = payload as { message?: string; code?: string };
    throw new ApiError(response.status, data.message || 'Request failed.', data.code);
  }

  return payload as T;
}

export function signalingUrl(role: string, token: string): string {
  const base = API_BASE
    ? API_BASE.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
  return `${base}/ws?role=${encodeURIComponent(role)}&token=${encodeURIComponent(token)}`;
}

// ------------------------------------------------------------ shared types

export type Doctor = {
  id: number;
  name: string;
  specialty: string;
  qualifications?: string;
  image?: string;
  bio?: string;
  consultation_fee?: number;
  currency?: string;
  years_experience?: number;
  slot_duration_minutes?: number;
};

export type Service = {
  id: number;
  name: string;
  slug: string;
  description?: string;
  category?: string;
  price?: number;
  duration_minutes?: number;
  doctor_ids?: number[];
};

export type Slot = {
  start: string;
  end: string;
  time: string;
  available: boolean;
};

export type AppointmentStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'in_reception'
  | 'with_doctor'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type Appointment = {
  id: number;
  patient_name: string;
  email?: string;
  phone?: string;
  patient_whatsapp?: string;
  doctor_id: number;
  doctor_name: string;
  service_id?: number | null;
  slot_start: string;
  slot_end?: string;
  appointment_date: string;
  appointment_time: string;
  note?: string;
  status: AppointmentStatus;
  payment_status: 'unpaid' | 'pending_verification' | 'verified';
  receptionist_notes?: string;
  doctor_notes?: string;
  current_room?: string | null;
};

/** Signature of the authenticated request helper returned by useSession. */
export type Authed = <T>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;

export type AdminDoctor = Doctor & {
  username?: string;
  enabled?: number;
  status?: string;
  socket_room_id?: string;
  languages?: string;
  verification?: string;
  wait_time?: string;
  timing_note?: string;
  tags?: string;
};

export type BlogPost = {
  id: number;
  title: string;
  slug?: string;
  excerpt?: string;
  content?: string;
  image?: string;
  author?: string;
  status?: string;
  tags?: string;
  seo_title?: string;
  seo_description?: string;
  published_at?: string | null;
  created_at?: string;
};

export type AvailabilityWindow = {
  id?: number;
  weekday: number;
  start_time: string;
  end_time: string;
  enabled?: number | boolean;
};

export type DateOverride = {
  id: number;
  date: string;
  kind: string;
  start_time?: string | null;
  end_time?: string | null;
  reason?: string;
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
