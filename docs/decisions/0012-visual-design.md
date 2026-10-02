# 12. Visual hierarchy and restrained accents

## Decision

The interface uses a small number of visual signals and gives each one a clear
job. Repeated uppercase tracked labels were removed from navigation, section
rules, tables and truth views because they competed with the information rather
than helping people scan it. Hierarchy is carried by the mono face, size and
colour instead.

The dark background and amber accent were kept because the amber has a direct
material reference: warehouse racking and hazard marking. It is structural,
not decorative. A second material treatment appears only on the count receipt,
using manifest-paper cues so it reads as a physical confirmation rather than
another dashboard panel.

## The one bold move

`EvidenceReel` on Control. A single orchestrated sequence, not scattered hover
animation: the canonical pallet item ticks through count, book claim,
"as known then", the late receipt, "as known now, cannot be stated", and the
real resolution text. Every value is computed server-side by running the actual
engine against the actual database — `loadCanonicalExample()` uses the same
`explain()` and `asOfKnowledge()` the rest of the product runs on. If the seed
data changes, the story changes with it.

It respects `prefers-reduced-motion`: reduced-motion users go straight to the
final frame, so no information depends on animation.

## The one material accessory

The count receipt on `/count`. A physical count gets a physical confirmation:
paper colour, a perforated top and bottom edge, monospace throughout. The
material treatment is used once and nowhere else, which keeps it meaningful.

## A bug this pass caught

`loadCanonicalExample` first called `loadScope` with `locationId: null`, which
only matches a scope whose key is exactly `item::none`. The real canonical
item's scope key includes an actual location (`PACK-01`), so the lookup silently
returned nothing and the hero rendered blank. Fixed by loading the site's scopes
and finding by item id, since the location was not known in advance. Caught by
running it, not by reading it — the build and typecheck were both clean while
this was broken, because a null return is a valid type, just the wrong one.
