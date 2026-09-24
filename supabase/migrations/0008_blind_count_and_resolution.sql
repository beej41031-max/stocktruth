-- Two things the first pass got wrong.
--
-- 1. Blind counting.
--
--    The count screen showed the book figure before the counter typed a
--    number. That biases the count: you see 40, you find roughly 40, you
--    write 40. The physical count is the only independent evidence in this
--    system and anchoring it to the number it is meant to check makes it
--    worth less than nothing, because it now looks like agreement.
--
--    Blind is the default. Some operations genuinely want the expected figure
--    visible (a two-person check where one reads and one verifies), so it is
--    a policy rather than a rule, and turning it off is a decision somebody
--    has to make on purpose.
--
-- 2. What happens to a discrepancy.
--
--    An issue could be open or resolved and nothing said what a person was
--    supposed to do in between. Accept it, recount it, or investigate it are
--    different decisions with different consequences, and which one was taken
--    matters more later than the fact that somebody closed it.

alter table public.reconciliation_policies
  add column blind_count boolean not null default true,
  -- After a count is saved, show what the book said. That is not biasing;
  -- the observation is already recorded and cannot be changed by seeing it.
  add column reveal_after_count boolean not null default true,
  -- A manual adjustment without a reason is an unexplained change to the
  -- record, which is the thing this product exists to make impossible.
  add column require_note_on_accept boolean not null default true;

comment on column public.reconciliation_policies.blind_count is
  'Hide the expected quantity until the counter has committed to a number. On by default: a count that was shown the answer is not evidence.';

-- How a person dealt with an issue, rather than merely that they closed it.
create type public.issue_resolution as enum (
  'accepted',      -- the difference is real and the count stands
  'recount',       -- not trusted, somebody is going back to look
  'investigating', -- picked up, cause not yet known
  'data_fixed',    -- the underlying record was corrected
  'not_an_issue'   -- the engine was being over-cautious here
);

alter table public.reconciliation_issues
  add column resolution public.issue_resolution,
  -- Set when a resolution asks for a recount, so the count screen can offer
  -- the item rather than waiting for somebody to remember.
  add column recount_requested boolean not null default false;

-- Anything already closed predates the idea of recording how, and the engine
-- closes issues itself when they stop being reported. Those are legitimate and
-- get labelled rather than deleted, because rewriting history to satisfy a new
-- constraint is the exact habit this schema exists to prevent.
update public.reconciliation_issues
   set resolution = 'not_an_issue',
       resolution_note = coalesce(nullif(trim(resolution_note), ''), 'Closed before resolutions were recorded')
 where status = 'resolved' and resolution is null;

-- Closing an issue without saying how is what turns an audit trail back into
-- a list of timestamps. Enforced here rather than in a form handler, because
-- the form is not the only way rows get written.
alter table public.reconciliation_issues
  add constraint resolved_issues_explain_themselves
  check (
    status <> 'resolved'
    or (resolution is not null and coalesce(length(trim(resolution_note)), 0) > 0)
  );

create index reconciliation_issues_recount_idx
  on public.reconciliation_issues (site_id)
  where recount_requested and status = 'open';
