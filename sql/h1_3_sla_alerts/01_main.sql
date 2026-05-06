-- ============================================================
-- BlueDesk H1.3 — SLA + Alertas + Auto-close
-- ============================================================
-- - Tabela alerts (com dedup por unique partial index)
-- - View lead_current_stage (situacao + stage_entered_at)
-- - RPC evaluate_sla_violations() em pg_cron */10 * * * *
-- - RPC auto_close_inactive_conversations(p_days) em pg_cron 5 * * * *
-- - Trigger reopen_on_inbound em messages
-- - RPC resolve_alert(id) para fechar manualmente
-- ============================================================

-- 1. Tabela alerts
CREATE TABLE IF NOT EXISTS public.alerts (
  id bigserial PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('sla_first_contact','sla_followup','sla_visit_followup','conversation_unanswered')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  lead_id uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  conversation_id bigint REFERENCES public.conversations(id) ON DELETE CASCADE,
  unit_id bigint REFERENCES public.units(id) ON DELETE SET NULL,
  assigned_user_id uuid,
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_lead_type
  ON public.alerts(lead_id, type)
  WHERE resolved_at IS NULL AND lead_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_conv_type
  ON public.alerts(conversation_id, type)
  WHERE resolved_at IS NULL AND conversation_id IS NOT NULL AND lead_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_alerts_unresolved_unit
  ON public.alerts(unit_id, severity, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_alerts_assigned_unresolved
  ON public.alerts(assigned_user_id, created_at DESC)
  WHERE resolved_at IS NULL;

-- 2. RLS para alerts
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alerts_select ON public.alerts;
CREATE POLICY alerts_select ON public.alerts FOR SELECT
  USING (
    public.is_admin_user()
    OR (unit_id IS NOT NULL AND unit_id IN (SELECT public.user_unit_ids()))
    OR assigned_user_id = auth.uid()
  );

DROP POLICY IF EXISTS alerts_update ON public.alerts;
CREATE POLICY alerts_update ON public.alerts FOR UPDATE
  USING (
    public.is_admin_user()
    OR (unit_id IS NOT NULL AND unit_id IN (SELECT public.user_unit_ids()))
    OR assigned_user_id = auth.uid()
  )
  WITH CHECK (
    public.is_admin_user()
    OR (unit_id IS NOT NULL AND unit_id IN (SELECT public.user_unit_ids()))
    OR assigned_user_id = auth.uid()
  );

DROP POLICY IF EXISTS alerts_insert ON public.alerts;
CREATE POLICY alerts_insert ON public.alerts FOR INSERT
  WITH CHECK (public.is_admin_user());

DROP POLICY IF EXISTS alerts_delete ON public.alerts;
CREATE POLICY alerts_delete ON public.alerts FOR DELETE
  USING (public.is_admin_user());

-- 3. View: stage atual + quando entrou no stage
CREATE OR REPLACE VIEW public.lead_current_stage
WITH (security_invoker = true) AS
SELECT
  l.id AS lead_id,
  l.situacao,
  l.id_unidade,
  l.responsavel,
  l.id_contact,
  l.created_at,
  COALESCE(
    (SELECT h.changed_at FROM public.lead_history h
       WHERE h.lead_id = l.id AND h.field_changed = 'situacao'
       ORDER BY h.changed_at DESC LIMIT 1),
    l.created_at
  ) AS stage_entered_at
FROM public.leads l;

GRANT SELECT ON public.lead_current_stage TO authenticated;

-- 4. RPC evaluate_sla_violations()
CREATE OR REPLACE FUNCTION public.evaluate_sla_violations()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first_contact int := 0;
  v_followup int := 0;
  v_visit int := 0;
  v_resolved int := 0;
BEGIN
  -- 4.1 sla_first_contact: novo > 1h
  WITH novos AS (
    SELECT s.lead_id, s.id_unidade
      FROM public.lead_current_stage s
     WHERE s.situacao = 'novo'
       AND s.stage_entered_at < now() - interval '1 hour'
       AND s.stage_entered_at > now() - interval '30 days'
     LIMIT 500
  ),
  ins AS (
    INSERT INTO public.alerts (type, severity, lead_id, unit_id, message)
    SELECT 'sla_first_contact', 'high', n.lead_id, n.id_unidade,
           'Lead em "novo" sem primeiro contato ha mais de 1h'
      FROM novos n
    ON CONFLICT (lead_id, type) WHERE resolved_at IS NULL AND lead_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_first_contact FROM ins;

  -- 4.2 sla_followup: contato_feito > 48h, ignora zumbis >30d
  WITH cf AS (
    SELECT s.lead_id, s.id_unidade
      FROM public.lead_current_stage s
     WHERE s.situacao = 'contato_feito'
       AND s.stage_entered_at < now() - interval '48 hours'
       AND s.stage_entered_at > now() - interval '30 days'
     LIMIT 500
  ),
  ins AS (
    INSERT INTO public.alerts (type, severity, lead_id, unit_id, message)
    SELECT 'sla_followup', 'medium', cf.lead_id, cf.id_unidade,
           'Lead em "contato_feito" sem follow-up ha mais de 48h'
      FROM cf
    ON CONFLICT (lead_id, type) WHERE resolved_at IS NULL AND lead_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_followup FROM ins;

  -- 4.3 sla_visit_followup: visita_realizada > 48h sem matricular/perder
  WITH visitas AS (
    SELECT s.lead_id, s.id_unidade
      FROM public.lead_current_stage s
     WHERE s.situacao = 'visita_realizada'
       AND s.stage_entered_at < now() - interval '48 hours'
       AND s.stage_entered_at > now() - interval '30 days'
     LIMIT 500
  ),
  ins AS (
    INSERT INTO public.alerts (type, severity, lead_id, unit_id, message)
    SELECT 'sla_visit_followup', 'high', v.lead_id, v.id_unidade,
           'Visita realizada ha mais de 48h sem matricula nem perda'
      FROM visitas v
    ON CONFLICT (lead_id, type) WHERE resolved_at IS NULL AND lead_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_visit FROM ins;

  -- 4.4 Resolve alerts cujo stage ja mudou (condition_cleared)
  WITH cleared AS (
    UPDATE public.alerts a
       SET resolved_at = now(),
           resolved_reason = 'condition_cleared'
      FROM public.lead_current_stage s
     WHERE a.resolved_at IS NULL
       AND a.lead_id IS NOT NULL
       AND a.lead_id = s.lead_id
       AND (
         (a.type = 'sla_first_contact' AND s.situacao <> 'novo')
         OR (a.type = 'sla_followup' AND s.situacao <> 'contato_feito')
         OR (a.type = 'sla_visit_followup' AND s.situacao NOT IN ('visita_realizada'))
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_resolved FROM cleared;

  RETURN jsonb_build_object(
    'first_contact_created', v_first_contact,
    'followup_created', v_followup,
    'visit_followup_created', v_visit,
    'resolved_cleared', v_resolved
  );
END;
$$;
REVOKE ALL ON FUNCTION public.evaluate_sla_violations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_sla_violations() TO service_role;

-- 5. RPC auto_close_inactive_conversations
CREATE OR REPLACE FUNCTION public.auto_close_inactive_conversations(p_days int DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_closed int;
BEGIN
  WITH stale AS (
    SELECT id FROM public.conversations
     WHERE status = 'open'
       AND COALESCE(last_message_at, created_at) < now() - (p_days || ' days')::interval
     LIMIT 1000
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.conversations c
     SET status = 'closed',
         closed_at = now()
    FROM stale
   WHERE c.id = stale.id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$$;
REVOKE ALL ON FUNCTION public.auto_close_inactive_conversations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_close_inactive_conversations(int) TO service_role;

-- 6. Trigger: reabrir conversa fechada quando chega inbound
CREATE OR REPLACE FUNCTION public.reopen_conversation_on_inbound()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.conversations
     SET status = 'open', closed_at = NULL
   WHERE id = NEW.conversation_id
     AND status = 'closed';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_reopen_on_inbound ON public.messages;
CREATE TRIGGER trg_messages_reopen_on_inbound
AFTER INSERT ON public.messages
FOR EACH ROW
WHEN (NEW.direction = 'inbound')
EXECUTE FUNCTION public.reopen_conversation_on_inbound();

-- 7. RPC resolve_alert(id)
CREATE OR REPLACE FUNCTION public.resolve_alert(p_alert_id bigint)
RETURNS public.alerts
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alert public.alerts;
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE public.alerts
     SET resolved_at = now(),
         resolved_by = v_caller,
         resolved_reason = 'manual'
   WHERE id = p_alert_id
     AND resolved_at IS NULL
     AND (
       public.is_admin_user()
       OR (unit_id IS NOT NULL AND unit_id IN (SELECT public.user_unit_ids()))
       OR assigned_user_id = v_caller
     )
   RETURNING * INTO v_alert;

  IF v_alert.id IS NULL THEN
    RAISE EXCEPTION 'alert nao encontrado, ja resolvido, ou sem permissao' USING ERRCODE = '42501';
  END IF;

  RETURN v_alert;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_alert(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_alert(bigint) TO authenticated;

-- 8. View para o widget de Atenção (com nomes/contexto)
CREATE OR REPLACE VIEW public.alerts_with_context
WITH (security_invoker = true) AS
SELECT
  a.id,
  a.type,
  a.severity,
  a.lead_id,
  a.conversation_id,
  a.unit_id,
  a.assigned_user_id,
  a.message,
  a.metadata,
  a.created_at,
  a.resolved_at,
  l.nome_completo AS lead_nome,
  l.situacao AS lead_situacao,
  l.responsavel AS lead_responsavel,
  l.telefone AS lead_telefone,
  u.name AS unit_name,
  c.id AS conv_id_for_link,
  ct.display_name AS contact_name
FROM public.alerts a
LEFT JOIN public.leads l ON l.id = a.lead_id
LEFT JOIN public.units u ON u.id = a.unit_id
LEFT JOIN public.conversations c ON c.id = a.conversation_id
LEFT JOIN public.contacts ct ON ct.id = c.contact_id;

GRANT SELECT ON public.alerts_with_context TO authenticated;

-- 9. Schedules pg_cron
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('bluedesk-evaluate-sla','bluedesk-auto-close-conversations');
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

SELECT cron.schedule(
  'bluedesk-evaluate-sla',
  '*/10 * * * *',
  $$SELECT public.evaluate_sla_violations();$$
);

SELECT cron.schedule(
  'bluedesk-auto-close-conversations',
  '5 * * * *',
  $$SELECT public.auto_close_inactive_conversations(7);$$
);
