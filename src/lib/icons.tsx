/*
 * I — icon registry: one path map plus the single component that draws it.
 *
 * Business logic:
 * - Every glyph is a hand-inlined 24x24 stroke path in `P`, so the UI ships
 *   no icon dependency and all screens share one visual vocabulary.
 * - Icons are referenced by string name (`n`), letting data carry an icon
 *   (nav entries, a dialog's `icon`) without importing a component.
 * - An unknown name falls back to `info` instead of throwing, so a stale or
 *   misspelled icon degrades to a visible glyph, not an empty control.
 * - `s` sets the box in px and `w` the stroke weight; remaining svg props
 *   pass through, so callers tint or reposition without new variants.
 * - Always aria-hidden by contract: the enclosing control owns the label
 *   (IconButton uses its tip, Meter and SegmentedControl set their own).
 * - Grows one entry per feature (copy, wrench, brain, pin …); add glyphs
 *   here rather than pulling a per-icon component into a call site.
 */
import type { SVGProps } from 'react';

/** stroke-based 1.5px icons, sized via `s` */
const P = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  'panel-left': 'M4 5h16v14H4zM10 5v14',
  'panel-right': 'M4 5h16v14H4zM14 5v14',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.2 2.9c-.7.3-1 .9-1 1.6v.5M12 17.5h.01',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a8.5 8.5 0 0 0 10.5 10.5z',
  monitor: 'M4 5h16v11H4zM9 20h6M12 16v4',
  sliders:
    'M4 7h10M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4M16 5v4M8 10v4M14 15v4',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  paperclip:
    'M20 11.5l-8.3 8.3a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5',
  brain:
    'M12 4a4 4 0 0 0-4 4c-1.2.5-2 1.7-2 3 0 1.4.9 2.6 2 3.1V17a3 3 0 0 0 3 3h1zM12 4a4 4 0 0 1 4 4c1.2.5 2 1.7 2 3 0 1.4-.9 2.6-2 3.1V17a3 3 0 0 1-3 3h-1zM12 4v19',
  wrench:
    'M14.5 6.5a4 4 0 0 0-5.2 5.2L4 17l3 3 5.3-5.3a4 4 0 0 0 5.2-5.2l-2.7 2.7-2.3-2.3z',
  send: 'M5 12l14-7-4 7 4 7z',
  'chevron-down':
    'M4.29289 8.29289C4.68342 7.90237 5.31658 7.90237 5.70711 8.29289L12 14.5858L18.2929 8.29289C18.6834 7.90237 19.3166 7.90237 19.7071 8.29289C20.0976 8.68342 20.0976 9.31658 19.7071 9.70711L12.7071 16.7071C12.3166 17.0976 11.6834 17.0976 11.2929 16.7071L4.29289 9.70711C3.90237 9.31658 3.90237 8.68342 4.29289 8.29289Z',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  pencil: 'M15 5l4 4L8 20H4v-4zM13 7l4 4',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  chat: 'M4 5h16v11H9l-5 4z',
  note: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  folder: 'M3 6h6l2 2h10v11H3z',
  'folder-plus': 'M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M12 11v5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  alert: 'M12 3l10 18H2zM12 10v5M12 18.5h.01',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  image: 'M4 5h16v14H4zM8 11a1.5 1.5 0 1 0 0 .01M20 15l-6-5-8 8',
  link: 'M10 14a4 4 0 0 1 0-5.7l2-2a4 4 0 0 1 5.7 5.7l-1 1M14 10a4 4 0 0 1 0 5.7l-2 2A4 4 0 0 1 6.3 12l1-1',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 9h17M3.5 15h17M12 3c2.3 2.6 2.3 15.4 0 18M12 3c-2.3 2.6-2.3 15.4 0 18',
  lock: 'M6 10h12v10H6zM8.5 10V7a3.5 3.5 0 0 1 7 0v3M12 14v2',
  branch:
    'M7 5a2 2 0 1 0 0 .01M7 7v10M7 17a2 2 0 1 0 .01 0M17 7a2 2 0 1 0 .01 0M17 9v2a3 3 0 0 1-3 3H7',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  trash: 'M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14',
  'arrow-up': 'M12 20V5M6 11l6-6 6 6',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  stop: 'M7 7h10v10H7z',
  check: 'M5 13l4 4L19 7',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  wifi: 'M3 9a14 14 0 0 1 18 0M6.5 12.5a9 9 0 0 1 11 0M10 16a4 4 0 0 1 4 0M12 19.5h.01',
  play: 'M5 3l14 9-14 9V3z',
  retry: 'M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  'rotate-cw': 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c1.5-3 4.5-4.5 8-4.5S18.5 17 20 20',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zM15.5 7.5l3 3L22 7l-3-3',
  maximize: 'M4 14v6h6M20 10V4h-6M14 10l7-7M10 14l-7 7',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7',
  pin: 'M12 17v5M5 17h14l-1.5-4.5V7a2.5 2.5 0 0 0-2.5-2.5H9A2.5 2.5 0 0 0 6.5 7v5.5z',
  decision:
    'M12 3.4a1.9 1.9 0 1 0 0 .01M12 5.3V10M12 10L7.4 14.1M12 10l4.6 4.1M7.4 14.2a1.9 1.9 0 1 0 0 .01M16.6 14.2a1.9 1.9 0 1 0 0 .01M7.4 16.1V21M16.6 16.1V21',
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5',
  /* the handoff's assistant avatar: a speech bubble with a tail */
  bot: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  /* the handoff's model-picker glyph (a "head with a thought" mark) */
  model: 'M12 3a9 9 0 1 0 9 9M12 3v4M12 7a2 2 0 0 1 2 2',
  /* eye (vision capability badge) */
  vision:
    'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
};

export function I({
  n,
  s = 14,
  w = 1.6,
  ...rest
}: {
  n: string;
  s?: number;
  w?: number;
} & SVGProps<SVGSVGElement>) {
  const d = P[n as keyof typeof P] ?? P.info;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}
