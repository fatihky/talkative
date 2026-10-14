/*
 * ArtifactPanel — right-panel browser for the artifacts of the branch on
 * screen: version stepping, preview, download and publishing.
 *
 * Business logic:
 * - Artifacts have no table of their own: they're collected from the
 *   successful `artifact` tool calls along the visible branch, so
 *   switching chat or branch swaps the whole list.
 * - A stored selection only wins while it belongs to this chat and is
 *   still on the branch; otherwise the panel shows the artifact that
 *   changed last. `version: null` follows the newest version as the model
 *   streams, and stepping onto the newest one resumes that following.
 * - Code artifacts can't be previewed, so their view is forced to `code`;
 *   the other kinds get the preview|code switch.
 * - Previews are sandboxed iframes: html may run scripts but gets no
 *   same-origin access to this app's storage, svg gets no permissions at
 *   all. The body is keyed by id@version:view so a new version remounts
 *   the iframe instead of patching srcdoc mid-script.
 * - Fullscreen is html/svg previews only and closes on esc; downloads are
 *   named from the artifact id plus kind/language, and a denied clipboard
 *   write fails silently instead of claiming "Copied".
 * - Sharing never publishes by accident: copying a link only copies, and
 *   going public always asks through the confirm dialog first, because it
 *   exposes that frozen version at /a/<id> with no auth. Re-publishing the
 *   same artifact keeps the link stable, so a published version whose
 *   content moved on gets its own "update" action; making it private is a
 *   danger confirm that kills the link until it's published again.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'waku';
import {
  type ArtifactSnapshot,
  type ArtifactVersion,
  artifactFilename,
  artifactMime,
  collectArtifacts,
} from '../lib/artifacts';
import { I } from '../lib/icons';
import { Tip } from '../lib/popover';
import {
  actions,
  useArtifactsStore,
  usePublishedStore,
  useThreadsStore,
} from '../stores';
import { branchPath } from '../stores/threads';
import { errorText } from '../stores/models';
import { SegmentedControl } from '../ui/primitives';
import { CodeBlockView } from './code-block';
import { Markdown } from './markdown';

const ICON_BTN =
  'ctl-icon h-6 w-6 shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] disabled:opacity-40';

/* the artifacts written along the branch on screen; switching branches switches them too */
export function ArtifactPanel() {
  const router = useRouter();
  const chatId = /^\/c\/([^/]+)/.exec(router.path)?.[1] ?? '';
  const thread = useThreadsStore((s) => s.threads[chatId]);
  const sel = useArtifactsStore();
  const [fullscreen, setFullscreen] = useState(false);
  const artifacts = useMemo(
    () =>
      thread
        ? collectArtifacts(branchPath(thread.messages, thread.leafId))
        : [],
    [thread],
  );

  /* a selection from another chat or branch falls back to whatever changed last */
  const mine = sel.chatId === chatId;
  const artifact =
    (mine && artifacts.find((a) => a.id === sel.id)) || artifacts.at(-1);
  if (!artifact) return <ArtifactEmptyState />;
  const { versions } = artifact;
  const pinned =
    mine && sel.id === artifact.id && sel.version !== null
      ? versions.find((v) => v.version === sel.version)
      : undefined;
  const shown = pinned ?? versions.at(-1);
  if (!shown) return <ArtifactEmptyState />;
  const idx = versions.indexOf(shown);
  const previewable = shown.kind !== 'code';
  const view = previewable ? sel.view : 'code';

  /* stepping onto the newest version resumes following new ones */
  const step = (d: number) => {
    const next = versions[idx + d];
    if (next)
      actions.openArtifact(
        chatId,
        artifact.id,
        idx + d === versions.length - 1 ? null : next.version,
      );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
        {artifacts.length > 1 ? (
          <select
            aria-label="Artifact"
            value={artifact.id}
            onChange={(e) => actions.openArtifact(chatId, e.target.value)}
            className="h-6 min-w-0 flex-1 truncate rounded-[5px] border border-[var(--border)] bg-[var(--raised)] px-1 text-[12px] font-medium"
          >
            {[...artifacts].reverse().map((a) => (
              <option key={a.id} value={a.id}>
                {a.versions.at(-1)?.title ?? a.id}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-[12px] font-medium">
            {shown.title}
          </span>
        )}
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label="Previous version"
            disabled={idx === 0}
            onClick={() => step(-1)}
            className={ICON_BTN}
          >
            <I n="chevron-left" s={12} />
          </button>
          <span className="num min-w-[44px] text-center text-[11px] muted">
            v{shown.version}/{versions.length}
          </span>
          <button
            type="button"
            aria-label="Next version"
            disabled={idx === versions.length - 1}
            onClick={() => step(1)}
            className={ICON_BTN}
          >
            <I n="chevron-right" s={12} />
          </button>
        </div>
        {previewable && (
          <SegmentedControl
            ariaLabel="Artifact view"
            value={view}
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'code', label: 'Code' },
            ]}
            onChange={(v) => actions.setArtifactView(v as 'preview' | 'code')}
            disabled={false}
          />
        )}
        <CopyArtifact text={shown.content} />
        <Tip label="Download" side="bottom">
          <button
            type="button"
            aria-label="Download artifact"
            onClick={() => download(shown)}
            className={ICON_BTN}
          >
            <I n="arrow-up" s={12} className="rotate-180" />
          </button>
        </Tip>
        <ShareArtifact chatId={chatId} s={shown} />
        {previewable &&
          view === 'preview' &&
          (shown.kind === 'html' || shown.kind === 'svg') && (
            <Tip
              label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              side="bottom"
            >
              <button
                type="button"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                onClick={() => setFullscreen((f) => !f)}
                className={ICON_BTN}
              >
                <I n={fullscreen ? 'minimize' : 'maximize'} s={12} />
              </button>
            </Tip>
          )}
      </div>
      {/* keyed so a new version remounts the iframe instead of patching srcdoc mid-script */}
      <ArtifactBody
        key={`${artifact.id}@${shown.version}:${view}`}
        s={shown}
        view={view}
      />
      {fullscreen &&
        previewable &&
        view === 'preview' &&
        (shown.kind === 'html' || shown.kind === 'svg') && (
          <FullscreenPreview s={shown} onClose={() => setFullscreen(false)} />
        )}
    </div>
  );
}

