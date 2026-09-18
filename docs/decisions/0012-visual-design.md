# 12. One hero, one accessory, and the tells removed

## Decision

The visual pass followed the frontend-design brief's own warning list. Four
uppercase tracked-letter labels were removed (nav section headers, section
rules, table headers, the truth-view labels) because that exact pattern —
"a tracked-out ALL-CAPS eyebrow label above every heading" — is named as one
of the commonest generated-page tells. Hierarchy is now carried by the mono
face, size and colour instead of by shouting.

The dark-background-plus-single-accent palette was kept rather than replaced,
because it is also on that list, but it is grounded rather than arbitrary:
the amber is racking and hazard colour, the subject's own material, not a
decorative pick. A second material was added specifically so the whole system
did not lean on one trick — manifest paper, used exactly once.

## The one bold move

`EvidenceReel` on Control. A single orchestrated sequence, not scattered
hover animation: the canonical pallet item ticks through count, book claim,
"as known then", the late receipt, "as known now, cannot be stated", and the
real resolution text. Every value is a prop computed server-side by running
the actual engine against the actual database — `loadCanonicalExample()` uses
the same `explain()` and `asOfKnowledge()` the rest of the product runs on.
If the seed data changes, the story changes with it.

Respects `prefers-reduced-motion`: skips straight to the final frame rather
than disabling the reveal, so the content is still there, just not animated
into place.

## The one material accessory

The count receipt on `/count`. A physical count gets a physical confirmation:
paper colour, a perforated top and bottom edge, monospace throughout. Spent
once, nowhere else in the system, per the brief's instruction to spend
boldness in one place and keep everything around it quiet.

## A bug this pass caught

`loadCanonicalExample` first called `loadScope` with `locationId: null`,
which only matches a scope whose key is exactly `item::none`. The real
canonical item's scope key includes an actual location (`PACK-01`), so the
lookup silently returned nothing and the hero rendered blank. Fixed by
loading the site's scopes and finding by item id, since the location was not
known in advance. Caught by running it, not by reading it — the build and
typecheck were both clean while this was broken, because a null return is a
valid type, just the wrong one.
