-- server/migrations/010_pln_currency.sql
-- Phase 9.1: Polish złoty. ADD VALUE must not share a transaction with
-- statements that USE the value — keep this file to this single statement.
alter type public.currency_code add value if not exists 'PLN';
