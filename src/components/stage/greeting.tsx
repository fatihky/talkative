/* StageGreeting — home headline; adds a welcome line at zero chats. */
'use client';

import { useChatsStore } from '../../stores';

export function StageGreeting() {
  const zeroChats = useChatsStore(
    (s) => s.items.length === 0 && s.status === 'ready',
  );
  return (
    <div>
      <h1 className="text-[20px] font-semibold leading-[1.35] text-[var(--text)] max-md:text-[18px]">
        What are you building?
      </h1>
      <p className="mt-2 max-w-[460px] text-[13px] leading-[1.55] text-[var(--text-2)]">
        {zeroChats
          ? 'Welcome. Pick a model, grant only the tools this task needs, and send the first message. Tool access is per message and revocable — that is the whole idea.'
          : 'Pick a model, grant only the tools this task needs, and send the first message. Tool access is per message and revocable.'}
      </p>
    </div>
  );
}
