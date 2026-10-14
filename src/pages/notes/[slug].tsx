/* NotePage (/notes/[slug]) — auth-gated editor for one note; the slug is a
   note id and edits are debounced, flushed on leaving. */
import { AuthGuard } from '../../components/auth-guard';
import { NoteEditor } from '../../components/notes-client';

export default async function NotePage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Note — Talkative</title>
        <NoteEditor />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
