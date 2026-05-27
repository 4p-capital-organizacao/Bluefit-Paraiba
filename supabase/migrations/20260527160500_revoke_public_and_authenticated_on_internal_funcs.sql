-- Funções que são triggers, jobs de cron ou admin-only não devem ser
-- chamáveis via REST por NINGUÉM (anon ou authenticated). Triggers rodam
-- automaticamente; cron jobs rodam como postgres; admin tools são chamadas
-- com service_role.

-- Triggers (não devem ser RPC)
REVOKE EXECUTE ON FUNCTION public.log_conversation_assignment_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reopen_conversation_on_inbound() FROM PUBLIC, anon, authenticated;

-- Admin / setup tool
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- Cron jobs (não devem ser RPC pelo frontend nem anon)
REVOKE EXECUTE ON FUNCTION public.auto_close_inactive_conversations(integer) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.evaluate_sla_violations() FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_leads_to_base_fria(bigint) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_stale_assignments() FROM PUBLIC, authenticated;

-- Mantidas com EXECUTE pra authenticated (chamadas direto pelo frontend
-- via /rest/v1/rpc):
--   - claim_next_conversation, count_followups_today, eligible_followup_leads
--   - increment_quick_reply_usage, resolve_alert
-- Mantidas para anon + authenticated (helpers usadas em RLS policies):
--   - is_admin_user, user_unit_ids, user_accessible_*, user_can_access_*,
--     current_profile_cargo_level
