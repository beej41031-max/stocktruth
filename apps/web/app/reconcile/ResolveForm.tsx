'use client';

import { useState, useTransition } from 'react';
import { resolveIssue } from '../count/actions';

const OPTIONS = [
  ['accepted', 'The difference is real, the count stands'],
  ['recount', 'Not trusted, someone is going back to look'],
  ['investigating', 'Picked up, cause not known yet'],
  ['data_fixed', 'The underlying record was corrected'],
  ['not_an_issue', 'The engine was being over-cautious'],
] as const;

/**
 * Closing an issue.
 *
 * There is no single "resolve" button, because the five things a person might
 * have actually done have different consequences and somebody will need to
 * know which it was. Two of them leave the issue open, which is the honest
 * outcome: deciding work needs doing is not the same as doing it.
 */
export default function ResolveForm({ issueId }: { issueId: string }) {
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<(typeof OPTIONS)[number][0]>('accepted');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button className="quiet" onClick={() => setOpen(true)}>
        Deal with it
      </button>
    );
  }

  if (result) return <span className="dim">{result}</span>;

  return (
    <div style={{ maxWidth: 380 }}>
      <div className="field">
        <label htmlFor={`r-${issueId}`}>What did you do</label>
        <select
          id={`r-${issueId}`}
          value={resolution}
          onChange={(e) => setResolution(e.target.value as typeof resolution)}
        >
          {OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`n-${issueId}`}>Why. Somebody will read this in six months.</label>
        <input
          id={`n-${issueId}`}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <button
        disabled={pending || !note.trim()}
        onClick={() =>
          start(async () => {
            const res = await resolveIssue({ issueId, resolution, note });
            setResult(res.ok ? res.message : res.message);
            if (!res.ok) setResult(null);
          })
        }
      >
        {pending ? 'Saving' : 'Record it'}
      </button>{' '}
      <button className="quiet" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
