/*
 * RecentModelsRow / StageHint — helper rows under the home greeting.
 *
 * Business logic:
 * - RecentModelsRow lists recently used models; it hides entirely when
 *   there are none, skips ids missing from the catalog, and clicking a
 *   name selects that model for the draft.
 * - StageHint is a static shortcut legend (send, newline, search, tools,
 *   params) using the platform's mod key.
 */
'use client';

import { actions, useModelsStore, useRecentModelIds, useUIStore } from '../../stores';
import { Kbd } from '../../ui/primitives';

export function RecentModelsRow() {
  const ids = useRecentModelIds();
  const items = useModelsStore((s) => s.items);
  if (ids.length === 0) return null;
  return (
    <div className="mt-6 flex items-baseline gap-2 text-[12px]">
      <span className="sec-label shrink-0">recent</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {ids.map((id, i) => {
          const m = items.find((x) => x.id === id);
          if (!m) return null;
          return (
            <span key={id} className="flex items-center gap-2">
              {i > 0 && (
                <span className="muted" aria-hidden="true">
                  ·
                </span>
              )}
              <button
                type="button"
                onClick={() => actions.setModel(id)}
                className="text-[var(--text-3)] transition-colors hover:text-[var(--accent)]"
              >
                {m.shortName}
              </button>
            </span>
          );
        })}
      </span>
    </div>
  );
}

export function StageHint() {
  const mod = useUIStore((s) => s.mod);
  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] muted">
      <Kbd>⏎</Kbd>
      <span>send</span>
      <span aria-hidden="true">·</span>
      <Kbd>⇧⏎</Kbd>
      <span>newline</span>
      <span aria-hidden="true">·</span>
      <Kbd>{mod}K</Kbd>
      <span>search</span>
      <span aria-hidden="true">·</span>
      <Kbd>Ctrl+T</Kbd>
      <span>tools</span>
      <span aria-hidden="true">·</span>
      <Kbd>Ctrl+⇧P</Kbd>
      <span>params</span>
    </div>
  );
}
