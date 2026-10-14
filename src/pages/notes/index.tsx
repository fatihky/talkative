/* NotesPage (/notes) — auth-gated list of the user's notes. */
import { AuthGuard } from '../../components/auth-guard';
import { NotesClient } from '../../components/notes-client';

export default async function NotesPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Notes — Talkative</title>
        <NotesClient />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
