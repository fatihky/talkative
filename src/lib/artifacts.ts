/*
 * artifacts — the shared artifact model: kinds, size cap, snapshot parsing
 * and branch collection, used by the tool (server) and the panel (client).
 *
 * Business logic:
 * - Artifacts have no table of their own: every successful `artifact` tool
 *   call stores the whole resulting version in its `raw`, so the artifacts
 *   on screen are simply the ones written along the branch being viewed.
 *   Publishing is the exception — it copies a snapshot into its own row.
 * - ARTIFACT_KINDS is the closed set both the tool and parseSnapshot
 *   accept; ARTIFACT_MAX (80k chars) is the cap the tool enforces, because
 *   a call's `raw` is truncated at RAW_MAX (200k) and json escaping can
 *   double the size.
 * - parseSnapshot checks every field it needs and returns null instead of
 *   throwing, so a truncated or foreign `raw` simply isn't an artifact.
 * - callSnapshot only reads calls named `artifact` with status `done`:
 *   failed, running, view-only and other tools' calls yield no version.
 * - collectArtifacts walks a root-to-leaf path and groups snapshots by id,
 *   re-inserting each id so map order tracks the most recently changed
 *   artifact; versions are then sorted by number because parallel calls
 *   settle out of array order while the tool numbers them as it applies
 *   them.
 * - artifactFilename/artifactMime back the panel's download: non-code kinds
 *   take their own extension (markdown → .md), code maps the fence language
 *   through EXT, falling back to .txt and special-casing a bare
 *   "Dockerfile".
 */
import type { ToolCall } from '../types';

export const ARTIFACT_KINDS = [
  'code',
  'markdown',
  'html',
  'svg',
  'mermaid',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/* raw is capped at RAW_MAX (200k) and json escaping can double the size */
export const ARTIFACT_MAX = 80_000;

/** one version of an artifact, exactly as stored in the call's `raw` */
export type ArtifactSnapshot = {
  id: string;
  title: string;
  kind: ArtifactKind;
  /* code only: the fence language, e.g. "tsx" */
  language?: string | undefined;
  content: string;
  /* 1-based, counted along the branch */
  version: number;
};

export type ArtifactVersion = ArtifactSnapshot & {
  messageId: string;
  callId: string;
};

export type Artifact = {
  id: string;
  /* oldest first; the last one is current */
  versions: ArtifactVersion[];
};

export const parseSnapshot = (raw: string | undefined) => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ArtifactSnapshot>;
    if (
      typeof v.id !== 'string' ||
      typeof v.title !== 'string' ||
      typeof v.content !== 'string' ||
      typeof v.version !== 'number' ||
      !ARTIFACT_KINDS.includes(v.kind as ArtifactKind)
    )
      return null;
    return v as ArtifactSnapshot;
  } catch {
    return null;
  }
};

/** the version a call produced; null for failed, running, view-only or foreign calls */
export const callSnapshot = (c: ToolCall) =>
  c.name === 'artifact' && c.status === 'done' ? parseSnapshot(c.raw) : null;

/** every artifact written along `path`, most recently changed last */
export const collectArtifacts = (
  path: readonly { id: string; toolCalls?: ToolCall[] | undefined }[],
): Artifact[] => {
  const byId = new Map<string, ArtifactVersion[]>();
  for (const m of path)
    for (const c of m.toolCalls ?? []) {
      const s = callSnapshot(c);
      if (!s) continue;
      /* re-insert so map order tracks the latest change */
      const list = byId.get(s.id) ?? [];
      byId.delete(s.id);
      byId.set(s.id, [...list, { ...s, messageId: m.id, callId: c.id }]);
    }
  return [...byId].map(([id, versions]) => ({
    id,
    /* parallel calls settle out of array order; the tool numbers them as it applies them */
    versions: versions.sort((a, b) => a.version - b.version),
  }));
};

const EXT: Record<string, string> = {
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  ruby: 'rb',
  rust: 'rs',
  go: 'go',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  'c#': 'cs',
  php: 'php',
  shell: 'sh',
  bash: 'sh',
  sh: 'sh',
  zsh: 'sh',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  dockerfile: 'Dockerfile',
};

export const artifactFilename = (s: ArtifactSnapshot) => {
  if (s.kind !== 'code')
    return `${s.id}.${s.kind === 'markdown' ? 'md' : s.kind}`;
  const ext = EXT[(s.language ?? '').toLowerCase()] ?? 'txt';
  return ext === 'Dockerfile' ? ext : `${s.id}.${ext}`;
};

export const artifactMime = (s: ArtifactSnapshot) =>
  s.kind === 'html'
    ? 'text/html'
    : s.kind === 'svg'
      ? 'image/svg+xml'
      : s.kind === 'mermaid'
        ? 'text/plain'
        : s.kind === 'markdown'
          ? 'text/markdown'
          : 'text/plain';
