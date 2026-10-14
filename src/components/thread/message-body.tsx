/*
 * MessageBody — renders a reply's text interleaved with its thoughts
 * and tool calls.
 *
 * Business logic:
 * - a plain reply (no thoughts, no calls) renders as a single markdown
 *   block.
 * - otherwise the text is split at each step's recorded offset so
 *   thoughts and calls appear where the model had them; within a step
 *   the thinking comes first, then the calls it led to.
 * - offsets are clamped to the text length and kept monotonic — text
 *   can lag tool events briefly after a reconnect.
 * - calls render by kind: a running ask_user becomes the interactive
 *   QuestionCard, an artifact snapshot an ArtifactCard, everything else
 *   a collapsed ToolCallView.
 * - a thought only counts as live while the reply streams and no
 *   duration was reported yet, so the indicator can't hang.
 * - onRetry (rerun a failed call and continue as a new branch) is
 *   passed only while nothing in the chat is generating.
 */
'use client';

import { callSnapshot } from '../../lib/artifacts';
import type { Thought, ToolCall } from '../../types';
import { Markdown } from '../markdown';
import { ArtifactCard } from './artifact-card';
import { QuestionCard } from './question-card';
import { ThoughtView } from './thought-view';
import { ToolCallView } from './tool-call-view';

type Segment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thought'; key: string; thought: Thought }
  | { kind: 'tools'; key: string; calls: ToolCall[] };

/* splits the reply text at each step so thoughts and calls show where the model had them;
   within a step the thinking comes first, then the text and calls it led to */
const segments = (
  content: string,
  calls: ToolCall[],
  thoughts: Thought[],
): Segment[] => {
  const anchors: { at: number; seg: Segment }[] = [];
  const steps = new Set([...thoughts, ...calls].map((x) => x.step));
  for (const step of [...steps].sort((a, b) => a - b)) {
    const thought = thoughts.find((t) => t.step === step);
    if (thought)
      anchors.push({
        at: thought.at,
        seg: { kind: 'thought', key: `r${step}`, thought },
      });
    const group = calls.filter((c) => c.step === step);
    if (group[0])
      anchors.push({
        at: group[0].at,
        seg: { kind: 'tools', key: `s${step}`, calls: group },
      });
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const { at: want, seg } of anchors) {
    /* text can lag the tool events briefly after a reconnect */
    const at = Math.min(Math.max(pos, want), content.length);
    if (at > pos)
      out.push({ kind: 'text', key: `t${pos}`, text: content.slice(pos, at) });
    out.push(seg);
    pos = at;
  }
  if (pos < content.length)
    out.push({ kind: 'text', key: `t${pos}`, text: content.slice(pos) });
  return out;
};

export function MessageBody({
  msgId,
  chatId,
  content,
  calls,
  thoughts,
  live,
  onRetry,
}: {
  msgId: string;
  chatId: string;
  content: string;
  calls: ToolCall[];
  thoughts: Thought[];
  live: boolean;
  /* reruns a failed call; unset while anything in the chat is generating */
  onRetry?: ((callId: string) => void) | undefined;
}) {
  if (calls.length === 0 && thoughts.length === 0)
    return <Markdown text={content} live={live} msgId={msgId} chatId={chatId} />;
  return segments(content, calls, thoughts).map((seg) =>
    seg.kind === 'text' ? (
      <Markdown
        key={seg.key}
        text={seg.text}
        live={live}
        msgId={msgId}
        chatId={chatId}
      />
    ) : seg.kind === 'thought' ? (
      <ThoughtView
        key={seg.key}
        t={seg.thought}
        live={live && seg.thought.ms === undefined}
      />
    ) : (
      <div
        key={seg.key}
        className="my-1.5 flex flex-col gap-1 whitespace-normal"
      >
        {seg.calls.map((c) =>
          c.name === 'ask_user' && c.status === 'running' ? (
            <QuestionCard key={c.id} msgId={msgId} c={c} />
          ) : callSnapshot(c) ? (
            <ArtifactCard key={c.id} c={c} />
          ) : (
            <ToolCallView key={c.id} c={c} onRetry={onRetry} />
          ),
        )}
      </div>
    ),
  );
}
