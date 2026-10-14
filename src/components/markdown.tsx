/*
 * Markdown — the app's one markdown renderer for both sides of a chat.
 *
 * Business logic:
 * - Wraps Streamdown; `live` picks its streaming mode so unterminated
 *   syntax is closed and animated while a reply streams, and static mode
 *   is used for everything already stored.
 * - Registers the mermaid plugin so ```mermaid fences render as diagrams;
 *   the artifact panel previews mermaid through this same component.
 * - Overrides the `html` and `svg` fences with CodeBlockView via
 *   Streamdown's `renderers` hook (there is no `code-block` component
 *   key), threading msgId/chatId through so those blocks can open a
 *   preview scoped to their own branch.
 * - Every other fence uses Streamdown's default block; typography comes
 *   from the `.md` class, not from here.
 */
'use client';

import { mermaid } from '@streamdown/mermaid';
import { Streamdown } from 'streamdown';
import { CodeBlockView } from './code-block';

/* both sides of the chat are markdown; `live` lets streamdown close unterminated syntax mid-stream */
export function Markdown({
  text,
  live = false,
  msgId,
  chatId,
}: {
  text: string;
  live?: boolean;
  msgId?: string | undefined;
  chatId?: string | undefined;
}) {
  return (
    <Streamdown
      className="md"
      mode={live ? 'streaming' : 'static'}
      isAnimating={live}
      plugins={{
        mermaid,
        /* components has no 'code-block' key; renderers is the override hook */
        renderers: [
          {
            component: (props) => (
              <CodeBlockView {...props} msgId={msgId} chatId={chatId} />
            ),
            language: ['html', 'svg'],
          },
        ],
      }}
    >
      {text}
    </Streamdown>
  );
}
