-- The engine works out two separate numbers and 0004 only had somewhere to put
-- one of them.
--
--   derived_quantity  - what is on the shelf now, anchored on the count
--   variance_at_count - how wrong the book was when somebody last looked
--
-- They answer different questions and go stale at different rates. A business
-- wants the first to run the place and the second to decide whether its records
-- are worth anything, so both need storing rather than one being recomputed on
-- demand from evidence that may since have changed.

alter table public.reconciliation_results
  add column variance_at_count numeric,
  -- The book figure carried forward to the moment of the count, which is what
  -- the variance is measured against. Stored so the arithmetic can be shown
  -- rather than asserted.
  add column book_at_count numeric;

comment on column public.reconciliation_results.variance_at_count is
  'Counted quantity minus the book carried forward to the count. Null when the movement window between them is not complete enough to make the comparison mean anything.';

comment on column public.reconciliation_results.derived_quantity is
  'Best supported current position. Null whenever the evidence does not support exactly one answer.';
