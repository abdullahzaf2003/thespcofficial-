import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, type Authed, type BlogPost } from '../../lib/api';
import { Field, inputClass, Button, Modal, Card, EmptyState, Badge, ImageField, type Uploader } from '../../components/ui';

/** Blog authoring with a draft/publish workflow and SEO fields. */

type Props = { authed: Authed; notify: (message: string) => void; upload: Uploader };

const BLANK = {
  title: '',
  slug: '',
  excerpt: '',
  content: '',
  image: '',
  author: '',
  tags: '',
  seo_title: '',
  seo_description: '',
  status: 'draft',
};

export default function BlogPanel({ authed, notify, upload }: Props) {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...BLANK });
  const [editing, setEditing] = useState<BlogPost | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<BlogPost | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPosts(await authed<BlogPost[]>('/api/admin/blog'));
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not load posts.');
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

  const openEdit = (post: BlogPost) => {
    setForm({
      title: post.title || '',
      slug: post.slug || '',
      excerpt: post.excerpt || '',
      content: post.content || '',
      image: post.image || '',
      author: post.author || '',
      tags: post.tags || '',
      seo_title: post.seo_title || '',
      seo_description: post.seo_description || '',
      status: post.status || 'draft',
    });
    setEditing(post);
  };

  const submit = async (event: FormEvent, status?: string) => {
    event.preventDefault();
    const body = { ...form, ...(status ? { status } : {}) };

    if (!body.title.trim() || !body.content.trim()) {
      return notify('A title and some content are required.');
    }

    try {
      if (editing) {
        await authed(`/api/admin/blog/${editing.id}`, { method: 'PATCH', body });
        notify(body.status === 'published' ? 'Post published.' : 'Post saved.');
      } else {
        await authed('/api/admin/blog', { method: 'POST', body });
        notify(body.status === 'published' ? 'Post published.' : 'Draft saved.');
      }
      setEditing(null);
      setCreating(false);
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not save the post.');
    }
  };

  const togglePublish = async (post: BlogPost) => {
    const next = post.status === 'published' ? 'draft' : 'published';
    try {
      await authed(`/api/admin/blog/${post.id}`, { method: 'PATCH', body: { status: next } });
      notify(next === 'published' ? 'Post is now live.' : 'Post moved back to draft.');
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not change status.');
    }
  };

  const remove = async (post: BlogPost) => {
    try {
      await authed(`/api/admin/blog/${post.id}`, { method: 'DELETE' });
      notify('Post deleted.');
      void load();
    } catch (caught) {
      notify(caught instanceof ApiError ? caught.message : 'Could not delete the post.');
    }
  };

  const editor = (creating || editing) && (
    <Modal title={editing ? 'Edit post' : 'New post'} onClose={() => { setCreating(false); setEditing(null); }} wide>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Field label="Title" required>
          <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputClass} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Slug" hint="Left blank, one is generated from the title.">
            <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className={inputClass} placeholder="understanding-surgical-recovery" />
          </Field>
          <Field label="Author">
            <input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} className={inputClass} />
          </Field>
        </div>

        <Field label="Excerpt" hint="Shown on the blog listing.">
          <textarea rows={2} value={form.excerpt} onChange={(e) => setForm({ ...form, excerpt: e.target.value })} className={inputClass} />
        </Field>

        <Field
          label="Content"
          required
          hint="Blank lines start a new paragraph. For a heading type ## Heading, for a bullet start the line with -, use **bold**, and write links as [text](https://example.com)."
        >
          <textarea required rows={12} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} className={`${inputClass} font-mono`} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <ImageField
            label="Cover image"
            value={form.image}
            onChange={(url) => setForm({ ...form, image: url })}
            upload={upload}
            preset="cover"
          />
          <Field label="Tags" hint="Comma separated.">
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} className={inputClass} placeholder="surgery, recovery" />
          </Field>
        </div>

        <details className="rounded-xl border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">SEO</summary>
          <div className="mt-3 space-y-3">
            <Field label="SEO title">
              <input value={form.seo_title} onChange={(e) => setForm({ ...form, seo_title: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Meta description">
              <textarea rows={2} value={form.seo_description} onChange={(e) => setForm({ ...form, seo_description: e.target.value })} className={inputClass} />
            </Field>
          </div>
        </details>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variant="ghost" type="button" onClick={() => { setCreating(false); setEditing(null); }}>Cancel</Button>
          <Button variant="ghost" type="button" onClick={(event) => void submit(event as unknown as FormEvent, 'draft')}>
            Save as draft
          </Button>
          <Button type="button" onClick={(event) => void submit(event as unknown as FormEvent, 'published')}>
            Publish
          </Button>
        </div>
      </form>
    </Modal>
  );

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">Blog</h2>
          <p className="text-sm text-slate-500">Drafts stay private; published posts appear on the website immediately.</p>
        </div>
        <Button onClick={openCreate}>New post</Button>
      </div>

      {loading ? (
        <EmptyState>Loading posts…</EmptyState>
      ) : posts.length === 0 ? (
        <EmptyState>No posts yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => (
            <Card key={post.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 gap-4">
                  {post.image && <img src={post.image} alt="" className="h-16 w-24 shrink-0 rounded-xl object-cover" />}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold text-slate-900">{post.title}</h3>
                      {post.status === 'published' ? <Badge tone="green">Published</Badge> : <Badge tone="amber">Draft</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">
                      {post.author || 'Clinic Team'}
                      {post.slug ? ` • /blog/${post.slug}` : ''}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-600">{post.excerpt || post.content?.slice(0, 160)}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={() => setPreview(post)}>Preview</Button>
                  <Button variant="ghost" onClick={() => openEdit(post)}>Edit</Button>
                  <Button variant="ghost" onClick={() => void togglePublish(post)}>
                    {post.status === 'published' ? 'Unpublish' : 'Publish'}
                  </Button>
                  <Button variant="danger" onClick={() => void remove(post)}>Delete</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editor}

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} wide>
          {preview.image && <img src={preview.image} alt="" className="mb-4 max-h-64 w-full rounded-2xl object-cover" />}
          <div className="prose-sm space-y-3 text-sm leading-6 text-slate-700">
            {(preview.content || '').split(/\n{2,}/).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
