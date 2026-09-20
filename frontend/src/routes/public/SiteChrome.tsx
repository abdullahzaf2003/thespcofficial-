import type { ReactNode } from 'react';

/**
 * Shared header and footer for the public pages.
 *
 * The markup matches the original single-page site so the home page is
 * visually unchanged; the blog and doctor pages reuse it for consistency.
 */

export type SiteGeneral = {
  site_name: string;
  site_subtitle: string;
  address: string;
  status: string;
  call_phone: string;
  alternate_phone?: string;
  whatsapp_number: string;
  consultation_fee?: string;
};

export function telHref(phone: string) {
  return `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;
}

export function whatsappHref(number: string, message = 'Hello, I would like to book an appointment.') {
  return `https://wa.me/${String(number || '').replace(/[^\d]/g, '')}?text=${encodeURIComponent(message)}`;
}

/** Same-origin navigation without a full page reload. */
export function navigate(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function SiteLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        // Let modified clicks (new tab, download) behave normally.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}


/**
 * The clinic logo.
 *
 * The artwork is a wordmark — it already contains "Surgeons Poly Clinic" — so
 * wherever the full logo is shown the site name is not repeated beside it as
 * text. `mark` is the cross on its own, for the square places a 3:1 wordmark
 * would be illegible.
 *
 * WebP with a PNG fallback via <picture>, because the source artwork is 2169px
 * wide and 384 KB; the served wordmark is 28 KB.
 */
export function Logo({
  variant = 'full',
  className = '',
  onDark = false,
}: {
  variant?: 'full' | 'mark';
  className?: string;
  onDark?: boolean;
}) {
  const base = variant === 'full' ? '/brand/logo' : '/brand/mark';

  return (
    <picture>
      <source srcSet={`${base}.webp`} type="image/webp" />
      <img
        src={`${base}.png`}
        alt="Surgeons Poly Clinic"
        // The logo is dark blue artwork; on a dark background it needs the
        // white plate behind it rather than disappearing into the green.
        className={`${className} ${onDark ? 'rounded-lg bg-white p-1.5' : ''}`}
        loading={variant === 'full' ? 'eager' : 'lazy'}
        decoding="async"
      />
    </picture>
  );
}

export function SiteHeader({ general, onHome }: { general: SiteGeneral; onHome?: boolean }) {
  const anchor = (hash: string) => (onHome ? hash : `/${hash}`);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
        <SiteLink to="/" className="flex items-center gap-3" aria-label={general.site_name}>
          <Logo className="h-9 w-auto sm:h-10" />
          {/* The wordmark carries the name, so only the strapline is added. */}
          <span className="hidden border-l border-slate-200 pl-3 text-[10px] leading-tight text-slate-500 lg:block">
            {general.site_subtitle}
          </span>
        </SiteLink>
        <nav className="hidden gap-6 text-sm text-slate-600 md:flex">
          <SiteLink to={anchor('#doctors')}>Doctors</SiteLink>
          <SiteLink to={anchor('#services')}>Services</SiteLink>
          <SiteLink to={anchor('#booking')}>Booking</SiteLink>
          <SiteLink to={anchor('#faq')}>FAQ</SiteLink>
          <SiteLink to="/blog">Blog</SiteLink>
          <SiteLink to={anchor('#contact')}>Contact</SiteLink>
        </nav>
        <a href={telHref(general.call_phone)} className="rounded-full border border-brand px-4 py-2 text-sm font-semibold text-brand">
          Call Now
        </a>
      </div>
    </header>
  );
}

export function SiteFooter({ general }: { general: SiteGeneral }) {
  return (
    <footer className="border-t border-slate-200 bg-brand text-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 md:grid-cols-3">
        <div>
          <Logo className="h-10 w-auto" onDark />
          <p className="mt-3 text-sm text-sky-100">{general.address}</p>
          <p className="mt-1 text-sm text-sky-200">{general.status}</p>
        </div>

        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-sky-300">Contact</div>
          <a href={telHref(general.call_phone)} className="mt-3 block text-sm text-white">{general.call_phone}</a>
          {general.alternate_phone && (
            <a href={telHref(general.alternate_phone)} className="mt-1 block text-sm text-white">{general.alternate_phone}</a>
          )}
          <a href={whatsappHref(general.whatsapp_number)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-semibold text-sky-200">
            WhatsApp us
          </a>
        </div>

        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-sky-300">Pages</div>
          <ul className="mt-3 space-y-1 text-sm text-sky-100">
            <li><SiteLink to="/">Home</SiteLink></li>
            <li><SiteLink to="/blog">Blog</SiteLink></li>
            <li><SiteLink to="/#booking">Book an appointment</SiteLink></li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10 py-4 text-center text-xs text-sky-200">
        © {new Date().getFullYear()} {general.site_name}. All rights reserved.
      </div>
    </footer>
  );
}
