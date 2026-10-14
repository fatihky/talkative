/*
 * tools/get-current-timestamp — the model's clock, so it never guesses the
 * current date or time.
 *
 * Business logic:
 * - returns one JSON object: epoch seconds, the UTC ISO string, a
 *   local-time ISO string with its UTC offset, and the resolved IANA zone
 *   name.
 * - the optional timezone arg picks the local zone; without it the server's
 *   own TZ (via Intl) is used, falling back to 'UTC' — the user's device
 *   zone is not known here despite the description's wording.
 * - the local string is assembled from Intl formatToParts (en-CA for the
 *   ISO-like layout) and the zone's GMT offset normalized to ±HH:MM; any
 *   Intl failure (e.g. a bogus zone name) degrades user_local_iso to the
 *   UTC string instead of erroring.
 * - pure read: keyless 'default' backend, always available when granted (on
 *   by default), no side effects.
 */
import type { ServerTool } from './index';

export const getCurrentTimestamp: ServerTool = {
  id: 'get_current_timestamp',
  description:
    "Returns the current UTC timestamp, ISO 8601 strings in UTC and the user's local timezone, " +
    "and the user's IANA timezone name. Use this instead of guessing the current time.",
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          "optional IANA timezone for user_local_iso; defaults to the server's TZ or UTC",
      },
    },
    required: [],
  },
  backends: () => [{ id: 'default' }],
  async run(args) {
    const now = new Date();
    const ts = Math.floor(now.getTime() / 1000);
    const utcIso = now.toISOString();

    const tz =
      typeof args.timezone === 'string' && args.timezone.trim()
        ? args.timezone.trim()
        : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    let localIso: string;
    try {
      localIso = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
      })
        .formatToParts(now)
        .reduce((acc, p) => {
          switch (p.type) {
            case 'year':
              return acc.replace('YYYY', p.value);
            case 'month':
              return acc.replace('MM', p.value);
            case 'day':
              return acc.replace('DD', p.value);
            case 'hour':
              return acc.replace('HH', p.value);
            case 'minute':
              return acc.replace('mm', p.value);
            case 'second':
              return acc.replace('ss', p.value);
            case 'fractionalSecond':
              return acc.replace('ffffff', p.value.padEnd(6, '0').slice(0, 6));
            default:
              return acc;
          }
        }, 'YYYY-MM-DDTHH:mm:ss.ffffff');

      /* compute offset string for the chosen timezone */
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'longOffset',
      }).formatToParts(now);
      const offsetPart = parts.find((p) => p.type === 'timeZoneName');
      const offsetStr = offsetPart?.value?.replace('GMT', '') || '+00:00';
      const normalizedOffset =
        offsetStr === '' || offsetStr === 'GMT'
          ? '+00:00'
          : offsetStr.includes(':')
            ? offsetStr
            : `${offsetStr}:00`;
      localIso = `${localIso}${normalizedOffset}`;
    } catch {
      localIso = utcIso;
    }

    return JSON.stringify({
      current_timestamp: ts,
      current_iso: utcIso,
      user_local_iso: localIso,
      user_timezone: tz,
    });
  },
};
