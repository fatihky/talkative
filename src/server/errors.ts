/*
 * errors — the app's shared server-side error vocabulary.
 *
 * Business logic:
 * - ValidationError is thrown by input parsers across the server modules
 *   (users, settings, user-prefs, tool-credentials, tool-preferences,
 *   chats, folders, artifacts, …) and the API routes to signal bad request
 *   data.
 * - The `handle` wrapper in providers.ts is the single place that turns it
 *   into a 400 JSON response, separating "the client sent nonsense" from
 *   an unexpected 500; the message becomes the response body verbatim.
 * - Kept deliberately minimal — a plain Error subclass with no fields — so
 *   parsers can throw it inline and only the route layer decides status.
 */
export class ValidationError extends Error {}
