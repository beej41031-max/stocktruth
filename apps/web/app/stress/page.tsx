import report from '../../stress-report.json';

export const dynamic = 'force-static';

const STATES = [
  ['VERIFIED', 'verified'],
  ['PROVISIONAL', 'with caveats'],
  ['STALE', 'out of date'],
  ['INCOMPLETE', 'cannot be stated'],
  ['CONFLICT', 'contradictory'],
  ['UNVERIFIED', 'never counted'],
] as const;

const ms = (n: number) =>
  n < 1000 ? `${n.toLocaleString()} ms` : `${(n / 1000).toFixed(2)} s`;

export default function StressTest() {
  const topReasons = report.topReasons as { reason: string; count: number }[];

  if (!report.ready) {
    return (
      <>
        <h1>Synthetic stress test</h1>
        <p className="sub">
          The harness is installed, but no benchmark has been recorded yet. Run the stress
          command locally against the demo database and commit the generated report.
        </p>
        <div className="reason medium">
          <div className="what">
            <span className="code">npm run stress -- --items=10000 --movements=8</span>
          </div>
          <div className="do">
            Random rows would be easy. The harness generates awkward chronology and evidence
            defects on purpose.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Synthetic stress test</h1>
      <p className="sub">
        Invented warehouse data, deliberately unpleasant. This run goes through the real
        Postgres adapter and the same reconciliation engine as the small demo. No mocked
        conclusions.
      </p>

      <div className="headline">
        <div className="figure">{report.itemCount.toLocaleString()}</div>
        <p className="caption">
          stock lines reconciled from <strong>{report.evidenceRows.toLocaleString()}</strong>{' '}
          evidence rows. The point is not a heroic benchmark number. It is making sure the
          engine keeps refusing bad answers when the data stops being polite.
        </p>
      </div>

      <div className="states">
        {STATES.map(([state, label]) => (
          <div className="state" key={state}>
            <div className={`n st-${state}`}>
              {report.states[state].toLocaleString()}
            </div>
            <div className="l">{label}</div>
          </div>
        ))}
      </div>

      {report.states.VERIFIED === 0 && (
        <div className="banner">
          VERIFIED reads as zero on this run, and that is worth explaining rather than leaving as
          a number that looks suspicious. This generator always seeds a handful of receipts with
          no matching item, and the moment one exists anywhere at a site, every position at that
          site carries a caveat, by design, per{' '}
          <span className="code">docs/decisions/0007-unlinked-movements.md</span>. Even setting
          that one caveat aside, only <strong>{report.wouldBeVerifiedButForSiteWideCaveat}</strong>{' '}
          of {report.itemCount.toLocaleString()} scopes would have been clean enough to fully
          verify. The rest carry their own reasons on top: a missing book figure, a stale count,
          a movement that cannot be dated. A pristine result here would mean the generator was not
          actually adversarial.
        </div>
      )}

      <h2>Run</h2>
      <table>
        <tbody>
          <tr>
            <td>Evidence loaded</td>
            <td className="num">{report.evidenceRows.toLocaleString()}</td>
            <td className="dim">
              {report.bookSnapshots.toLocaleString()} book snapshots ·{' '}
              {report.countLines.toLocaleString()} counts ·{' '}
              {report.movements.toLocaleString()} movements
            </td>
          </tr>
          <tr>
            <td>Postgres adapter load</td>
            <td className="num">{ms(report.timingsMs.adapterLoad)}</td>
            <td className="dim">Hosted Supabase → plain evidence shapes</td>
          </tr>
          <tr>
            <td>Core reconciliation</td>
            <td className="num">{ms(report.timingsMs.reconcile)}</td>
            <td className="dim">
              {report.scopesPerSecond.toLocaleString()} item/location scopes per second on
              the machine that recorded this run
            </td>
          </tr>
          <tr>
            <td>Invariant failures</td>
            <td className={`num ${report.invariantFailures.length ? 'st-CONFLICT' : 'st-VERIFIED'}`}>
              {report.invariantFailures.length}
            </td>
            <td className="dim">
              A refused state may not leak a quantity. A stated position must be finite.
            </td>
          </tr>
          <tr>
            <td>Recorded</td>
            <td className="num">{new Date(report.generatedAt).toLocaleDateString('en-GB')}</td>
            <td className="dim">{report.label}</td>
          </tr>
        </tbody>
      </table>

      <h2>What I threw at it</h2>
      <p className="sub">
        Clean counts sit alongside stale counts, late-entered receipts crossing a count,
        undated movements, duplicate-looking receipts, clock skew, blocked catalogue
        identities, missing book positions, impossible negative stock and items that have
        never been counted. The mix is deterministic, so a later engine version gets the
        same bad day at the warehouse.
      </p>

      <table>
        <thead>
          <tr>
            <th>Reason</th>
            <th className="num">Scopes</th>
          </tr>
        </thead>
        <tbody>
          {topReasons.map((x) => (
            <tr key={x.reason}>
              <td className="code">{x.reason}</td>
              <td className="num">{x.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
