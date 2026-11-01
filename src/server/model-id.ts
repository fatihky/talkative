/*
 * ModelId — the `${connectionId}:${remoteId}` namespacing rule for
 * model ids: catalog.ts mints them per connection, parseModelId
 * splits them back for runs and classification. an id that doesn't
 * parse is a demo catalog model with no backend — runs.ts streams a
 * canned reply for those.
 *
 * Chats saved while user-added models carried a `custom:` prefix still
 * hold those ids (percent-encoded or not); they address the same
 * (connection, remoteId) pair, so parseModelId maps them onto it.
 */
export const parseModelId = (
  id: string,
): { connectionId: number; remoteId: string } | null => {
  const direct = /^(\d+):(.+)$/.exec(id);
  if (direct?.[1] !== undefined && direct[2] !== undefined)
    return { connectionId: Number(direct[1]), remoteId: direct[2] };
  let s = id;
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep the raw form: a literal `%` is not encoding */
    }
  }
  const legacy = /^custom:(\d+):(.+)$/.exec(s);
  if (legacy?.[1] !== undefined && legacy[2] !== undefined)
    return { connectionId: Number(legacy[1]), remoteId: legacy[2] };
  return null;
};
