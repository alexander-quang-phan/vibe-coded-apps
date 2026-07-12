-- Task 6.5 (Simple mode): the single monthly cap simple_mode tracks against.
-- Nullable on purpose — choosing the number is the meaningful moment, so we
-- never default it. The Dashboard's SimpleMonthCard prompts inline when null.
alter table public.user_stats
  add column if not exists monthly_limit numeric null
  check (monthly_limit is null or (monthly_limit > 0 and monthly_limit <= 1000000000));

comment on column public.user_stats.monthly_limit is
  'Simple-mode single monthly spending cap. Null until the user sets it.';
