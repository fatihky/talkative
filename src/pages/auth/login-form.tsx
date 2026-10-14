/*
 * LoginForm (client form behind /auth/login) — email + password sign-in.
 *
 * Business logic:
 * - better-auth resolves with an error object instead of throwing, so the
 *   returned error is inspected and shown; a 403 falls back to "Invalid
 *   email or password", anything else to "Failed to sign in".
 * - success pushes '/' — there is no return-to target, so a visitor bounced
 *   here by AuthGuard always lands on home afterwards.
 * - the submit button is disabled while a request is in flight and the
 *   previous error is cleared at the start of each attempt.
 * - the sign-up link renders only when registrationEnabled is passed in
 *   (first user, or the admin toggle), so a closed instance advertises no
 *   way to register.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'waku';
import { authClient } from '../../lib/auth-client';

export function LoginForm({
  registrationEnabled = true,
}: {
  registrationEnabled?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
      });
      if (signInError) {
        setError(
          signInError.message ??
            (signInError.status === 403
              ? 'Invalid email or password'
              : 'Failed to sign in'),
        );
        return;
      }
      void router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 sm:text-sm"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-zinc-900 dark:text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 sm:text-sm"
            placeholder="••••••••"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Signing in...' : 'Sign in'}
      </button>

      {registrationEnabled && (
        <div className="text-center text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">
            Don't have an account?{' '}
          </span>
          <a
            href="/auth/register"
            className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
          >
            Sign up
          </a>
        </div>
      )}
    </form>
  );
}
