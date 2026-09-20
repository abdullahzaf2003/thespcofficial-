import { useEffect, useState } from 'react';
import { request, type BlogPost } from '../../lib/api';
import { SiteHeader, SiteFooter, SiteLink, type SiteGeneral } from './SiteChrome';
import { RichText } from '../../lib/richText';

/** Blog listing and individual post pages (Section 4.2.4). */

const DEFAULT_GENERAL: SiteGeneral = {
  site_name: 'Surgeons Poly Clinic',
  site_subtitle: 'Model Town, Lahore • Open 24/7',
  address: '422, Block Q, Model Town, Lahore',
  status: 'Open 24/7',
  call_phone: '042-34500888',
  alternate_phone: '042-38900939',
  whatsapp_number: '923084213201',
};

const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' });

function useGeneral() {
  const [general, setGeneral] = useState<SiteGeneral>(DEFAULT_GENERAL);

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

  return general;
}

// ------------------------------------------------------------------ list

export function BlogListPage() {
  const general = useGeneral();
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        setPosts(await request<BlogPost[]>('/api/blog'));
      } catch {
        setPosts([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-white text-slate-800">
      <SiteHeader general={general} />

      <main className="mx-auto max-w-5xl px-4 py-16">
        <div className="mb-12 text-center">
          <div className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-accent">Health Library</div>
          <h1 className="text-4xl font-black text-slate-900 md:text-5xl">Guidance from our specialists</h1>
          <p className="mx-auto mt-4 max-w-2xl text-slate-600">
            Practical articles on surgery, ENT care and recovery, written by the clinic team.
          </p>
        </div>

        {loading ? (
          <p className="text-center text-sm text-slate-500">Loading articles…</p>
        ) : posts.length === 0 ? (
          <p className="rounded-3xl bg-slate-50 p-10 text-center text-slate-500">
            No articles published yet. Please check back soon.
          </p>
        ) : (
          <div className="grid gap-8 md:grid-cols-2">
            {posts.map((post) => (
              <SiteLink
                key={post.id}
                to={`/blog/${post.slug || post.id}`}
                className="group overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 transition hover:shadow-lg"
              >
                <article>
                  {post.image && <img src={post.image} alt="" className="h-56 w-full object-cover" />}
                  <div className="p-6">
                    <div className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-accent">
                      {post.author || 'Clinic Team'}
                      {post.published_at ? ` • ${dateFmt.format(new Date(post.published_at))}` : ''}
                    </div>
                    <h2 className="text-2xl font-black text-slate-900 group-hover:text-brand">{post.title}</h2>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      {post.excerpt || `${post.content?.slice(0, 160)}…`}
                    </p>
                    <span className="mt-4 inline-block text-sm font-semibold text-accent">Read article →</span>
                  </div>
                </article>
              </SiteLink>
            ))}
          </div>
        )}
      </main>

      <SiteFooter general={general} />
    </div>
  );
}

// ------------------------------------------------------------------ post

export function BlogPostPage({ slug }: { slug: string }) {
  const general = useGeneral();
  const [post, setPost] = useState<BlogPost | null>(null);
  const [related, setRelated] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    void (async () => {
      try {
        const payload = await request<BlogPost>(`/api/blog/${encodeURIComponent(slug)}`);
        setPost(payload);
        document.title = payload.seo_title || payload.title;

        const all = await request<BlogPost[]>('/api/blog');
        setRelated(all.filter((row) => row.id !== payload.id).slice(0, 2));
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  return (
    <div className="min-h-screen bg-white text-slate-800">
      <SiteHeader general={general} />

      <main className="mx-auto max-w-3xl px-4 py-16">
        {loading ? (
          <p className="text-center text-sm text-slate-500">Loading…</p>
        ) : notFound || !post ? (
          <div className="rounded-3xl bg-slate-50 p-10 text-center">
            <h1 className="text-2xl font-black text-slate-900">Article not found</h1>
            <p className="mt-2 text-slate-600">This article may have been unpublished.</p>
            <SiteLink to="/blog" className="mt-6 inline-block rounded-full bg-brand px-6 py-3 font-semibold text-white">
              Back to the blog
            </SiteLink>
          </div>
        ) : (
          <article>
            <SiteLink to="/blog" className="text-sm font-semibold text-accent">← All articles</SiteLink>

            <h1 className="mt-4 text-4xl font-black leading-tight text-slate-900">{post.title}</h1>
            <div className="mt-3 text-sm text-slate-500">
              {post.author || 'Clinic Team'}
              {post.published_at ? ` • ${dateFmt.format(new Date(post.published_at))}` : ''}
            </div>

            {post.image && <img src={post.image} alt="" className="mt-8 w-full rounded-3xl object-cover" />}

            <div className="mt-8">
              <RichText content={post.content || ''} />
            </div>

            {post.tags && (
              <div className="mt-8 flex flex-wrap gap-2">
                {post.tags.split(',').map((tag) => (
                  <span key={tag} className="rounded-full bg-soft px-3 py-1 text-xs font-semibold text-accent">
                    {tag.trim()}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-12 rounded-3xl bg-canvas p-8 text-center">
              <h2 className="text-2xl font-black text-slate-900">Need to speak to a specialist?</h2>
              <p className="mt-2 text-slate-600">Book a consultation and we will send your video link before it starts.</p>
              <SiteLink to="/#booking" className="mt-5 inline-block rounded-full bg-brand px-6 py-3 font-semibold text-white">
                Book an appointment
              </SiteLink>
            </div>

            {related.length > 0 && (
              <div className="mt-12">
                <h2 className="mb-4 text-xl font-black text-slate-900">More articles</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {related.map((item) => (
                    <SiteLink
                      key={item.id}
                      to={`/blog/${item.slug || item.id}`}
                      className="rounded-2xl bg-white p-4 ring-1 ring-slate-200 hover:shadow-md"
                    >
                      <div className="font-bold text-slate-900">{item.title}</div>
                      <p className="mt-1 text-sm text-slate-600">{item.excerpt}</p>
                    </SiteLink>
                  ))}
                </div>
              </div>
            )}
          </article>
        )}
      </main>

      <SiteFooter general={general} />
    </div>
  );
}
