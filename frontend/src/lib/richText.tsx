import type { ReactNode } from 'react';

/**
 * Renders blog bodies written by the admin.
 *
 * The previous version passed stored content to `dangerouslySetInnerHTML`,
 * which made every admin account a stored-XSS vector against every visitor.
 * This renderer builds React elements instead, so author text is only ever a
 * text node — React escapes it, and there is no code path that turns a string
 * into markup. The XSS class is closed structurally rather than by filtering.
 *
 * The supported syntax is deliberately small and familiar, because the people
 * writing posts are clinic staff, not developers:
 *
 *   ## Heading            a section heading
 *   - item                a bullet list
 *   1. item               a numbered list
 *   > quote               a pulled-out quote
 *   **bold**  *italic*    emphasis
 *   [text](https://…)     a link
 *
 * Anything else is a paragraph.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

/** Only http(s) links are rendered as links — `javascript:` stays plain text. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }

    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeHref(link[2]);
      if (!href) return <span key={key}>{link[1]}</span>;
      return (
        <a
          key={key}
          href={href}
          className="text-accent underline underline-offset-2 hover:text-brand"
          rel="noopener noreferrer nofollow"
          target={href.startsWith('http') ? '_blank' : undefined}
        >
          {link[1]}
        </a>
      );
    }

    return <span key={key}>{part}</span>;
  });
}

type Block =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; text: string };

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];

  for (const chunk of content.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const raw = chunk.trim();
    if (!raw) continue;

    const lines = raw.split('\n').map((line) => line.trim());

    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      blocks.push({ kind: 'list', ordered: false, items: lines.map((line) => line.replace(/^[-*]\s+/, '')) });
      continue;
    }
    if (lines.every((line) => /^\d+[.)]\s+/.test(line))) {
      blocks.push({ kind: 'list', ordered: true, items: lines.map((line) => line.replace(/^\d+[.)]\s+/, '')) });
      continue;
    }

    const heading = raw.match(/^(#{2,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length === 2 ? 2 : 3, text: heading[2] });
      continue;
    }

    if (raw.startsWith('> ')) {
      blocks.push({ kind: 'quote', text: lines.map((line) => line.replace(/^>\s?/, '')).join(' ') });
      continue;
    }

    // A single newline inside a paragraph is a soft wrap, not a break.
    blocks.push({ kind: 'paragraph', text: lines.join(' ') });
  }

  return blocks;
}

export function RichText({ content, className = '' }: { content: string; className?: string }) {
  const blocks = parseBlocks(content || '');

  return (
    <div className={`space-y-4 text-base leading-7 text-slate-700 ${className}`}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;

        switch (block.kind) {
          case 'heading':
            return block.level === 2 ? (
              <h2 key={key} className="pt-2 text-2xl font-bold text-brand">{renderInline(block.text, key)}</h2>
            ) : (
              <h3 key={key} className="pt-1 text-xl font-bold text-brand">{renderInline(block.text, key)}</h3>
            );

          case 'quote':
            return (
              <blockquote key={key} className="border-l-4 border-accent bg-soft/60 py-3 pl-4 pr-3 italic text-brand">
                {renderInline(block.text, key)}
              </blockquote>
            );

          case 'list':
            return block.ordered ? (
              <ol key={key} className="list-decimal space-y-2 pl-6 marker:text-accent">
                {block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)}
              </ol>
            ) : (
              <ul key={key} className="list-disc space-y-2 pl-6 marker:text-accent">
                {block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)}
              </ul>
            );

          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}

/** Plain-text preview for cards and search results. */
export function excerptFrom(content: string, length = 180): string {
  const text = (content || '')
    .replace(/^#{2,3}\s+/gm, '')
    .replace(/[*_>`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length).trimEnd()}…` : text;
}
