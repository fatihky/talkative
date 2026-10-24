/* SearchPage (/search) — auth-gated full-text search across the user's messages. */
import { AuthGuard } from '../components/auth-guard';
import { SearchClient } from '../components/search-client';

export default async function SearchPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Search — Talkative</title>
        <SearchClient />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
