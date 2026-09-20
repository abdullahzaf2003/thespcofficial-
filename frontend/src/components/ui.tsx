import { useState } from 'react';
import type { ReactNode } from 'react';

/** Small shared primitives so the admin panels stay consistent and short. */

export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputClass = 'w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-accent focus:outline-none';

export function Button({
  children,
  variant = 'primary',
  ...props
}: { children: ReactNode; variant?: 'primary' | 'ghost' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand-600',
    ghost: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
    danger: 'border border-red-300 text-red-600 hover:bg-red-50',
  };
  return (
    <button
      {...props}
      className={`rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${styles[variant]} ${props.className || ''}`}
    >
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 py-10">
      <div className={`w-full rounded-3xl bg-white p-6 shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-xl'}`}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="text-xl font-black text-slate-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full px-2 text-2xl leading-none text-slate-400 hover:text-slate-700">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 ${className}`}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 ring-1 ring-slate-200">{children}</p>;
}

export function Badge({ tone = 'slate', children }: { tone?: 'slate' | 'green' | 'amber' | 'red'; children: ReactNode }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    green: 'bg-green-100 text-green-700',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
  };
  return <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${tones[tone]}`}>{children}</span>;
}

// ---------------------------------------------------------- image upload

export type Uploader = (file: File, options?: { maxEdge?: number; quality?: number }) => Promise<{ url: string; bytes: number }>;

/**
 * Picks an image, shrinks it in the browser, uploads it, and hands back the
 * stored URL.
 *
 * Written for someone who is not going to resize a photo first: any JPEG, PNG
 * or WebP off a phone is fine, the control reports what it did ("1.8 MB →
 * 96 KB"), and the preview is the confirmation that the right file landed. The
 * URL field is still there underneath for anyone who would rather paste a link.
 */
export function ImageField({
  label,
  value,
  onChange,
  upload,
  preset = 'cover',
  hint,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  upload: Uploader;
  preset?: 'portrait' | 'cover';
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const options = preset === 'portrait' ? { maxEdge: 960, quality: 0.82 } : { maxEdge: 1600, quality: 0.8 };

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so choosing the same file twice still fires a change.
    event.target.value = '';
    if (!file) return;

    setError('');
    setBusy(true);
    const before = file.size;
    try {
      const result = await upload(file, options);
      onChange(result.url);
      setSaved(`${formatSize(before)} → ${formatSize(result.bytes)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The upload failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>

      <div className="flex items-start gap-3">
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200">
          {value ? (
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-2xl text-slate-300">🖼</div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <label className="inline-flex cursor-pointer items-center rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} disabled={busy} className="sr-only" />
            {busy ? 'Uploading…' : value ? 'Replace photo' : 'Choose a photo'}
          </label>

          {value && (
            <button
              type="button"
              onClick={() => {
                onChange('');
                setSaved('');
              }}
              className="ml-2 text-xs font-semibold text-slate-500 hover:text-red-600"
            >
              Remove
            </button>
          )}

          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="…or paste an image link"
            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs focus:border-accent focus:outline-none"
          />

          {saved && <p className="mt-1 text-xs text-accent">Resized automatically: {saved}</p>}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          {hint && !saved && !error && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
