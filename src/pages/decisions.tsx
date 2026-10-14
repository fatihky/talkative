/* DecisionsPage (/decisions) — auth-gated list of the user's decision runs. */
import { AuthGuard } from '../components/auth-guard';
import { DecisionsClient } from '../components/decisions-client';

export default async function DecisionsPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Decisions — Talkative</title>
        <DecisionsClient />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
