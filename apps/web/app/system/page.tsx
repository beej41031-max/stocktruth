import Link from 'next/link';

export const dynamic = 'force-static';

const layers = [
  ['EXTERNAL SYSTEMS', 'ERP · WMS · SaaS · spreadsheets · flat files'],
  ['ADAPTERS', 'Postgres host · CSV export · JSON/CLI'],
  ['CANONICAL EVIDENCE', 'book claims · repeat counts · movements · production · effective BOMs · watermarks'],
  ['DETERMINISTIC ENGINE', 'chronology · interval closure · material variance · bounded uncertainty · as-of reconstruction'],
  ['DECISION LAYER', 'exact position, bounded range, material variance, next-best verification — always with evidence'],
] as const;

export default function SystemPage() {
  return (
    <>
      <div className="system-kicker">Evidence kernel · reference implementation</div>
      <h1>A total is a conclusion.</h1>
      <p className="system-lede">
        Stock systems usually add movements and print the result. StockTruth first asks whether
        those movements can be ordered, identified and trusted strongly enough for addition to
        mean anything. The web app is one host around a database-free reasoning kernel.
      </p>

      <div className="principle">
        <span>EVENTS</span><b>are claims about change</b>
        <span>OBSERVATIONS</span><b>anchor what was actually seen</b>
        <span>ASSERTIONS</span><b>are conclusions the evidence earns</b>
      </div>

      <h2>Clip-on, not replacement</h2>
      <div className="kernel-flow">
        {layers.map(([name, detail], index) => (
          <div className="kernel-step" key={name}>
            <div className="kernel-no">0{index + 1}</div>
            <div>
              <strong>{name}</strong>
              <p>{detail}</p>
            </div>
          </div>
        ))}
      </div>

      <h2>Three ways into the same brain</h2>
      <div className="proof-grid">
        <article>
          <div className="proof-label">LIVE HOST</div>
          <h3>Postgres adapter</h3>
          <p>
            Supabase/Postgres is the production host. It maps catalogue, counts, movements and
            source health into plain evidence shapes. The engine never sees a table name.
          </p>
        </article>
        <article>
          <div className="proof-label">SECOND ADAPTER</div>
          <h3>CSV export</h3>
          <p>
            Four flat files from a completely different business drive the same reconciler. No
            database, no shared schema, and no fake historical capability: snapshot exports say
            explicitly that they cannot answer an as-known-at query.
          </p>
        </article>
        <article>
          <div className="proof-label">BARE ENGINE</div>
          <h3>JSON / CLI</h3>
          <p>
            One JSON evidence bundle in, one explainable assertion out. No Next.js, Supabase or
            server. This is the smallest demonstration of the boundary around the reasoning.
          </p>
        </article>
      </div>

      <h2>Why movement arithmetic can lie</h2>
      <div className="movement-proof">
        <div><span>11:02</span><strong>+8,400 receipt occurs</strong></div>
        <div><span>12:02</span><strong>27,600 physically counted</strong></div>
        <div className="late"><span>15:02</span><strong>receipt is finally recorded</strong></div>
        <div className="refusal"><span>NOW</span><strong>CANNOT BE STATED</strong></div>
      </div>
      <p className="system-note">
        Adding +8,400 risks double-counting it. Ignoring it risks missing it. The arithmetic is
        easy; the chronology is not. StockTruth refuses the total until the ambiguity is resolved.
      </p>

      <h2>The second count is where value starts</h2>
      <div className="principle">
        <span>COUNT₁ + RECEIPTS − COUNT₂</span><b>reveals actual material use</b>
        <span>OUTPUT × EFFECTIVE BOM</span><b>reveals theoretical material use</b>
        <span>THE GAP × UNIT COST</span><b>turns inventory noise into margin</b>
      </div>
      <p className="system-note">
        A one-off count tells you what was on the shelf. A repeat count closes a measurement
        interval. StockTruth preserves that interval even if somebody later posts a ledger
        adjustment, because correcting today's balance must not erase yesterday's material loss.
      </p>

      <h2>Hard rules</h2>
      <div className="rule-list">
        <p><b>0 ≠ unknown.</b> Null and zero never share a meaning.</p>
        <p><b>Corrections do not erase history.</b> Supersede and reverse; never rewrite the past.</p>
        <p><b>Knowledge is time-bound.</b> Evidence cannot affect an answer before the system knew it.</p>
        <p><b>Blocking states leak no quantity.</b> A refusal cannot quietly smuggle a number through another field.</p>
        <p><b>Same evidence, same policy, same answer.</b> Operational truth stays deterministic; AI is not in the decision path.</p>
      </div>

      <div className="system-cta">
        <div>
          <span className="proof-label">REFERENCE IMPLEMENTATION</span>
          <strong>StockTruth applies the kernel to inventory integrity.</strong>
        </div>
        <div>
          <Link href="/variance">Open material variance</Link>
          <Link href="/stress">Open stress proof</Link>
          <Link href="/">See live evidence</Link>
        </div>
      </div>
    </>
  );
}
