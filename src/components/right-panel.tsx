/*
 * RightPanel — the docked chat-context / artifact / preview panel.
 *
 * Business logic:
 * - Three tabs (context, artifact, preview) over two panel modes; a
 *   closed panel plays a short exit animation before it unmounts
 *   (useExitDelay), re-rendering the last open mode's content while it
 *   goes.
 * - Inline from 1440px up: it reveals by animating its width from 0
 *   (content stays at full width and is clipped, so nothing squishes).
 *   A scrim overlay below that: the sheet slides in from the right
 *   over a fading scrim, and it closes on an outside click; Esc inside
 *   the panel closes it either way.
 * - The width drags between 280 and 720px (measured from the panel's
 *   right edge, since it is docked there), snaps to the nearest of six
 *   stops on release, resets to 440 on double-click, and is persisted.
 *   The drag handle exists in the inline layout and on the overlay sheet
 *   from 768px up; a full-screen phone sheet has none. The pointer is
 *   captured and a transparent overlay covers the page while dragging,
 *   so the drag keeps tracking over an artifact/preview iframe instead
 *   of freezing (iframe documents swallow pointer events).
 * - Preview is a tab, not a mode: it stays disabled until a scoped
 *   snippet exists, and a snippet that scopes out falls back to showing
 *   the artifact body while the stored tab stays 'preview'.
 * - Artifact mode routes between the artifact browser and the raw snippet
 *   preview; context mode shows the notes/grants panel.
 * - The context tab is a read-only summary — the account-wide default
 *   grants, the notes list (each attachable to the next message) and the
 *   selected model (per-message grants still override chat defaults) —
 *   except for its system prompt box, the one editable piece here.
 * - The prompt box edits the active chat's own prompt (on top of what its
 *   folders add). Save is enabled only while the text differs from the
 *   stored prompt, so unsaved edits are always visible, and the status
 *   line says saved / unsaved / no prompt; a failed write keeps the draft
 *   in place and the store raises an error toast.
 * - On home there is no chat to write to yet, so the same box edits the
 *   prompt the next chat starts with: it lives on the composer draft,
 *   rides along with the first send (the server stores it on the row it
 *   creates) and clears with the draft, so Save here just parks it.
 * - The status line also says how many folder prompts apply first, when
 *   the prompt takes effect (from the next reply on — not the one already
 *   generating), and links to the full editor, which lists those folder
 *   prompts in full.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from 'waku/router/client';
import { timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import { useExitDelay } from '../lib/motion';
import {
  actions,
  useChatsStore,
  useDraftStore,
  useFoldersStore,
  useLayoutStore,
  useMemoriesStore,
  useNotesStore,
  useSelectedModel,
  useUIStore,
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
  const { mounted, exiting } = useExitDelay(mode !== 'closed');
  /* the exit animation keeps showing the mode that was open */
  const lastOpen = useRef(mode);
  if (mode !== 'closed') lastOpen.current = mode;

  /* the panel hugs the right edge, so its width is how far the pointer is from that edge,
     not from the left of the viewport (which is what clientX alone reports) */
  const widthAt = (clientX: number) =>
    (escRef.current?.getBoundingClientRect().right ?? window.innerWidth) -
    clientX;

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => setWidth(widthAt(e.clientX));
    const onUp = (e: PointerEvent) => {
      setDragging(false);
      /* a cancelled drag keeps the width it reached instead of snapping */
      if (e.type !== 'pointerup') return;
      const w = widthAt(e.clientX);
      const snaps = [280, 360, 440, 500, 560, 720];
      const best = snaps.reduce((a, b) =>
        Math.abs(b - w) < Math.abs(a - w) ? b : a,
      );
      setWidth(best);
    };
    const blow = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', blow);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', blow);
    };
  }, [dragging]);

  if (!mounted) return null;
  const inline = vw >= 1440;
  /* the overlay sheet is resizable too; only a full-screen phone sheet (below
     768px) has no room to drag a width into */
  const resizable = vw >= 768;
  const shown = mode === 'closed' ? lastOpen.current : mode;
  const panelWidth: number | string = inline ? width : `min(${width}px, 100vw)`;
  const asideAnim = inline
    ? exiting
      ? 'anim-panel-out pointer-events-none'
      : dragging
        ? ''
        : 'anim-panel-in'
    : '';

  const panel = (
    <aside
      ref={escRef}
      aria-label={shown === 'artifact' ? 'Artifact panel' : 'Chat context panel'}
      tabIndex={-1}
      className={`relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar ${asideAnim}`}
      style={{ width: panelWidth }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') actions.closePanel();
      }}
    >
      {/* the inner track stays at the full width even when the aside animates
          in, so no control inside re-wraps while it grows; on the overlay sheet
          it may not outgrow the viewport */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        style={{ width: inline ? panelWidth : '100%', minWidth: 0 }}
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
        {shown === 'artifact' ? (
          <PanelArtifact />
        ) : (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <ContextPanel />
          </div>
        )}
      </div>

      {/* resize handle — inline and on the overlay sheet; the -left-1 half sits
          outside the aside's overflow-hidden clip, leaving a ~8px grab area
          on the inside */}
      {resizable && (
        // biome-ignore lint/a11y/useSemanticElements: draggable splitter, not a thematic break
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          aria-valuenow={Math.round(width)}
          aria-valuemin={280}
          aria-valuemax={720}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            setDragging(true);
          }}
          /* stop the drag from selecting text in the thread behind the panel */
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={() => setWidth(440)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              setWidth(width + 16);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              setWidth(width - 16);
            } else if (e.key === 'Home') {
              e.preventDefault();
              setWidth(720);
            } else if (e.key === 'End') {
              e.preventDefault();
              setWidth(280);
            }
          }}
          className="group absolute -left-1 top-0 z-30 h-full w-3 cursor-col-resize touch-none outline-none"
        >
          <div
            className={`mx-auto h-full w-px transition-colors ${
              dragging
                ? 'bg-(--accent)'
                : 'bg-transparent group-hover:bg-(--accent-weak) group-focus-visible:bg-(--accent)'
            }`}
          />
        </div>
      )}
    </aside>
  );

  if (inline)
    return (
      <>
        {panel}
        {/* keeps pointer events in this document while dragging, so an
            artifact/preview iframe can't swallow the move and leave the
            panel frozen mid-drag; rendered after the panel so it sits above
            it (a z-index alone can't beat the fixed sheet wrapper) */}
        {dragging && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 cursor-col-resize"
          />
        )}
      </>
    );
  return (
    <div
      className={`fixed inset-0 z-50 ${
        exiting ? 'anim-scrim-out pointer-events-none' : 'anim-scrim-in'
      }`}
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) actions.closePanel();
      }}
    >
      <div
        className={`absolute right-0 top-0 h-full ${
          exiting ? 'anim-out-right pointer-events-none' : 'anim-in-right'
        }`}
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
      {/* same drag shield as the inline layout: the sheet's iframe previews
          would otherwise swallow the pointer mid-drag */}
      {dragging && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-[60] cursor-col-resize"
        />
      )}
    </div>
  );
}

