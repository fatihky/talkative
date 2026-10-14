/*
 * ui/primitives/index.ts — barrel of the app's small presentational
 * atoms (badge dot, icon button, kbd, meter, section label, segmented
 * control, skeleton, switch), one file each.
 *
 * Business logic:
 * - App chrome imports atoms by name from this single path; a new
 *   primitive is a new file plus an export line here.
 */
export { BadgeDot } from './badge-dot';
export { IconButton } from './icon-button';
export { Kbd } from './kbd';
export { Meter } from './meter';
export { SecLabel } from './sec-label';
export { SegmentedControl } from './segmented-control';
export { Skeleton } from './skeleton';
export { Switch } from './switch';