export function ArtifactBody({
  s,
  view,
}: {
  s: ArtifactSnapshot;
  view: 'preview' | 'code';
}) {
  if (view === 'preview' && s.kind === 'html')
    return (
      <iframe
        title={s.title}
        /* no allow-same-origin: model-written scripts can't reach this app's storage or cookies */
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        srcDoc={s.content}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    );
  if (view === 'preview' && s.kind === 'svg')
    return (
      <iframe
        title={s.title}
        sandbox=""
        srcDoc={svgDoc(s.content)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    );
  if (view === 'preview' && s.kind === 'mermaid')
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-[1.55]">
        <Markdown text={`\`\`\`mermaid\n${s.content}\n\`\`\``} />
      </div>
    );
  if (view === 'preview' && s.kind === 'markdown')
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-[1.55]">
        <Markdown text={s.content} />
      </div>
    );
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-[1.55]">
      <CodeBlockView
        code={s.content}
        language={s.language ?? FENCE_LANG[s.kind]}
        alwaysExpanded
      />
    </div>
  );
}

const FENCE_LANG: Record<ArtifactSnapshot['kind'], string> = {
  code: 'text',
  markdown: 'markdown',
  html: 'html',
  svg: 'xml',
  mermaid: 'mermaid',
};

export const svgDoc = (svg: string) =>
  '<!doctype html><html><head><style>html,body{margin:0;height:100%}' +
  'body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh;height:auto}' +
  `</style></head><body>${svg}</body></html>`;