const TABS = [
  { value: 'context', label: 'Chat context' },
  { value: 'artifact', label: 'Artifact' },
  { value: 'preview', label: 'Preview' },
] as const;

/* tab row shared by the panel header; preview stays selectable once a snippet exists.
   Styled as the handoff's underline tabs (`.artifact-tabs`). */
function PanelTabs() {
  const tab = useLayoutStore((s) => s.rightPanelTab);
  const preview = useScopedPreview();
  return (
    <div role="tablist" aria-label="Panel view" className="artifact-tabs flex-1">
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
            className={active ? 'on' : disabled ? 'cursor-not-allowed opacity-50' : ''}
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
        <ChatPromptBox />
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

/**
 * the chat-scope system prompt: the active chat's own, or — on home, before a chat exists —
 * the one the next chat starts with. The textarea keeps a local draft, so the button stays
 * disabled — and the status line says "Saved" — until the text differs from what is stored.
 */
function ChatPromptBox() {
  const context = useUIStore((s) => s.context);
  const chat = useChatsStore((s) =>
    context === 'new' ? null : (s.items.find((c) => c.id === context) ?? null),
  );
  const folders = useFoldersStore((s) => s.items);
  const sending = useUIStore((s) => s.sending);
  /* home has no chat row yet, so its prompt lives on the draft until the first send */
  const pendingPrompt = useDraftStore((s) => s.systemPrompt);
  const home = context === 'new' && !chat;
  const saved = home ? pendingPrompt : (chat?.systemPrompt ?? '');
  const chatId = home ? null : (chat?.id ?? null);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  /* follow the stored prompt when another chat comes into scope or it is changed elsewhere */
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed on chat switch, not on every keystroke
  useEffect(() => {
    setDraft(saved);
  }, [chatId, saved]);

  const dirty = draft !== saved;
  /* how many of the chat's folder prompts stack ahead of this one, outermost first */
  const inherited = (() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    let n = 0;
    for (
      let f = chat?.folderId ? byId.get(chat.folderId) : undefined, i = 0;
      f && i <= folders.length;
      f = f.parentId ? byId.get(f.parentId) : undefined, i++
    )
      if (f.systemPrompt?.trim()) n++;
    return n;
  })();

  const save = async () => {
    if (!dirty || saving) return;
    if (home) {
      /* nothing to store yet: the prompt travels with the first send */
      actions.setDraftSystemPrompt(draft);
      return;
    }
    if (!chat) return;
    setSaving(true);
    try {
      /* on success the store's copy becomes `saved`; on failure the draft stays */
      await actions.setChatSystemPrompt(chat.id, draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        placeholder={
          home
            ? 'Optional instructions for the next chat…'
            : 'Optional instructions for this chat…'
        }
        aria-label={
          home
            ? 'System prompt for the next chat'
            : 'System prompt for this chat'
        }
        className={`scroll-thin w-full resize-y rounded-md border bg-background p-2 text-[12px] outline-none placeholder:text-muted-foreground ${
          dirty
            ? 'border-(--accent)'
            : 'border-border focus:border-(--border-strong)'
        }`}
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="ctl-primary h-6 shrink-0 px-2 text-[11px] disabled:opacity-40"
        >
          {saving ? 'Saving…' : saved.trim() ? 'Update' : 'Save'}
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => setDraft(saved)}
          className="ctl h-6 shrink-0 px-2 text-[11px] disabled:opacity-40"
        >
          Discard
        </button>
        <span
          className={`min-w-0 flex-1 truncate text-right text-[10px] ${
            dirty ? 'text-(--accent)' : 'muted'
          }`}
          aria-live="polite"
        >
          {dirty
            ? 'Unsaved changes'
            : saved.trim()
              ? home
                ? 'Applies to the next chat'
                : 'Saved'
              : 'No prompt yet'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-snug muted">
        <span>
          {home
            ? 'The next chat you send starts with it'
            : sending
              ? 'Takes effect on the reply after the one generating'
              : 'Takes effect from the next reply'}
        </span>
        {inherited > 0 && (
          <span>
            · after {inherited} folder prompt{inherited === 1 ? '' : 's'}
          </span>
        )}
        {chat && (
          <>
            <span>·</span>
            <button
              type="button"
              onClick={() =>
                actions.editSystemPrompt({ kind: 'chat', id: chat.id })
              }
              className="underline underline-offset-2 hover:text-foreground"
            >
              Full editor
            </button>
          </>
        )}
      </div>
    </div>
  );
}
