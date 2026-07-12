-- Security advisor fix (Supabase linter 0028/0029): trigger-only
-- SECURITY DEFINER functions must not be callable through the exposed
-- REST RPC surface (/rest/v1/rpc/...). They only ever run via triggers.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
