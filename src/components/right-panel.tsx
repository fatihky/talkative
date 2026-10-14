/*
 * RightPanel — the docked chat-context / artifact / preview panel.
 *
 * Business logic:
 * - Three tabs (context, artifact, preview) over two panel modes; a
 *   closed panel renders nothing at all.
 * - Inline from 1440px up, a scrim overlay below it that closes on an
 *   outside click; Esc inside the panel closes it either way.
 * - The width drags between 280 and 720px, snaps to the nearest of six
 *   stops on release, resets to 420 on double-click, and is persisted —
 *   but the drag handle only exists inline.
 * - Preview is a tab, not a mode: it stays disabled until a scoped
 *   snippet exists, and a snippet that scopes out falls back to showing
 *   the artifact body while the stored tab stays 'preview'.
 * - Artifact mode routes between the artifact browser and the raw snippet
 *   preview; context mode shows the notes/grants panel.
 * - The context tab is a read-only summary: the account-wide default
 *   grants, the notes list (each attachable to the next message) and the
 *   selected model — per-message grants still override chat defaults.
 * - Its chat-scope system prompt box is an unwired stub; real prompts are
 *   edited through the system-prompt dialog.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from 'waku/router/client';
import { timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import {
  actions,
  useChatsStore,
  useDraftStore,
  useLayoutStore,
  useMemoriesStore,
  useNotesStore,
  useSelectedModel,
} from '../stores';
import { ArtifactPanel } from './artifact-panel';
import { PreviewPanel, useScopedPreview } from './preview-panel';

/* Right panel: closed by default on Home; inline at ≥1440, Sheet overlay below. */
export function RightPanel() {
  const mode = useLayoutStore((s) => s.rightPanel);
  const vw = useLayoutStore((s) => s.vw);
  const width = useLayoutStore((s) => s.rightPanelWidth);
  const setWidth = actions.setRightPanelWidth;
  const escRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => setWidth(e.clientX);
    const onUp = (e: PointerEvent) => {
      setDragging(false);
      const snaps = [280, 360, 420, 500, 560, 720];
      const best = snaps.reduce((a, b) =>
        Math.abs(b - e.clientX) < Math.abs(a - e.clientX) ? b : a,
      );
      setWidth(best);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging]);

  if (mode === 'closed') return null;
  const inline = vw >= 1440;

  const panel = (
    <aside
      ref={escRef}
      aria-label={mode === 'artifact' ? 'Artifact panel' : 'Chat context panel'}
      tabIndex={-1}
      className="flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-sidebar"
      style={inline ? { width } : { width: `min(${width}px, 100vw)` }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') actions.closePanel();
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <PanelTabs />
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => actions.closePanel()}
          className="ctl-icon ml-auto border-transparent bg-transparent text-muted-foreground hover:bg-muted"
        >
          <I n="x" s={13} />
        </button>
      </div>
      {mode === 'artifact' ? (
        <PanelArtifact />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <ContextPanel />
        </div>
      )}

      {/* resize handle — only in inline mode */}
      {inline && (
        // biome-ignore lint/a11y/useSemanticElements: draggable splitter, not a thematic break
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onPointerDown={() => setDragging(true)}
          onDoubleClick={() => setWidth(420)}
          className="absolute -left-0.5 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-(--accent-weak)"
          style={{ background: dragging ? 'var(--accent)' : undefined }}
        />
      )}
    </aside>
  );

  if (inline) return panel;
  return (
    <div
      className="fixed inset-0 z-50"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) actions.closePanel();
      }}
    >
      <div
        className="absolute right-0 top-0 h-full"
        onKeyDownCapture={() => undefined}
      >
        {panel}
      </div>
      <button
        type="button"
        aria-label="Close panel overlay"
        className="sr-only"
        onClick={() => actions.closePanel()}
      />
    </div>
  );
}

const TABS = [
  { value: 'context', label: 'Chat context' },
  { value: 'artifact', label: 'Artifact' },
  { value: 'preview', label: 'Preview' },
] as const;

