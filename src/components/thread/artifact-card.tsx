/*
 * ArtifactCard — inline card for one version the artifact tool wrote.
 *
 * Business logic:
 * - renders nothing when the tool call isn't an artifact snapshot.
 * - clicking pins the right panel to that exact version, scoped to this
 *   chat; the panel falls back once the source message leaves the
 *   visible branch.
 * - the verb comes from the call's action arg (create/update/edit →
 *   Created/Rewrote/Edited); bad args degrade to a generic "Wrote".
 * - shows title, language (or kind), and the version number.
 */
'use client';

import { useParams_UNSTABLE } from 'waku/router/client';
import { callSnapshot } from '../../lib/artifacts';
import { I } from '../../lib/icons';
import { actions } from '../../stores';
import type { ToolCall } from '../../types';

const ARTIFACT_VERB: Record<string, string> = {
  create: 'Created',
  update: 'Rewrote',
  edit: 'Edited',
};

/* a version the artifact tool wrote; opens that exact version in the panel */
export function ArtifactCard({ c }: { c: ToolCall }) {
  const params = useParams_UNSTABLE({ from: '/c/[slug]' });
  const chatId = params?.slug ?? '';
  const s = callSnapshot(c);
  if (!s) return null;
  let verb = 'Wrote';
  try {
    const { action } = JSON.parse(c.args || '{}') as { action?: unknown };
    verb = ARTIFACT_VERB[String(action)] ?? verb;
  } catch {
    /* the label just stays generic */
  }
  return (
    <button
      type="button"
      onClick={() => actions.openArtifact(chatId, s.id, s.version)}
      className="flex items-center gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-left text-[12px] hover:bg-[var(--sunken)]"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[5px] border border-[var(--border)] bg-[var(--raised)] text-[var(--text-2)]">
        <I
          n={
            s.kind === 'code' ? 'file' : s.kind === 'markdown' ? 'note' : 'grid'
          }
          s={13}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{s.title}</span>
        <span className="num truncate text-[11px] muted">
          {verb} · {s.language ?? s.kind} · v{s.version}
        </span>
      </span>
      <span className="shrink-0 text-[11px] muted">Open</span>
    </button>
  );
}
