/* MemoryPage (/settings/memories/[id]) — auth-gated detail view for one
   memory; deep links load the store first, deleting returns to the list. */
import { AuthGuard } from '../../../components/auth-guard';
import { MemoryDetailClient } from '../../../components/memories-client';

export default async function MemoryPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Memory — Talkative</title>
        <MemoryDetailClient />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
