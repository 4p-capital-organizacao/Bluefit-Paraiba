-- ============================================================
-- BlueDesk H1.2 — Auto-atribuicao + Fila virtual
-- ============================================================
-- Modelo: "fila" = conversations WHERE status='open' AND assigned_user_id IS NULL.
-- Nao cria tabela nova. Usa conversation_assignments so como log de auditoria.
-- Atribuicao nao bloqueia outros da unidade (eles continuam vendo/respondendo).
-- ============================================================

-- 1. pg_cron para release stale a cada 5min
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Helper: cargo level do caller autenticado
CREATE OR REPLACE FUNCTION public.current_profile_cargo_level()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(c.level, 0)
  FROM public.profiles p
  LEFT JOIN public.cargos c ON c.id = p.id_cargo
  WHERE p.id = auth.uid();
$$;
GRANT EXECUTE ON FUNCTION public.current_profile_cargo_level() TO authenticated;

-- 3. Trigger: log mudancas em conversations.assigned_user_id -> conversation_assignments
CREATE OR REPLACE FUNCTION public.log_conversation_assignment_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    IF OLD.assigned_user_id IS NOT NULL THEN
      UPDATE public.conversation_assignments
         SET unassigned_at = now()
       WHERE conversation_id = NEW.id
         AND assigned_user_id = OLD.assigned_user_id
         AND unassigned_at IS NULL;
    END IF;
    IF NEW.assigned_user_id IS NOT NULL THEN
      INSERT INTO public.conversation_assignments
        (conversation_id, assigned_user_id, assigned_by_user_id, assigned_at, reason)
      VALUES
        (NEW.id, NEW.assigned_user_id, v_actor, now(),
         CASE WHEN v_actor IS NULL THEN 'system'
              WHEN v_actor = NEW.assigned_user_id THEN 'self_claim'
              ELSE 'manual' END);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_log_assignment ON public.conversations;
CREATE TRIGGER trg_conversations_log_assignment
AFTER UPDATE OF assigned_user_id ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.log_conversation_assignment_change();

-- 4. RPC: claim_next_conversation(unit_id) — pega a proxima da fila
CREATE OR REPLACE FUNCTION public.claim_next_conversation(p_unit_id bigint)
RETURNS public.conversations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv   public.conversations;
  v_caller uuid := auth.uid();
  v_level  integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  v_level := public.current_profile_cargo_level();
  IF v_level < 2 THEN
    RAISE EXCEPTION 'forbidden: cargo insuficiente' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin_user() THEN
    IF p_unit_id NOT IN (SELECT public.user_unit_ids()) THEN
      RAISE EXCEPTION 'forbidden: usuario nao pertence a unidade %', p_unit_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH next_conv AS (
    SELECT id
      FROM public.conversations
     WHERE status = 'open'
       AND assigned_user_id IS NULL
       AND unit_id = p_unit_id
     ORDER BY last_message_at ASC NULLS LAST, created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.conversations c
     SET assigned_user_id = v_caller,
         assigned_at = now()
    FROM next_conv
   WHERE c.id = next_conv.id
   RETURNING c.* INTO v_conv;

  RETURN v_conv;  -- NULL se fila vazia
END;
$$;
REVOKE ALL ON FUNCTION public.claim_next_conversation(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_conversation(bigint) TO authenticated;

-- 5. RPC: release_stale_assignments() — chamada por pg_cron a cada 5min
CREATE OR REPLACE FUNCTION public.release_stale_assignments()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_released integer;
BEGIN
  WITH stale AS (
    SELECT c.id
      FROM public.conversations c
     WHERE c.status = 'open'
       AND c.assigned_user_id IS NOT NULL
       AND c.assigned_at IS NOT NULL
       AND c.assigned_at < now() - interval '60 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM public.messages m
          WHERE m.conversation_id = c.id
            AND m.direction = 'outbound'
            AND COALESCE(m.sent_at, m.created_at) >= c.assigned_at
       )
     LIMIT 500
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.conversations c
     SET assigned_user_id = NULL,
         assigned_at = NULL
    FROM stale
   WHERE c.id = stale.id;

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$$;
REVOKE ALL ON FUNCTION public.release_stale_assignments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_stale_assignments() TO service_role;

-- 6. View: tamanho da fila por unidade (para o painel)
CREATE OR REPLACE VIEW public.assignment_queue_stats
WITH (security_invoker = true) AS
SELECT
  c.unit_id,
  u.name AS unit_name,
  COUNT(*) FILTER (WHERE c.assigned_user_id IS NULL) AS queue_size,
  COUNT(*) FILTER (WHERE c.assigned_user_id IS NULL
                   AND c.last_message_at < now() - interval '15 minutes') AS waiting_over_15min,
  COUNT(*) FILTER (WHERE c.assigned_user_id IS NULL
                   AND c.last_message_at < now() - interval '1 hour') AS waiting_over_1h,
  COUNT(*) FILTER (WHERE c.assigned_user_id IS NOT NULL) AS in_progress
FROM public.conversations c
LEFT JOIN public.units u ON u.id = c.unit_id
WHERE c.status = 'open'
GROUP BY c.unit_id, u.name;

GRANT SELECT ON public.assignment_queue_stats TO authenticated;

-- 7. Schedule pg_cron: liberar atribuicoes stale a cada 5min
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
    FROM cron.job
   WHERE jobname = 'bluedesk-release-stale-assignments';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

SELECT cron.schedule(
  'bluedesk-release-stale-assignments',
  '*/5 * * * *',
  $$SELECT public.release_stale_assignments();$$
);