/* tab row shared by the panel header; preview stays selectable once a snippet exists */
function PanelTabs() {
  const tab = useLayoutStore((s) => s.rightPanelTab);
  const preview = useScopedPreview();
  return (
    <div
      role="tablist"
      aria-label="Panel view"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
    >
      {TABS.map((t) => {
        const disabled = t.value === 'preview' && !preview;
        /* a scoped-out preview falls back to the artifact tab */
        const shown = tab === 'preview' && !preview ? 'artifact' : tab;
        const active = t.value === shown && !disabled;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => actions.setRightPanelTab(t.value)}
            className={`h-6 shrink-0 rounded-[5px] px-2 text-[11px] leading-none transition-colors ${
              active
                ? 'bg-[var(--raised)] font-medium text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border-strong)]'
                : disabled
                  ? 'cursor-not-allowed text-[var(--text-3)] opacity-50'
                  : 'text-[var(--text-3)] hover:text-[var(--text-2)]'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* routes the artifact tab between the artifact browser and the raw snippet preview */
function PanelArtifact() {
  const tab = useLayoutStore((s) => s.rightPanelTab);
  const preview = useScopedPreview();
  if (tab === 'preview' && preview) return <PreviewPanel />;
  return <ArtifactPanel />;
}

function ContextPanel() {
  const notes = useNotesStore((s) => s.notes);
  const memories = useMemoriesStore((s) => s.items);
  const chats = useChatsStore((s) => s.items);
  const model = useSelectedModel();
  const grants = useDraftStore((s) => s.defaultTools.grants);
  return (
    <div className="flex flex-col gap-4 p-3">
      <section>
        <div className="sec-label mb-1.5">System prompt (chat scope)</div>
        <textarea
          rows={3}
          placeholder="Optional instructions for this chat…"
          aria-label="System prompt"
          className="w-full rounded-md border border-border bg-background p-2 text-[12px] outline-none placeholder:text-muted-foreground"
        />
      </section>

      <section>
        <div className="sec-label mb-1.5">Default grants — all chats</div>
        <div className="text-[12px] leading-relaxed text-(--text-2)">
          {Object.entries(grants)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(' · ') || 'none'}
        </div>
      </section>

      <section>
        <div className="sec-label mb-1 flex items-center justify-between">
          Notes
          <button
            type="button"
            className="ctl h-6 px-2 text-[11px]"
            onClick={() => actions.createNote()}
          >
            New note
          </button>
        </div>
        <div className="flex flex-col">
          {notes.map((n) => (
            <div
              key={n.id}
              className="group flex items-center gap-1 rounded-md hover:bg-muted"
            >
              <Link
                to={`/notes/${n.id}`}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {n.title || 'Untitled note'}
                </span>
                <span className="num shrink-0 text-[10px] muted">
                  {timeAgo(n.createdAt)}
                </span>
              </Link>
              <button
                type="button"
                className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Attach ${n.title} to next message`}
                onClick={() => actions.attachNote(n.id)}
              >
                <I n="paperclip" s={12} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="sec-label mb-1">Memories</div>
        {memories.length === 0 ? (
          <div className="text-[12px] muted">No memories yet.</div>
        ) : (
          <div className="flex flex-col">
            {memories.map((m) => (
              <div
                key={m.id}
                className="group flex items-center gap-1 rounded-md hover:bg-muted"
              >
                <span
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5"
                  title={m.value}
                >
                  <span className="num min-w-0 flex-1 truncate text-[12px]">
                    {m.key}
                  </span>
                </span>
                <button
                  type="button"
                  className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`Attach memory ${m.key} to next message`}
                  onClick={() => actions.attachMemory(m.id)}
                >
                  <I n="paperclip" s={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="sec-label mb-1">Chats</div>
        {chats.length === 0 ? (
          <div className="text-[12px] muted">No chats yet.</div>
        ) : (
          <div className="flex flex-col">
            {chats.map((c) => (
              <div
                key={c.id}
                className="group flex items-center gap-1 rounded-md hover:bg-muted"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {c.title}
                  </span>
                </span>
                <button
                  type="button"
                  className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`Attach chat ${c.title} to next message`}
                  onClick={() => actions.attachChat(c.id)}
                >
                  <I n="paperclip" s={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="text-[11px] muted">
        Context model: <span className="num">{model?.shortName ?? '—'}</span> ·
        per-message grants override chat defaults.
      </section>
    </div>
  );
}
