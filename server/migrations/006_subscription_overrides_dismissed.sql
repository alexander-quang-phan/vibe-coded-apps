-- Trim — allow 'dismissed' as a third subscription status for false positives.
--
-- Task 6.2.1's synthetic detector (groups undescribed transactions by category
-- + amount-bucket + cadence) can fire on coincidental clusters that aren't
-- really subscriptions. The existing two-state status enum forced users to
-- pick "Mark cancelled" — which celebrates fake savings and pollutes the
-- "saved (cancelled)" stat. 'dismissed' keeps a separate audit trail without
-- treating the row as ever-active money.
--
-- Paste into the Supabase SQL editor and run once.

alter table public.subscription_overrides
  drop constraint if exists subscription_overrides_status_check;

alter table public.subscription_overrides
  add constraint subscription_overrides_status_check
  check (status in ('active', 'cancelled', 'dismissed'));
