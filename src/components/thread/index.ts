/*
 * thread/index.ts — public surface of the conversation-view family
 * (thread-screen, message-body, tool-call/thought views, cards).
 *
 * Business logic:
 * - Pages import ThreadScreen from here, not the inner file; the
 *   Thread store type is re-exported alongside it so the view and the
 *   shape of the state it renders come from one module.
 */
export type { Thread } from '../../stores';
export { ThreadScreen } from './thread-screen';
