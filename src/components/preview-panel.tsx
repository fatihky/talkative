/*
 * PreviewPanel — the right panel's tab for a raw html/svg snippet copied
 * out of a code block, plus the hook that decides when it's valid.
 *
 * Business logic:
 * - A snippet counts only while its chat is the route on screen
 *   (/c/<id>) and its source message is still on the branch path to the
 *   current leaf; switching branch or chat hides the preview and disables
 *   the panel's preview tab.
 * - Preview is a tab, not a panel mode, so the panel toggle reopens
 *   whatever was last shown instead of always jumping to a preview.
 * - html renders as-is; svg is wrapped in a document that centers it the
 *   way the artifact preview does.
 * - The iframe is sandboxed without allow-same-origin, so model-written
 *   scripts can't reach this app's storage or cookies; svg gets an empty
 *   sandbox, i.e. no privileges at all.
 * - The iframe is keyed on language + code length so a different snippet
 *   remounts it rather than patching srcdoc mid-script.
 * - Fullscreen repeats the same sandbox in a fixed overlay dismissed by
 *   Esc or the close button; with no valid snippet the tab says there's
 *   nothing to preview yet.
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'waku';
import { I } from '../lib/icons';
import {
  actions,
  type PreviewSnippet,
  useLayoutStore,
  useThreadsStore,
} from '../stores';
import { branchPath } from '../stores/threads';

/* the snippet only counts while its source message is on the branch on screen */
export function useScopedPreview(): PreviewSnippet | null {
  const router = useRouter();
  const snippet = useLayoutStore((s) => s.preview);
  const thread = useThreadsStore((s) =>
    snippet ? s.threads[snippet.chatId] : undefined,
  );
  if (!snippet) return null;
  const chatId = /^\/c\/([^/]+)/.exec(router.path)?.[1] ?? '';
  if (chatId !== snippet.chatId) return null;
  if (!thread) return null;
  return branchPath(thread.messages, thread.leafId).some(
    (m) => m.id === snippet.msgId,
  )
    ? snippet
    : null;
}

/* wraps an svg snippet so it centers like the artifact preview does */
const svgDoc = (svg: string) =>
  '<!doctype html><html><head><style>html,body{margin:0;height:100%}' +
  'body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh;height:auto}' +
  '</style></head><body>' +
  svg +
  '</body></html>';

/* Raw html/svg snippet from a code block, shown as its own tab in the right panel. */
export function PreviewPanel() {
  const snippet = useScopedPreview();
  const [fullscreen, setFullscreen] = useState(false);
  if (!snippet)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-[12px] muted">
        Nothing to preview yet.
      </div>
    );
  const isHtml = snippet.language === 'html';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium">
          <I n="play" s={11} className="shrink-0 text-muted-foreground" />
          <span className="truncate">Preview · {snippet.language}</span>
        </span>
        <button
          type="button"
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={() => setFullscreen((f) => !f)}
          className="ctl-icon border-transparent bg-transparent text-muted-foreground hover:bg-muted"
        >
          <I n={fullscreen ? 'minimize' : 'maximize'} s={11} />
        </button>
      </div>
      {/* keyed so switching snippets remounts the iframe instead of patching srcdoc mid-script */}
      <iframe
        key={`${snippet.language}:${snippet.code.length}`}
        title={`${snippet.language} preview`}
        /* no allow-same-origin: model-written scripts can't reach this app's storage or cookies */
        sandbox={
          isHtml ? 'allow-scripts allow-forms allow-modals allow-popups' : ''
        }
        srcDoc={isHtml ? snippet.code : svgDoc(snippet.code)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
      {fullscreen && (
        <FullscreenPreview
          snippet={snippet}
          onClose={() => setFullscreen(false)}
        />
      )}
    </div>
  );
}

function FullscreenPreview({
  snippet,
  onClose,
}: {
  snippet: PreviewSnippet;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const isHtml = snippet.language === 'html';
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium">
          <I n="play" s={11} className="shrink-0 text-muted-foreground" />
          <span className="truncate">Preview · {snippet.language}</span>
        </span>
        <button
          type="button"
          aria-label="Exit fullscreen"
          title="Exit fullscreen"
          onClick={onClose}
          className="ctl-icon border-transparent bg-transparent text-muted-foreground hover:bg-muted"
        >
          <I n="x" s={13} />
        </button>
      </div>
      <iframe
        title={`${snippet.language} preview`}
        sandbox={
          isHtml ? 'allow-scripts allow-forms allow-modals allow-popups' : ''
        }
        srcDoc={isHtml ? snippet.code : svgDoc(snippet.code)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
