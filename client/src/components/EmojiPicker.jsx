import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { isSingleEmoji } from '@/lib/emoji';
import { cn } from '@/lib/utils';

/**
 * Phase 10 (A3) — pick any emoji, not just the fixed 20 we used to offer.
 *
 * No npm dependency: emoji-mart and friends weigh 150-300KB and arrive with
 * their own look to override. The catalogue lives in lib/emojiData.js and is
 * pulled in with a dynamic import() so it never touches the main bundle.
 *
 * The grid is the desktop convenience. The "paste any emoji" field is the real
 * escape hatch — on a phone that's the emoji keyboard, which covers skin
 * tones, family permutations and every flag without us shipping the data.
 */
export function EmojiPicker({ value, onChange, className }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState('smileys');
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState(null);
  const gridRef = useRef(null);

  // Only fetch the catalogue once the browser is actually opened — this keeps
  // the 26KB chunk off the critical path for anyone using the quick row.
  useEffect(() => {
    if (!open || data) return;
    let alive = true;
    import('@/lib/emojiData')
      .then((m) => {
        if (alive) setData(m);
      })
      .catch(() => {
        if (alive) setData({ EMOJI_GROUPS: [], ALL_EMOJI: [] });
      });
    return () => {
      alive = false;
    };
  }, [open, data]);

  const results = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.EMOJI_GROUPS.find((g) => g.key === group)?.items ?? [];
    // A handful of glyphs legitimately appear in two groups (❤️ is in both
    // Smileys and Symbols), so the flat search list has to be de-duped or
    // React sees repeated keys.
    const seen = new Set();
    const out = [];
    for (const item of data.ALL_EMOJI) {
      const [glyph, keywords] = item;
      if (seen.has(glyph)) continue;
      if (!keywords.includes(q) && glyph !== q) continue;
      seen.add(glyph);
      out.push(item);
      if (out.length >= 150) break;
    }
    return out;
  }, [data, group, query]);

  // Reset the scroll position when the visible set changes, otherwise you land
  // halfway down a fresh list.
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [group, query]);

  function commitCustom(raw) {
    setCustom(raw);
    if (!raw.trim()) {
      setCustomError(null);
      return;
    }
    if (isSingleEmoji(raw)) {
      setCustomError(null);
      onChange(raw.trim());
    } else {
      setCustomError('One emoji, nothing else.');
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      {/* Current pick + the paste-anything escape hatch */}
      <div className="flex items-center gap-2">
        <span
          aria-label="Selected icon"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary bg-primary/10 text-xl"
        >
          {value}
        </span>
        <div className="min-w-0 flex-1">
          <Input
            value={custom}
            onChange={(e) => commitCustom(e.target.value)}
            placeholder="…or paste any emoji"
            aria-label="Paste any emoji"
            maxLength={24}
            className="h-9 text-sm"
          />
        </div>
      </div>
      {customError ? <p className="text-xs text-amber-400">{customError}</p> : null}

      {/* The grid is a tall thing to have permanently open inside a dialog that
          also has to fit a Save button on a phone — so it's collapsed by
          default and the quick row above covers the common picks. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        {open ? 'Hide emoji browser' : 'Browse all emoji'}
      </button>

      {!open ? null : (
      <>
      {/* Search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          aria-label="Search emoji"
          className="h-9 pl-8 text-sm"
        />
      </div>

      {/* Group tabs — hidden while searching, since results span every group */}
      {query.trim() ? null : (
        <div className="flex gap-1 overflow-x-auto pb-1">
          {(data?.EMOJI_GROUPS ?? []).map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setGroup(g.key)}
              title={g.label}
              aria-label={g.label}
              aria-pressed={group === g.key}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-base transition',
                group === g.key
                  ? 'border-primary bg-primary/10'
                  : 'border-border/60 bg-secondary/40 hover:bg-accent',
              )}
            >
              <span aria-hidden>{g.tabIcon}</span>
            </button>
          ))}
        </div>
      )}

      {/* Grid */}
      <div
        ref={gridRef}
        className="h-40 overflow-y-auto rounded-lg border border-border/60 bg-secondary/20 p-1.5"
      >
        {!data ? (
          <p className="p-2 text-xs text-muted-foreground">Loading emoji…</p>
        ) : results.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            Nothing matches “{query.trim()}”. You can still paste the emoji above.
          </p>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {results.map(([glyph, keywords]) => (
              <button
                key={glyph}
                type="button"
                onClick={() => onChange(glyph)}
                title={keywords}
                aria-label={keywords}
                aria-pressed={value === glyph}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md text-lg transition',
                  value === glyph ? 'bg-primary/20 ring-1 ring-primary' : 'hover:bg-accent',
                )}
              >
                <span aria-hidden>{glyph}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
