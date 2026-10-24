/*
 * export-chat — the "Export as text" download of the branch on screen.
 *
 * Business logic:
 * - Client-only; the thread header's actions menu drives it through the
 *   threads store (pathToLeaf → chatToText → downloadText).
 * - Only the visible branch is exported: pathToLeaf walks parentId up from
 *   the leaf and reverses, so sibling branches never appear. The walk is
 *   bounded by messages.length in case a cycle sneaks in.
 * - ExportableMessage is the field subset both the server Message DTO and
 *   the client-only Msg satisfy, so either can be handed over.
 * - Thinking and tool steps are interleaved back into the reply at the
 *   character offsets recorded while streaming (segments), mirroring the
 *   thread: a thought becomes `<thinking (1.2s)>…</thinking>`, and a step's
 *   calls become `[Tool: name]` — `[failed]` when it errored — with the
 *   pretty-printed arguments indented underneath.
 * - Anchor offsets are clamped into the content and only ever move forward,
 *   so out-of-order or out-of-range steps can't overlap or slice backwards.
 * - Each turn renders as `## You` or `## Assistant (model)` with the
 *   `<connectionId>:` prefix stripped from the model id, then refusal,
 *   attachments and (assistant only) cited sources; turns are joined with
 *   `---` under a header carrying model, created/exported times and the
 *   message count.
 * - exportFilename slugs the title keeping unicode letters and digits and
 *   falls back to `chat.txt`; downloadText clicks a temporary anchor and
 *   revokes the object URL straight after.
 */
import type {
  Attachment,
  Message,
  Thought,
  ToolCall,
  UrlCitation,
} from '../types';

/* fields the exporter needs; both Message and the client-only Msg satisfy this */
export type ExportableMessage = Pick<
  Message,
  | 'id'
  | 'parentId'
  | 'role'
  | 'content'
  | 'attachments'
  | 'modelId'
  | 'toolCalls'
  | 'thoughts'
  | 'refusal'
  | 'annotations'
  | 'usage'
  | 'latencyMs'
  | 'createdAt'
>;

export type ExportChat = {
  title: string;
  modelId?: string | undefined;
  createdAt?: number | undefined;
};

/** root-to-leaf path, so only the branch on screen is exported */
export function pathToLeaf<T extends { id: string; parentId: string | null }>(
  messages: T[],
  leafId: string | null,
): T[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const out: T[] = [];
  for (
    let m = leafId ? byId.get(leafId) : undefined;
    m && out.length < messages.length;
    m = m.parentId ? byId.get(m.parentId) : undefined
  )
    out.push(m);
  return out.reverse();
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const prettyArgs = (raw: string) => {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
  } catch {
    return raw;
  }
};

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; thought: Thought }
  | { kind: 'tools'; calls: ToolCall[] };

/* split the reply at each step, mirroring the thread's inline thinking and tool blocks */
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
      anchors.push({ at: thought.at, seg: { kind: 'thought', thought } });
    const group = calls.filter((c) => c.step === step);
    if (group[0])
      anchors.push({ at: group[0].at, seg: { kind: 'tools', calls: group } });
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const { at: want, seg } of anchors) {
    const at = Math.min(Math.max(pos, want), content.length);
    if (at > pos) out.push({ kind: 'text', text: content.slice(pos, at) });
    out.push(seg);
    pos = at;
  }
  if (pos < content.length)
    out.push({ kind: 'text', text: content.slice(pos) });
  return out;
};

const renderAttachments = (attachments: Attachment[]) =>
  attachments.map((a) => `- ${a.name}${a.url ? ` (${a.url})` : ''}`).join('\n');

/* brief one-line note per call; the arguments are what matter in the transcript */
const renderTools = (calls: ToolCall[]) =>
  calls
    .map((c) => {
      const args = prettyArgs(c.args)
        .split('\n')
        .map((line) => `     ${line}`)
        .join('\n');
      const status = c.status === 'error' ? ' [failed]' : '';
      return `[Tool: ${c.name}]${status}\n${args}`;
    })
    .join('\n\n');

const renderMessage = (m: ExportableMessage): string => {
  const who =
    m.role === 'user'
      ? 'You'
      : `Assistant${m.modelId ? ` (${m.modelId.replace(/^\d+:/, '')})` : ''}`;
  const out: string[] = [`## ${who}`];

  const calls = m.toolCalls ?? [];
  const thoughts = m.thoughts ?? [];
  if (m.role === 'assistant' && (calls.length > 0 || thoughts.length > 0)) {
    for (const seg of segments(m.content, calls, thoughts)) {
      if (seg.kind === 'text') {
        if (seg.text.trim()) out.push(seg.text.trim());
      } else if (seg.kind === 'thought') {
        const dur =
          seg.thought.ms !== undefined
            ? ` (${(seg.thought.ms / 1000).toFixed(1)}s)`
            : '';
        out.push(
          [`<thinking${dur}>`, seg.thought.text.trim(), '</thinking>'].join(
            '\n',
          ),
        );
      } else {
        out.push(renderTools(seg.calls));
      }
    }
  } else if (m.content.trim()) {
    out.push(m.content.trim());
  }

  if (m.refusal) {
    out.push('[Refusal]');
    out.push(m.refusal.trim());
  }
  if (m.attachments.length > 0) {
    out.push('Attachments:');
    out.push(renderAttachments(m.attachments));
  }
  if (m.role === 'assistant' && m.annotations && m.annotations.length > 0) {
    out.push('Sources:');
    out.push(
      m.annotations
        .map(
          (a: UrlCitation) =>
            `- ${a.title || a.url}${a.title ? ` — ${a.url}` : ''}`,
        )
        .join('\n'),
    );
  }
  return out.join('\n\n');
};

/** the whole conversation as plain text, thinking and tool steps included */
export function chatToText(
  chat: ExportChat,
  messages: ExportableMessage[],
): string {
  const header = [
    chat.title || 'Chat',
    '='.repeat(48),
    '',
    `Model: ${chat.modelId ?? 'unknown'}`,
    `Created: ${fmtDate(chat.createdAt ?? messages[0]?.createdAt ?? Date.now())}`,
    `Exported: ${fmtDate(Date.now())}`,
    `Messages: ${messages.length}`,
    '',
    '='.repeat(48),
    '',
  ].join('\n');
  return `${header}${messages.map(renderMessage).join('\n\n---\n\n')}\n`;
}

/** filename-safe slug derived from the chat title */
export function exportFilename(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'chat'}.txt`;
}

/** triggers a browser download of `text` as `filename` */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
