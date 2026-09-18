import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, openIssues } from '@/lib/queries/read';
import { REASONS, type ReasonDefinition } from '@stocktruth/engine';
import IssuesClient from './IssuesClient';

export const dynamic = 'force-dynamic';

export default async function IssuesPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const userId = await currentUserId();
  const rows = await withUser(userId, async (db) => {
    const site = (await listSites(db))[0];
    if (!site) return [];
    return openIssues(db, site.id, 300);
  });

  const issues = rows.map((issue) => {
    const def = (REASONS as Record<string, ReasonDefinition>)[issue.code];
    return {
      ...issue,
      short: def?.short ?? issue.code,
      action: def?.action ?? 'Inspect the underlying evidence.',
      blocks: def?.blocks === true,
    };
  });

  return (
    <>
      <section className="page-intro slim-intro">
        <div>
          <div className="kicker">Exception console</div>
          <h1>Issues are work.<br /><span>Warnings are context.</span></h1>
          <p className="lede">The engine does not “fix” evidence. It names the problem, withholds a number when necessary, and leaves a human-readable trail of what would settle it.</p>
        </div>
      </section>
      {issues.length ? <IssuesClient issues={issues} initialCode={code} /> : <div className="empty-state"><span>QUEUE CLEAR</span><h2>Nothing is asking for attention.</h2><p>Either everything reconciles or the engine has not run since the latest evidence arrived.</p></div>}
    </>
  );
}
