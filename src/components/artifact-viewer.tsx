/*
 * ArtifactViewer — public, chrome-free page for one frozen published
 * artifact version.
 *
 * Business logic:
 * - Rendered by /a/<id> with no auth and no app shell; the page only
 *   passes it rows that are still published, so an unpublished or removed
 *   artifact shows "not found" instead of this.
 * - Shows the snapshot frozen at publish time, never the live chat: later
 *   versions and edits stay invisible here until it's re-published (which
 *   keeps the same link).
 * - Code artifacts open in the code view; every other kind defaults to
 *   preview with a preview|code switch, reusing the panel's renderer and
 *   its sandboxing — html may script but has no same-origin access, svg
 *   gets none. Fullscreen is html/svg only and closes on esc.
 * - "Open chat" appears only when the artifact still knows its source
 *   chat, and deep-links to the branch it came from (?leaf=), which for an
 *   anonymous visitor runs into the login guard.
 * - Copy and download work on the frozen content; there are no publish,
 *   private or delete controls on this page.
 */
'use client';

import { useEffect, useState } from 'react';
import { Link } from 'waku/router/client';
import {
  type ArtifactSnapshot,
  artifactFilename,
  artifactMime,
} from '../lib/artifacts';
import { I } from '../lib/icons';
import { Tip } from '../lib/popover';
import type { PublicArtifact } from '../types';
import { ArtifactBody, svgDoc } from './artifact-panel';

const ICON_BTN =
  'ctl-icon h-7 w-7 shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] disabled:opacity-40';

/* a frozen published version; `owner` adds a link back into the source chat */
export function ArtifactViewer({ artifact }: { artifact: PublicArtifact }) {
  const snapshot: ArtifactSnapshot = {
    id: artifact.artifactId,
    title: artifact.title,
    kind: artifact.kind,
    ...(artifact.language ? { language: artifact.language } : {}),
    content: artifact.content,
    version: artifact.version,
  };
  const previewable = artifact.kind !== 'code';
  const [view, setView] = useState<'preview' | 'code'>(
    previewable ? 'preview' : 'code',
  );
  const [fullscreen, setFullscreen] = useState(false);

  const open = snapshot.kind === 'html' || snapshot.kind === 'svg';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-4">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <I
            n={
              artifact.kind === 'code'
                ? 'file'
                : artifact.kind === 'markdown'
                  ? 'note'
                  : 'grid'
            }
            s={15}
            className="shrink-0 text-[var(--text-2)]"
          />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
            {artifact.title}
          </span>
        </span>
        {artifact.chatId && (
          <Link
            to={`/c/${artifact.chatId}${artifact.leafId ? `?leaf=${artifact.leafId}` : ''}`}
            className="ctl h-7 shrink-0 gap-1.5 rounded-[6px] px-2 text-[12px]"
          >
            <I n="chat" s={12} />
            Open chat
          </Link>
        )}
      </header>

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <span className="num truncate text-[11px] muted">
          {artifact.language ?? artifact.kind} · v{artifact.version}
          {artifact.chatTitle ? ` · from “${artifact.chatTitle}”` : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {previewable && (
            <div className="flex h-7 items-center rounded-[6px] border border-[var(--border)] p-0.5">
              {(['preview', 'code'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`h-6 rounded-[4px] px-2 text-[11px] capitalize ${
                    view === v
                      ? 'bg-[var(--raised)] font-medium'
                      : 'text-[var(--text-2)]'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          <CopyArtifact text={artifact.content} />
          <Tip label="Download" side="bottom">
            <button
              type="button"
              aria-label="Download"
              onClick={() => download(snapshot)}
              className={ICON_BTN}
            >
              <I n="arrow-up" s={13} className="rotate-180" />
            </button>
          </Tip>
          {previewable && view === 'preview' && open && (
            <Tip label="Fullscreen" side="bottom">
              <button
                type="button"
                aria-label="Fullscreen"
                onClick={() => setFullscreen(true)}
                className={ICON_BTN}
              >
                <I n="maximize" s={13} />
              </button>
            </Tip>
          )}
        </div>
      </div>

      <ArtifactBody
        key={`${artifact.id}@${artifact.version}:${view}`}
        s={snapshot}
        view={view}
      />

      {fullscreen && previewable && open && (
        <FullscreenArtifact
          s={snapshot}
          onClose={() => setFullscreen(false)}
        />
      )}
    </div>
  );
}

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
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Tip label={copied ? 'Copied' : 'Copy'} side="bottom">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy'}
        className={ICON_BTN}
      >
        <I n={copied ? 'check' : 'copy'} s={13} />
      </button>
    </Tip>
  );
}

function FullscreenArtifact({
  s,
  onClose,
}: {
  s: ArtifactSnapshot;
  onClose: () => void;
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
        <span className="min-w-0 flex-1 truncate px-1 text-[12px] font-medium">
          {s.title}
        </span>
        <button
          type="button"
          aria-label="Exit fullscreen"
          onClick={onClose}
          className={ICON_BTN}
        >
          <I n="x" s={14} />
        </button>
      </div>
      <iframe
        title={s.title}
        sandbox={
          s.kind === 'html'
            ? 'allow-scripts allow-forms allow-modals allow-popups'
            : ''
        }
        srcDoc={s.kind === 'html' ? s.content : svgDoc(s.content)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
