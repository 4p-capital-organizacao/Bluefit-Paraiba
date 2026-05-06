-- Rollback BlueDesk H1.3 — SLA + Alertas + Auto-close
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('bluedesk-evaluate-sla','bluedesk-auto-close-conversations');
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DROP VIEW IF EXISTS public.alerts_with_context;
DROP TRIGGER IF EXISTS trg_messages_reopen_on_inbound ON public.messages;
DROP FUNCTION IF EXISTS public.reopen_conversation_on_inbound();
DROP FUNCTION IF EXISTS public.resolve_alert(bigint);
DROP FUNCTION IF EXISTS public.auto_close_inactive_conversations(int);
DROP FUNCTION IF EXISTS public.evaluate_sla_violations();
DROP VIEW IF EXISTS public.lead_current_stage;
DROP TABLE IF EXISTS public.alerts;
