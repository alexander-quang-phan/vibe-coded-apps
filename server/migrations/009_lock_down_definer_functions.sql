-- Security advisor fix (Supabase linter 0028/0029): trigger-only
-- SECURITY DEFINER functions must not be callable through the exposed
-- REST RPC surface (/rest/v1/rpc/...). They only ever run via triggers.
revoke execute on function public.handle_new_user() from anon, authenticated, public;

-- `rls_auto_enable()` was created out-of-band in the live project and exists in no
-- migration here. A bare revoke therefore raised 42883 undefined_function on a
-- from-scratch replay, and because the Supabase SQL editor wraps a pasted batch in
-- one transaction, the revoke ABOVE rolled back with it — leaving a rebuilt database
-- in exactly the state this file exists to prevent. Tolerate the absence instead.
do $$
begin
  execute 'revoke execute on function public.rls_auto_enable() from anon, authenticated, public';
exception
  when undefined_function then
    raise notice 'rls_auto_enable() not present — nothing to revoke (expected on a fresh database)';
end $$;
