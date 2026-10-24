/* private-use characters the server wraps around each match in a search snippet;
   plain module so both server/search.ts and the client helpers can import it */
export const MARK_START = '\uE000';
export const MARK_END = '\uE001';
