/* CopyButton — copies message text with a brief "Copied" confirmation. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';

const HOVER_ICON =
  'ctl-icon h-6 w-6 border-transparent bg-transparent text-[var(--text-2)] opacity-0 transition-opacity group-hover/msg:opacity-100 hover:bg-[var(--sunken)] focus-visible:opacity-100 pointer-coarse:opacity-100';

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
    <Tip label={copied ? 'Copied' : 'Copy'} side="bottom">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy message'}
        className={HOVER_ICON}
      >
        <I n={copied ? 'check' : 'copy'} s={12} />
      </button>
    </Tip>
  );
}
