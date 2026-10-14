/* FileDropzoneOverlay — drag overlay; picks message vs chat attach scope. */
'use client';

export function FileDropzoneOverlay({
  count,
  target,
  setTarget,
}: {
  count: number;
  target: 'message' | 'chat';
  setTarget: (t: 'message' | 'chat') => void;
}) {
  return (
    <div
      className="absolute inset-2 z-30 flex flex-col items-center justify-center gap-3 rounded-[8px]"
      style={{
        border: '2px dashed var(--accent)',
        background: 'rgba(47,111,237,.04)',
      }}
      role="dialog"
      aria-label="Drop files to attach"
    >
      <div className="text-[13px] font-medium">
        Drop to attach{count > 0 ? ` ${count} file${count > 1 ? 's' : ''}` : ''}
      </div>
      <fieldset className="flex items-center gap-3 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-[12px]">
        <legend className="sr-only">Attach target</legend>
        {(['message', 'chat'] as const).map((t) => (
          <label key={t} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              checked={target === t}
              onChange={() => setTarget(t)}
              className="accent-[var(--accent)]"
            />
            {t === 'message' ? 'this message' : 'chat context'}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
