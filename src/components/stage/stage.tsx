/*
 * Stage — the home screen above the composer: greeting, suggestion chips,
 * quick actions, recent models, hints, banners, and file dropping.
 *
 * Business logic:
 * - S1 cold boot: the stage stays hidden until the model catalog resolves
 *   (capped at 800ms), showing a "warming up" skeleton that notes when
 *   the catalog errored.
 * - The whole column is a file drop zone; a drag-depth counter keeps child
 *   enter/leave events from flickering the overlay, and only drags
 *   carrying Files are accepted.
 * - The overlay picks the attach scope (this message vs chat context);
 *   the drop uploads through addFromFiles with that scope.
 * - QuickActions render icon-only below 768px.
 * - Banners pin under the scrollable main area; a "model: loading…" note
 *   shows while the catalog loads with nothing selected.
 */
'use client';

import { useRef, useState } from 'react';
import {
  useLayoutStore,
  useModelsStore,
  useSelectedModel,
  useUIStore,
} from '../../stores';
import type { Banner } from '../../types';
import { Skeleton } from '../../ui/primitives';
import { HomeBannerStack } from './banner-stack';
import { FileDropzoneOverlay } from './dropzone-overlay';
import { StageGreeting } from './greeting';
import { RecentModelsRow, StageHint } from './hints';
import { addFromFiles, QuickActions } from './quick-actions';
import { SuggestionChips } from './suggestion-chips';

export function Stage({ banners }: { banners: Banner[] }) {
  const stageVisible = useUIStore((s) => s.stageVisible);
  const modelStatus = useModelsStore((s) => s.status);
  const selected = useSelectedModel();
  const vw = useLayoutStore((s) => s.vw);
  const [dropTarget, setDropTarget] = useState<'message' | 'chat'>('message');
  const [dragState, setDragState] = useState<{
    active: boolean;
    count: number;
  }>({ active: false, count: 0 });
  const dragDepth = useRef(0);

  /* window-level drag detection so drops on the whole stage column work */
  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current += 1;
    setDragState((d) => ({
      ...d,
      active: true,
      count: e.dataTransfer.files.length,
    }));
  };
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragState({ active: false, count: 0 });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragState({ active: false, count: 0 });
    if (e.dataTransfer.files.length > 0)
      addFromFiles(e.dataTransfer.files, dropTarget);
  };

  if (!stageVisible) {
    /* S1 — stage stays hidden; composer shows loading model state underneath */
    return (
      <div className="flex-1 px-4 pt-[min(18vh,140px)] pb-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
          <div
            className="flex items-center gap-2 text-[12px] muted"
            role="status"
            aria-live="polite"
          >
            <span className="block size-3.5 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent" />
            Warming up the workbench
            {modelStatus === 'error' ? ' — catalog unavailable' : ''}…
          </div>
          <Skeleton w="55%" h={20} r={6} />
          <Skeleton w="72%" h={13} r={4} />
          <div className="mt-2 flex gap-2">
            <Skeleton w={130} h={32} r={6} />
            <Skeleton w={150} h={32} r={6} />
            <Skeleton w={120} h={32} r={6} />
          </div>
        </div>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file drop zone
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pt-[min(18vh,140px)] pb-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[640px] flex-col">
          <StageGreeting />
          <SuggestionChips />
          <QuickActions iconOnly={vw < 768} />
          <RecentModelsRow />
          <StageHint />
          {modelStatus === 'loading' && !selected && (
            <div className="mt-8 text-[12px] muted" role="status">
              model: loading…
            </div>
          )}
        </div>
      </main>
      <HomeBannerStack items={banners} />
      {dragState.active && (
        <FileDropzoneOverlay
          count={dragState.count}
          target={dropTarget}
          setTarget={setDropTarget}
        />
      )}
    </div>
  );
}
