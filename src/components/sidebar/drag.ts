/* drag payload; kept in list state too because dragover can't read dataTransfer */
export type Drag = { kind: 'chat' | 'folder'; id: string };
export const DRAG_MIME = 'application/x-talkative';

export const indent = (depth: number) => 10 + depth * 12;
