/* authClient — the browser half of better-auth: signIn/signUp for the auth
   pages, signOut in the topbar, changePassword in password settings, and
   useSession in the shell wrapper. Server code uses src/lib/auth instead. */
'use client';

import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
