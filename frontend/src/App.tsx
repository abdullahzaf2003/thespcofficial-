import { Suspense, lazy, useEffect, useState } from 'react';
import PublicSite from './routes/PublicSite';
import DoctorDetailPage from './routes/public/DoctorDetailPage';
import ReviewPage from './routes/public/ReviewPage';
import { BlogListPage, BlogPostPage } from './routes/public/BlogPages';

/**
 * Routing.
 *
 * The clinic runs on one registrable domain with the two staff panels on
 * subdomains of it, which is what lets a single sign-in cover all three (see
 * the refresh cookie in backend/routes/auth.js):
 *
 *   thespcofficial.com               public website
 *   03084213201.thespcofficial.com   admin + reception dashboard
 *   03224894179.thespcofficial.com   doctor panel
 *
 * The hostname decides which app renders. Locally there are no subdomains, so
 * `/admin` and `/doctor` keep working as paths — one build serves every host.
 *
 * Public routes:
 *   /                public website
 *   /doctors/:id     doctor profile
 *   /blog, /blog/:s  blog
 *   /j/:token        patient video join (no login)
 *   /review/:token   post-consultation review form (invite link only)
 */

// Lazily loaded so the console and the doctor panel are separate chunks: a
// patient opening the website never downloads the staff code.
const AdminApp = lazy(() => import('./routes/AdminApp'));
const DoctorApp = lazy(() => import('./routes/DoctorApp'));

const ADMIN_HOST = (import.meta.env.VITE_ADMIN_HOST || '03084213201.thespcofficial.com').toLowerCase();
const DOCTOR_HOST = (import.meta.env.VITE_DOCTOR_HOST || '03224894179.thespcofficial.com').toLowerCase();

type Route =
  | { name: 'public' }
  | { name: 'admin' }
  | { name: 'doctorPortal' }
  | { name: 'join'; token: string }
  | { name: 'review'; token: string }
  | { name: 'doctorDetail'; id: string }
  | { name: 'blogList' }
  | { name: 'blogPost'; slug: string };

/**
 * Which property this hostname is. Returns null for the public site and for
 * local development, where the path decides instead.
 */
function resolveHost(hostname: string): Route | null {
  const host = hostname.toLowerCase().replace(/:\d+$/, '');
  if (host === ADMIN_HOST) return { name: 'admin' };
  if (host === DOCTOR_HOST) return { name: 'doctorPortal' };
  return null;
}

function resolveRoute(pathname: string, hostname: string): Route {
  // Strip the Vite base path so this works when hosted under a subdirectory.
  const base = import.meta.env.BASE_URL || '/';
  const path = (pathname.startsWith(base) ? pathname.slice(base.length - 1) : pathname).replace(/\/+$/, '') || '/';

  // The patient join and review links must resolve on any host, because a
  // patient may open one from a link that was built before DNS was split.
  const join = path.match(/^\/j\/(.+)$/);
  if (join) return { name: 'join', token: decodeURIComponent(join[1]) };

  const review = path.match(/^\/review\/(.+)$/);
  if (review) return { name: 'review', token: decodeURIComponent(review[1]) };

  // On a staff subdomain every other path is that panel — a bookmark to
  // `.../appointments` should not fall through to the public site.
  const byHost = resolveHost(hostname);
  if (byHost) return byHost;

  // `/doctor` is the portal; `/doctors/:id` is the public profile.
  if (path === '/doctor' || path.startsWith('/doctor/')) return { name: 'doctorPortal' };
  if (path.startsWith('/admin')) return { name: 'admin' };

  const doctorDetail = path.match(/^\/doctors\/([^/]+)$/);
  if (doctorDetail) return { name: 'doctorDetail', id: decodeURIComponent(doctorDetail[1]) };

  if (path === '/blog') return { name: 'blogList' };
  const blogPost = path.match(/^\/blog\/([^/]+)$/);
  if (blogPost) return { name: 'blogPost', slug: decodeURIComponent(blogPost[1]) };

  return { name: 'public' };
}

function PanelLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-soft-200 border-t-accent" />
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      </div>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined'
      ? { name: 'public' }
      : resolveRoute(window.location.pathname, window.location.hostname),
  );

  useEffect(() => {
    const onNavigate = () => {
      setRoute(resolveRoute(window.location.pathname, window.location.hostname));
      // Client-side navigation does not reset scroll on its own, except when
      // the target is an in-page anchor.
      if (!window.location.hash) window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', onNavigate);
    return () => window.removeEventListener('popstate', onNavigate);
  }, []);

  switch (route.name) {
    case 'admin':
      return (
        <Suspense fallback={<PanelLoading />}>
          <AdminApp />
        </Suspense>
      );
    case 'doctorPortal':
      return (
        <Suspense fallback={<PanelLoading />}>
          <DoctorApp />
        </Suspense>
      );
    case 'join':
      return <PatientJoinRoute token={route.token} />;
    case 'review':
      return <ReviewPage token={route.token} />;
    case 'doctorDetail':
      return <DoctorDetailPage doctorId={route.id} />;
    case 'blogList':
      return <BlogListPage />;
    case 'blogPost':
      return <BlogPostPage slug={route.slug} />;
    default:
      return <PublicSite />;
  }
}

// The join page pulls in the WebRTC stack, which nothing else on the public
// site needs, so it is split out too.
const PatientJoin = lazy(() => import('./routes/PatientJoin'));

function PatientJoinRoute({ token }: { token: string }) {
  return (
    <Suspense fallback={<PanelLoading />}>
      <PatientJoin token={token} />
    </Suspense>
  );
}
