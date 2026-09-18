# Five-minute demo

This is the route I use when showing the project. No grand tour required.

1. Open **Control**. The first screen shows how much of the stock catalogue rests on recent physical evidence rather than just existing in a database.
2. Open **Items** and choose `PKG-CAN-440`.
3. Point out the three separate questions: **Book says**, **Somebody counted**, **On the shelf now**.
4. The third answer is refused. Read the reason underneath it: an 8,400-unit delivery happened before the count but was entered afterwards.
5. Scroll through the timeline. The chronology makes the ambiguity visible instead of smoothing it into a tidy number.
6. Run `npx tsx scripts/explain.ts PKG-CAN-440`. It derives the same refusal directly from the records and then asks the historical question: what did the system know a minute before that late movement arrived?

That is the project in one example.

The rest of the screens show that the same rule survives uglier cases: zero counts, shared barcodes, wrong units, stale feeds, duplicate-looking receipts, unmatched movements and items nobody has counted at all.
