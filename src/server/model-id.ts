/*
 * ModelId — the `${connectionId}:${remoteId}` namespacing rule for
 * model ids: catalog.ts mints them per connection, parseModelId
 * splits them back for runs and classification. an id that doesn't
 * parse is a demo catalog model with no backend — runs.ts streams a
 * canned reply for those.
 */
export const parseModelId = (id: string) => {
  const [, conn, remoteId] = /^(\d+):(.+)$/.exec(id) ?? [];
  return conn && remoteId ? { connectionId: Number(conn), remoteId } : null;
};
