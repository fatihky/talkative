/*
 * Suggestions — the home screen's starter prompts
 * (GET /api/suggestions, fetched at boot).
 *
 * Business logic:
 * - the list order is fixed: pinned prompts first, then the static
 *   fallback set — the same for every user, with no recent-chat slice.
 * - recent chats are deliberately excluded: their first prompts are the
 *   caller's own past instructions, which don't belong on the "new chat"
 *   home screen; the fixed prompts are enough.
 */
import { PINNED_SUGGESTIONS, STATIC_SUGGESTIONS } from '../lib/mock';
import type { Suggestion } from '../types';

/* pinned + static suggestions for the home screen */
export const buildSuggestions = (): Suggestion[] => [
  ...PINNED_SUGGESTIONS,
  ...STATIC_SUGGESTIONS,
];
