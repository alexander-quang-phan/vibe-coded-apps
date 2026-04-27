-- Trim — align savings contribution notes with the API/UI.
-- Paste this into the Supabase SQL editor and run once if 001_init.sql was
-- already applied before the note column existed.

alter table public.savings_contributions
  add column if not exists note text;
