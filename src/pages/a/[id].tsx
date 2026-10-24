/*
 * PublicArtifactPage (/a/[id]) — a published artifact, served to anyone.
 *
 * Business logic:
 * - public: no AuthGuard, so a shared link opens without an account.
 *   Signed-out visitors get the bare layout; an owner opening their own
 *   link sees it inside the normal app chrome.
 * - only rows with published = true resolve. Unpublished, deleted, or
 *   unknown ids render the "Artifact not found" panel (a normal 200 page,
 *   not a 404 status) so taking an artifact offline hides it instantly.
 * - keyed on the row's integer id, which is the same id the api takes;
 *   a path that isn't one renders "Artifact not found" without a query.
 * - serves the frozen snapshot stored at publish time (content + version),
 *   never the live chat message — editing the chat leaves the link alone.
 * - when the artifact remembers its source, chatId/leafId/chatTitle ship in
 *   the dto: the viewer links back to that branch (which still needs auth)
 *   and shows the chat title to anyone holding the link.
 * - dynamic render: every request re-reads the db, no caching of the
 *   published/unpublished state.
 */
import { and, eq } from 'drizzle-orm';
import type { PageProps } from 'waku/router';
import { ArtifactViewer } from '../../components/artifact-viewer';
import { getDb } from '../../db';
import { artifacts } from '../../db/schema';
import {
  chatTitles,
  parseArtifactId,
  toArtifactDto,
} from '../../server/artifacts';

export default async function PublicArtifactPage({ id }: PageProps<'/a/[id]'>) {
  const artifactId = parseArtifactId(id);
  const db = getDb();
  const [row] = artifactId
    ? await db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.published, true)))
        .limit(1)
    : [];

  if (!row)
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-[var(--bg)] px-6 text-center text-[var(--text)]">
        <title>Not found — Talkative</title>
        <div className="text-[15px] font-semibold">Artifact not found</div>
        <div className="max-w-[320px] text-[13px] muted">
          This link doesn’t point to a published artifact. It may have been
          unpublished or removed.
        </div>
      </div>
    );

  const titles = row.chatId ? await chatTitles(db, [row.chatId]) : new Map();
  const artifact = toArtifactDto(
    row,
    row.chatId ? titles.get(row.chatId) : undefined,
  );

  return (
    <div className="flex h-dvh flex-col">
      <title>{artifact.title} — Talkative</title>
      <ArtifactViewer artifact={artifact} />
    </div>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
