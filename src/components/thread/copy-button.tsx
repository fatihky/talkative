/*
 * CopyButton — copies message text with a brief "Copied" confirmation.
 *
 * The handoff styles copy as a `.msg-actions button`: a bordered pill
 * with an icon and, for user turns, a "Copy" text label; assistant turns
 * use the icon-only variant. `label` toggles the text.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';

export function CopyButton({
  text,
  label = false,
}: {
  text: string;
  label?: boolean;
}) {
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
        className={label ? undefined : 'icon-only'}
      >
        <I n={copied ? 'check' : 'copy'} s={12} />
        {label && <span>{copied ? 'Copied' : 'Copy'}</span>}
      </button>
    </Tip>
  );
}
