/*
 * stage/index.ts — public surface of the home-stage module family
 * (stage, quick-actions, banner-stack, greeting, hints, dropzone).
 *
 * Business logic:
 * - Stage is the only export consumed outside (home-screen.tsx); the
 *   rest are re-exported as the family's shared helpers, with
 *   addFromFiles as the one upload path behind both the attach button
 *   and the stage's file drops.
 */

export { HomeBannerStack } from './banner-stack';
export { addFromFiles, QuickActions } from './quick-actions';
export { Stage } from './stage';
