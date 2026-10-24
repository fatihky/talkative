/*
 * crypto-polyfill — a v4 randomUUID for insecure origins.
 *
 * Business logic:
 * - crypto.randomUUID is unavailable on insecure origins (plain-http LAN),
 *   while crypto.getRandomValues still works there.
 * - Patches a v4 generator (16 random bytes with the version and variant
 *   bits set) before any dependency — better-auth, mermaid, … — reaches for
 *   it, which is why src/waku.client.tsx imports this module as its very
 *   first statement.
 * - Only acts when crypto exists and randomUUID is missing, so a compliant
 *   browser keeps its native implementation; the property is defined
 *   writable and configurable so it can still be replaced.
 * - storage.ts uuid() builds its own v4 from getRandomValues for the same
 *   reason and does not depend on this patch.
 */
if (
  typeof globalThis.crypto !== 'undefined' &&
  typeof globalThis.crypto.randomUUID !== 'function'
) {
  const randomUUID = (): string => {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: randomUUID,
    configurable: true,
    writable: true,
  });
}
