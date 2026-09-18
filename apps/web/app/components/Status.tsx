const LABELS: Record<string, string> = {
  VERIFIED: 'Verified',
  PROVISIONAL: 'With caveats',
  STALE: 'Out of date',
  INCOMPLETE: 'Cannot be stated',
  CONFLICT: 'Contradictory',
  UNVERIFIED: 'Never counted',
};

export function statusLabel(state: string | null | undefined): string {
  return LABELS[state ?? 'UNVERIFIED'] ?? (state ?? 'Unknown');
}

export default function Status({ state }: { state: string | null | undefined }) {
  const safe = state ?? 'UNVERIFIED';
  return (
    <span className={`status-chip status-${safe}`}>
      <span className="status-dot" aria-hidden="true" />
      {statusLabel(safe)}
    </span>
  );
}
