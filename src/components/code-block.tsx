/*
 * CodeBlockView — fenced code block with a collapse header, copy,
 * download and an html/svg preview hook.
 *
 * Business logic:
 * - Serves as the markdown renderer for `html` and `svg` fences and as the
 *   artifact panel's code view; collapsed by default with the header row
 *   always visible, and streamdown's own chrome is neutralized inside so
 *   only one box shows.
 * - `alwaysExpanded` (the artifact panel) renders the code inline with no
 *   header, no copy button and no collapsing.
 * - Only html and svg fences offer "Preview in panel"; it hands the
 *   snippet plus msgId/chatId to the layout store so the preview tab is
 *   scoped to the branch that message is on and goes away with it.
 * - Copy and download are best-effort: a denied clipboard write is
 *   swallowed silently, and the download is named code.<language ext>.
 */
'use client';

import { useState } from 'react';
import { CodeBlock } from 'streamdown';
import { I } from '../lib/icons';
import { Tip } from '../lib/popover';
import { actions } from '../stores';

/* props forwarded by Streamdown's code-block renderer */
export function CodeBlockView({
  code,
  language,
  isIncomplete,
  startLine,
  lineNumbers,
  msgId,
  chatId,
  alwaysExpanded = false,
}: {
  code: string;
  language: string;
  isIncomplete?: boolean;
  startLine?: number;
  lineNumbers?: boolean;
  /* the message this block lives in, so the preview scopes to its branch */
  msgId?: string | undefined;
  chatId?: string | undefined;
  /* render the code inline without the collapsible header */
  alwaysExpanded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = alwaysExpanded || open;

  const isHtml = language === 'html';
  const isSvg = language === 'svg';
  const previewable = isHtml || isSvg;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* noop — user sees nothing */
    }
  };

  const download = () => {
    const ext = isHtml ? 'html' : isSvg ? 'svg' : language.split(/\s+/)[0];
    const url = URL.createObjectURL(
      new Blob([code], {
        type: isHtml ? 'text/html' : isSvg ? 'image/svg+xml' : 'text/plain',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `code.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const ICON_BTN =
    'ctl-icon h-6 w-6 shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] disabled:opacity-40';

  if (alwaysExpanded)
    return (
      <div
        className="flex w-full flex-col overflow-hidden"
        data-language={language}
        data-streamdown="code-block"
      >
        <CodeBlock
          code={code}
          language={language}
          {...(isIncomplete !== undefined && { isIncomplete })}
          {...(startLine !== undefined && { startLine })}
          {...(lineNumbers !== undefined && { lineNumbers })}
        />
      </div>
    );

  return (
    <div
      className="my-4 flex w-full flex-col overflow-hidden rounded-xl border border-border bg-sidebar"
      data-language={language}
      data-streamdown="code-block"
    >
      {/* header row — always visible */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full cursor-pointer items-center gap-1 px-2 text-muted-foreground text-xs hover:text-foreground [&::-webkit-details-marker]:hidden"
        data-language={language}
        data-streamdown="code-block-header"
        aria-label={expanded ? 'Collapse code' : 'Expand code'}
      >
        <I n="chevron-down" s={10} className={expanded ? '-rotate-180' : ''} />
        <span className="ml-1 truncate font-mono lowercase">{language}</span>
        <span className="ml-auto flex items-center gap-1 text-[11px] muted">
          <Tip label="Copy" side="bottom">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                copy();
              }}
              aria-label="Copy code"
              className={ICON_BTN}
            >
              <I n="copy" s={11} />
            </button>
          </Tip>
          {previewable && (
            <Tip label="Preview in panel" side="bottom">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.openPreview({
                    code,
                    language: isHtml ? 'html' : 'svg',
                    msgId: msgId ?? '',
                    chatId: chatId ?? '',
                  });
                }}
                aria-label="Preview in panel"
                className={ICON_BTN}
              >
                <I n="play" s={11} />
              </button>
            </Tip>
          )}
          <Tip label="Download" side="bottom">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                download();
              }}
              aria-label="Download"
              className={ICON_BTN}
            >
              <I n="arrow-up" s={11} className="rotate-180" />
            </button>
          </Tip>
        </span>
      </button>

      {/* expandable body — streamdown's own chrome is neutralized so only one box shows */}
      {expanded && (
        <div className="[&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden">
          <CodeBlock
            code={code}
            language={language}
            {...(isIncomplete !== undefined && { isIncomplete })}
            {...(startLine !== undefined && { startLine })}
            {...(lineNumbers !== undefined && { lineNumbers })}
          />
        </div>
      )}
    </div>
  );
}
