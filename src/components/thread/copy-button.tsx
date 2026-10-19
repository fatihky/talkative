/*
 * CopyButton — copies message text with a brief "Copied" confirmation.
 *
 * The handoff styles copy as a `.msg-actions button.icon-only`: a bordered
 * icon-only pill; the clipboard icon swaps to a check while the "Copied"
 * tooltip is showing. The accessible name carries the state.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';

export function CopyButton({ text }: { text: string }) {
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
    <Tip label={copied ? 'Copied' : 'Copy'} side="top">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy message'}
        className="icon-only"
      >
        <I n={copied ? 'check' : 'copy'} s={12} />
      </button>
    </Tip>
  );
}
