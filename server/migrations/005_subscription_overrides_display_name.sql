-- Trim — let users name detected subscriptions.
--
-- Task 6.2.1 lets the detector group transactions with no description into
-- synthetic clusters (category + amount-bucket + cadence). Those clusters need
-- a place to store the user-given name so it survives re-detection and is
-- available everywhere the row label appears.
--
-- Paste into the Supabase SQL editor and run once.

alter table public.subscription_overrides
  add column if not exists display_name text;

alter table public.subscription_overrides
  add constraint subscription_overrides_display_name_length
  check (display_name is null or char_length(display_name) <= 40);
