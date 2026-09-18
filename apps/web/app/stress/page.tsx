import report from '../../stress-report.json';

export const dynamic = 'force-static';

const STATES = [
  ['VERIFIED', 'Verified'],
  ['PROVISIONAL', 'With caveats'],
  ['STALE', 'Out of date'],
  ['INCOMPLETE', 'Cannot be stated'],
  ['CONFLICT', 'Contradictory'],
  ['UNVERIFIED', 'Never counted'],
] as const;

const SCENARIOS = [
  ['Late receipt', 'Movement happened before the count but was recorded afterwards.'],
  ['Undated movement', 'A quantity changed, but the source supplied no usable occurrence time.'],
  ['Duplicate-looking receipt', 'Two near-identical events stay visible instead of being merged.'],
  ['Clock skew', 'Device time and server time disagree enough to weaken the evidence.'],
  ['Blocked identity', 'A catalogue code is unsafe, so counting against it is refused.'],
  ['No book position', 'A physical count can stand alone without inventing an opening figure.'],
  ['Negative result', 'Arithmetic that implies impossible negative stock becomes a conflict.'],
  ['Never counted', 'Book stock is not quietly promoted to physical truth.'],
] as const;

const fmtMs = (n: number) => n < 1000 ? `${n.toLocaleString()} ms` : `${(n / 1000).toFixed(2)} s`;

export default function StressPage() {
  const stateTotal = Object.values(report.states).reduce((a, b) => a + b, 0);
  const maxReason = Math.max(...report.topReasons.map((x) => x.count), 1);

  if (!report.ready) return <div className="empty-state"><span>NO RUN</span><h1>Stress harness installed.</h1><p>Run the synthetic torture test locally and commit the generated report.</p></div>;

  return (
    <>
      <section className="page-intro stress-intro">
        <div><div className="kicker">Synthetic torture test / measured, not mocked</div><h1>Make the data ugly.<br /><span>Then see if the truth survives.</span></h1><p className="lede">Invented warehouse evidence goes through the real Postgres adapter and the same reconciliation engine as the small demo. The benchmark is useful because the evidence is deliberately awkward, not because the number is big.</p></div>
        <div className="zero-fail"><span>INVARIANT FAILURES</span><strong>{report.invariantFailures.length}</strong><small>{report.invariantFailures.length ? 'investigate immediately' : 'the engine kept its promises'}</small></div>
      </section>

      <section className="stress-hero-grid">
        <div className="stress-hero-main"><span>STOCK LINES</span><strong>{report.itemCount.toLocaleString()}</strong><small>deterministic synthetic catalogue</small></div>
        <div><span>EVIDENCE ROWS</span><strong>{report.evidenceRows.toLocaleString()}</strong><small>{report.bookSnapshots.toLocaleString()} books / {report.countLines.toLocaleString()} counts / {report.movements.toLocaleString()} movements</small></div>
        <div><span>CORE RECONCILE</span><strong>{fmtMs(report.timingsMs.reconcile)}</strong><small>{report.scopesPerSecond.toLocaleString()} scopes/sec on the recording machine</small></div>
        <div><span>ADAPTER LOAD</span><strong>{fmtMs(report.timingsMs.adapterLoad)}</strong><small>hosted Supabase to plain evidence shapes</small></div>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">State distribution</span><h2>Every outcome is represented</h2></div><span className="section-note">A test full of green rows would prove very little.</span></div>
        <div className="distribution stress-distribution">{STATES.map(([state]) => <div key={state} className={`distribution-segment ds-${state}`} style={{ width: `${(report.states[state] / stateTotal) * 100}%` }} title={`${state}: ${report.states[state]}`} />)}</div>
        <div className="stress-state-grid">{STATES.map(([state, label]) => <div key={state}><span className={`stress-state-line ss-${state}`} /><strong>{report.states[state].toLocaleString()}</strong><small>{label}</small></div>)}</div>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Failure modes</span><h2>What was thrown at it</h2></div></div>
        <div className="scenario-grid">{SCENARIOS.map(([name, copy], i) => <article key={name}><span>{String(i + 1).padStart(2, '0')}</span><strong>{name}</strong><p>{copy}</p></article>)}</div>
      </section>

      <section className="two-column section-block stress-bottom">
        <div>
          <div className="section-heading"><div><span className="eyebrow">Most common findings</span><h2>Reason pressure</h2></div></div>
          <div className="reason-bars">{report.topReasons.map((x) => <div key={x.reason}><span className="code">{x.reason}</span><div><i style={{ width: `${(x.count / maxReason) * 100}%` }} /></div><strong>{x.count}</strong></div>)}</div>
        </div>
        <div className="stress-principle">
          <span className="eyebrow">What this actually proves</span>
          <blockquote>“The warehouse is horrible. The engine is not.”</blockquote>
          <p>The useful result is not 100,741 scopes per second. It is that conflict, incomplete and unverified states still withhold quantities under load, while stateable results stay finite.</p>
          <dl><div><dt>Recorded</dt><dd>{new Date(report.generatedAt).toLocaleDateString('en-GB')}</dd></div><div><dt>Path</dt><dd>Local runner to hosted Supabase</dd></div><div><dt>Movements / item</dt><dd>{report.movementsPerItem}</dd></div><div><dt>Invariant failures</dt><dd>{report.invariantFailures.length}</dd></div></dl>
        </div>
      </section>
    </>
  );
}
