/*
 * BranchNav — sibling-branch stepper (‹ 2/3 ›) under a branched turn.
 *
 * Business logic:
 * - shown only when the turn has siblings; the counter marks the
 *   position in the list.
 * - stepping calls switchBranch, which walks to the sibling branch's
 *   deepest tip, restoring the child last shown under each parent so
 *   nested branch choices survive navigating away and back.
 * - arrows disable at the ends of the sibling list.
 */
'use client';

import { I } from '../../lib/icons';
import { actions } from '../../stores';

/** `‹ 2/3 ›` under a turn that has siblings; stepping lands on that branch's latest turn */
export function BranchNav({
  chatId,
  ids,
  id,
}: {
  chatId: string;
  ids: string[];
  id: string;
}) {
  const i = ids.indexOf(id);
  const prev = ids[i - 1];
  const next = ids[i + 1];
  const btn =
    'ctl-icon h-6 w-5 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] disabled:opacity-30';
  return (
    <div className="flex items-center text-[11px] muted">
      <button
        type="button"
        disabled={!prev}
        onClick={() => prev && actions.switchBranch(chatId, prev)}
        aria-label="Previous branch"
        className={btn}
      >
        <I n="chevron-left" s={11} />
      </button>
      <span className="num min-w-[26px] text-center">
        {i + 1}/{ids.length}
      </span>
      <button
        type="button"
        disabled={!next}
        onClick={() => next && actions.switchBranch(chatId, next)}
        aria-label="Next branch"
        className={btn}
      >
        <I n="chevron-right" s={11} />
      </button>
    </div>
  );
}
