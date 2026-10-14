/*
 * Suggestions — the home screen's starter prompts
 * (GET /api/suggestions, fetched at boot).
 *
 * Business logic:
 * - the list order is fixed: pinned prompts first, then up to 3 of
 *   the user's most recently updated chats (queried by the route),
 *   then the static fallback set, capped at 8 overall.
 * - pinned (2) + static (5) already fill 7 slots, so the cap trims
 *   the static tail once recent chats arrive — pinned and recent are
 *   never cut, and a brand-new user still gets a full grid.
 * - a recent chat becomes a suggestion with its title as the label
 *   (cut to 26 chars with an ellipsis) and its firstPrompt as the
 *   prompt to resend, falling back to the title when no first
 *   message is stored.
 * - recent ids are namespaced `s-r-<chatId>` so they're stable
 *   across fetches; the pinned and static sets come from lib/mock
 *   and are the same for everyone — only the recent slice is
 *   user-scoped.
 */
import { PINNED_SUGGESTIONS, STATIC_SUGGESTIONS } from '../lib/mock';
import type { Suggestion } from '../types';

/* pinned + a user's recent chats + the static fallback set, capped for the home screen */
export const buildSuggestions = (
  chats: { id: string; title: string; firstPrompt: string }[],
): Suggestion[] => {
  const recent = chats.slice(0, 3).map(
    (c): Suggestion => ({
      id: `s-r-${c.id}`,
      label: c.title.length > 26 ? `${c.title.slice(0, 26)}…` : c.title,
      prompt: c.firstPrompt || c.title,
      source: 'recent',
    }),
  );
  return [...PINNED_SUGGESTIONS, ...recent, ...STATIC_SUGGESTIONS].slice(0, 8);
};
