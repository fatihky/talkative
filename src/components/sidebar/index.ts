/*
 * sidebar/index.ts — public surface of the sidebar module family
 * (sidebar, chat-list/row, folder-row, move-menu, drag, touch-drag).
 *
 * Business logic:
 * - Shell imports Sidebar from here only; the rows navigate with Waku
 *   `Link`s, so chats and folders are real anchors that a modified or
 *   middle click can open in a new tab.
 */
export { Sidebar } from './sidebar';
