/* DecisionPage (/decisions/[slug]) — auth-gated editor for one decision run;
   the slug is a run id, its draft is evaluated with the Run button. */
import { AuthGuard } from '../../components/auth-guard';
import { DecisionEditor } from '../../components/decisions-client';

export default async function DecisionPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Decision — Talkative</title>
        <DecisionEditor />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
