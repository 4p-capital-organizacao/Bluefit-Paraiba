-- Rollback BlueDesk H1.2 — Auto-atribuicao + Fila virtual
-- Reverte 01_main.sql.

-- Cron job
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname = 'bluedesk-release-stale-assignments';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- View
DROP VIEW IF EXISTS public.assignment_queue_stats;

-- Trigger + funcao do log
DROP TRIGGER IF EXISTS trg_conversations_log_assignment ON public.conversations;
DROP FUNCTION IF EXISTS public.log_conversation_assignment_change();

-- RPCs
DROP FUNCTION IF EXISTS public.claim_next_conversation(bigint);
DROP FUNCTION IF EXISTS public.release_stale_assignments();
DROP FUNCTION IF EXISTS public.current_profile_cargo_level();

-- pg_cron NAO eh removida (pode ter outros jobs)
