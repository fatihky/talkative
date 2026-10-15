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
 *
 * Styled by the handoff's `.branch-nav` inside `.msg-actions`.
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
  return (
    <span className="branch-nav">
      <button
        type="button"
        disabled={!prev}
        onClick={() => prev && actions.switchBranch(chatId, prev)}
        aria-label="Previous branch"
      >
        <I n="chevron-left" s={12} />
      </button>
      <span className="branch-dots" aria-hidden="true">
        {ids.map((sid, idx) => (
          <span key={sid} className={idx === i ? 'on' : ''} />
        ))}
      </span>
      <span className="num">
        {i + 1} / {ids.length}
      </span>
      <button
        type="button"
        disabled={!next}
        onClick={() => next && actions.switchBranch(chatId, next)}
        aria-label="Next branch"
      >
        <I n="chevron-right" s={12} />
      </button>
    </span>
  );
}
