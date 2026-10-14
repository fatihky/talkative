/*
 * global.d.ts — ambient module declarations for non-TS imports.
 *
 * Business logic:
 * - Tells TypeScript that `import '…*.css'` (e.g. styles.css in
 *   pages/_layout.tsx) is a valid side-effect module: Vite bundles the
 *   stylesheet and there are no typed exports to check.
 */
declare module '*.css';