const download = (s: ArtifactSnapshot) => {
  const url = URL.createObjectURL(
    new Blob([s.content], { type: artifactMime(s) }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = artifactFilename(s);
  a.click();
  URL.revokeObjectURL(url);
};

function CopyArtifact({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Tip label={copied ? 'Copied' : 'Copy'} side="bottom">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy artifact'}
        className={ICON_BTN}
      >
        <I n={copied ? 'check' : 'copy'} s={12} />
      </button>
    </Tip>
  );
}

/* sharing for the version on screen: copying a link never publishes, and going
   public always asks first. re-publishing keeps the same public link. */
function ShareArtifact({
  chatId,
  s,
}: {
  chatId: string;
  s: ArtifactVersion;
}) {
  const { items, status } = usePublishedStore();
  const [busy, setBusy] = useState(false);

  /* know whether this artifact is already public before offering the actions */
  useEffect(() => {
    if (status === 'idle') void actions.loadPublished();
  }, [status]);

  const pub = items.find((a) => a.artifactId === s.id && a.published);
  const link = pub ? `${location.origin}/a/${pub.id}` : null;
  const outdated =
    !!pub && (pub.version !== s.version || pub.content !== s.content);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      actions.toast('Public link copied', 'info');
    } catch {
      actions.toast('Could not copy link', 'error');
    }
  };

  const publish = async () => {
    /* the list may still be loading; make sure we ask the right question */
    if (usePublishedStore.getState().status === 'idle') {
      await actions.loadPublished();
    }
    const current = usePublishedStore
      .getState()
      .items.find((a) => a.artifactId === s.id && a.published);
    const ok = await actions.confirm({
      title: current
        ? `Update the public link for “${s.title}”?`
        : `Publish “${s.title}”?`,
      body: 'Anyone with the link will be able to view this version.',
      confirmLabel: current ? 'Update' : 'Publish',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const saved = await actions.publish({
        artifactId: s.id,
        title: s.title,
        kind: s.kind,
        ...(s.language ? { language: s.language } : {}),
        content: s.content,
        version: s.version,
        chatId,
        messageId: s.messageId,
        callId: s.callId,
        leafId: s.messageId,
      });
      const url = `${location.origin}/a/${saved.id}`;
      try {
        await navigator.clipboard.writeText(url);
        actions.toast('Published — public link copied', 'info');
      } catch {
        actions.toast('Published', 'info');
      }
    } catch (e) {
      actions.toast(
        `Couldn't publish — ${e instanceof Error ? e.message : 'error'}`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const makePrivate = async () => {
    if (!pub) return;
    const ok = await actions.confirm({
      title: `Make “${s.title}” private?`,
      body: 'Its public link will stop working. You can publish it again later.',
      confirmLabel: 'Make private',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await actions.setPublished(pub.id, false);
      actions.toast('Artifact is now private', 'info');
    } catch (e) {
      actions.toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {link ? (
        <Tip label="Copy public link" side="bottom">
          <button
            type="button"
            aria-label="Copy public link"
            disabled={busy}
            onClick={() => void copy()}
            className={ICON_BTN}
          >
            <I n="link" s={12} />
          </button>
        </Tip>
      ) : (
        <Tip label="Publish to share" side="bottom">
          <button
            type="button"
            aria-label="Publish artifact"
            disabled={busy}
            onClick={() => void publish()}
            className={ICON_BTN}
          >
            <I n="link" s={12} />
          </button>
        </Tip>
      )}
      {pub && outdated && (
        <Tip label="Update public link" side="bottom">
          <button
            type="button"
            aria-label="Update public link"
            disabled={busy}
            onClick={() => void publish()}
            className={ICON_BTN}
          >
            <I n="retry" s={12} />
          </button>
        </Tip>
      )}
      {pub && (
        <Tip label="Make private" side="bottom">
          <button
            type="button"
            aria-label="Make artifact private"
            disabled={busy}
            onClick={() => void makePrivate()}
            className={ICON_BTN}
          >
            <I n="lock" s={12} />
          </button>
        </Tip>
      )}
    </>
  );
}

function FullscreenPreview({
  s,
  onClose,
}: {
  s: ArtifactSnapshot;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-[12px] font-medium">
          {s.title}
        </span>
        <Tip label="Exit fullscreen" side="bottom">
          <button
            type="button"
            aria-label="Exit fullscreen"
            onClick={onClose}
            className={ICON_BTN}
          >
            <I n="x" s={14} />
          </button>
        </Tip>
      </div>
      {s.kind === 'html' ? (
        <iframe
          title={s.title}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          srcDoc={s.content}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : (
        <iframe
          title={s.title}
          sandbox=""
          srcDoc={svgDoc(s.content)}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}

export function ArtifactEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <I n="grid" s={28} className="text-[var(--text-3)]" />
      <div className="text-[13px] font-medium">No artifacts yet</div>
      <div className="max-w-[260px] text-[12px] muted">
        Code, documents, and previews generated by the model will open here as
        you iterate on them.
      </div>
    </div>
  );
}
