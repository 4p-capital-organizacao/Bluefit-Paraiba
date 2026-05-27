-- Remove acesso de anônimos a funções SECURITY DEFINER que disparam ações de
-- negócio (não devem ser chamadas sem auth via /rest/v1/rpc).
--
-- Mantidas com acesso de anon as 7 helpers usadas em RLS policies
-- (is_admin_user, user_unit_ids, user_accessible_*, user_can_access_*,
-- current_profile_cargo_level) — RLS as avalia em qualquer role.

REVOKE EXECUTE ON FUNCTION public.auto_close_inactive_conversations(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_next_conversation(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.count_followups_today(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.eligible_followup_leads(bigint, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.evaluate_sla_violations() FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_quick_reply_usage(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_conversation_assignment_change() FROM anon;
REVOKE EXECUTE ON FUNCTION public.move_leads_to_base_fria(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.release_stale_assignments() FROM anon;
REVOKE EXECUTE ON FUNCTION public.reopen_conversation_on_inbound() FROM anon;
REVOKE EXECUTE ON FUNCTION public.resolve_alert(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
