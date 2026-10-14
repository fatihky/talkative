/*
 * HomeBannerStack — info/warn/error notice banners above the composer.
 *
 * Business logic:
 * - Renders nothing with zero banners; collapsed shows only the first
 *   two, with an "N more notices" button to expand the rest.
 * - Level drives the icon and left-border color (warn/error highlighted).
 * - Only info banners get a ✕, and it just collapses the stack; warn/error
 *   are derived from live app state and can't be dismissed here.
 * - Action buttons dispatch their kind through the global bannerAction
 *   handler (retry catalog, open settings, switch provider, pick a 1M
 *   model, drop the largest attachment).
 */
'use client';

import { I } from '../../lib/icons';
import { actions, useUIStore } from '../../stores';
import type { Banner } from '../../types';

const LEVEL_ICON: Record<Banner['level'], string> = {
  info: 'info',
  warn: 'alert',
  error: 'alert',
};
const LEVEL_COLOR: Record<Banner['level'], string> = {
  info: 'var(--text-2)',
  warn: 'var(--warn)',
  error: 'var(--danger)',
};

export function HomeBannerStack({ items }: { items: Banner[] }) {
  const expanded = useUIStore((s) => s.noticesExpanded);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, 2);
  const hiddenCount = items.length - shown.length;
  return (
    <div
      className="mx-auto w-full max-w-[640px] space-y-1.5 px-4 pb-2 sm:px-6"
      role="status"
      aria-live="polite"
    >
      {shown.map((b) => (
        <div
          key={b.id}
          className="flex min-h-8 items-center gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[12px]"
          style={{ borderLeftWidth: 2, borderLeftColor: LEVEL_COLOR[b.level] }}
        >
          <I
            n={LEVEL_ICON[b.level]}
            s={13}
            style={{ color: LEVEL_COLOR[b.level] }}
            className="shrink-0"
          />
          <span className="min-w-0 flex-1">{b.text}</span>
          {b.actions?.map((a) => (
            <button
              key={a.kind}
              type="button"
              className="ctl h-6 shrink-0 px-2 text-[11px]"
              onClick={() => actions.bannerAction(a.kind)}
            >
              {a.label}
            </button>
          ))}
          {b.level === 'info' && (
            <button
              type="button"
              className="muted shrink-0 hover:text-[var(--text)]"
              aria-label="Dismiss"
              onClick={() => actions.setNoticesExpanded(false)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {hiddenCount > 0 && !expanded && (
        <button
          type="button"
          className="flex items-center gap-1 text-[12px] muted hover:text-[var(--text)]"
          onClick={() => actions.setNoticesExpanded(true)}
        >
          <I n="alert" s={12} style={{ color: 'var(--warn)' }} /> ⚠{' '}
          {hiddenCount} more notice{hiddenCount > 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}
