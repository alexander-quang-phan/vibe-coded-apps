-- Trim — repair API grants for projects where 001_init.sql was already run.
-- Paste this into the Supabase SQL editor and run once.
--
-- RLS remains enabled. These grants only allow the server-side service_role key
-- to reach the tables through Supabase's Data API; Express still scopes every
-- query to req.user.id.

grant usage on schema public to service_role;

grant all on table
  public.user_stats,
  public.categories,
  public.transactions,
  public.budgets,
  public.savings_goals,
  public.savings_contributions
to service_role;

grant all on all routines in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant all on routines to service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to service_role;
