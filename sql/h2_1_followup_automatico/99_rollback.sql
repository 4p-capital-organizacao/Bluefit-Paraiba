-- Rollback H2.1 Follow-up automatico
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname = 'bluedesk-followup-automatico';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DROP VIEW IF EXISTS public.unit_automation_overview;
DROP FUNCTION IF EXISTS public.count_followups_today(bigint);
DROP FUNCTION IF EXISTS public.eligible_followup_leads(bigint, int);
DROP TRIGGER IF EXISTS trg_unit_automation_updated_at ON public.unit_automation_settings;
DROP TABLE IF EXISTS public.unit_automation_settings;
DROP TABLE IF EXISTS public.automated_message_log;
