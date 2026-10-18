/* drag payload; kept in list state too because HTML5 dragover can't read dataTransfer */
export type Drag = { kind: 'chat' | 'folder'; id: string };
export const DRAG_MIME = 'application/x-talkative';

/* pointer-based drag (touch and pen, where HTML5 drag & drop never fires) */
export type TouchDrag = {
  drag: Drag;
  /* where the finger is now, in viewport px */
  x: number;
  y: number;
  /* the row to move went to the viewport edge and the list is scrolling */
  scroll: -1 | 0 | 1;
  /* translation from the start point to the finger, settled — animates */
  offset: { x: number; y: number };
  /* translation to arrive at the finger now, plus the scale-up — not animated */
  live: { x: number; y: number; k: number };
};

/** a press that moves this far (px) becomes a drag instead of a tap; below it the row clicks or scrolls */
export const DRAG_THRESHOLD = 8;

export const indent = (depth: number) => 10 + depth * 12;
