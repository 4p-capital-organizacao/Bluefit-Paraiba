-- ============================================================
-- BlueDesk H2.2 — Base fria + sinalizacao
-- ============================================================
-- - Novo stage 'base_fria' (text, sem enum) — leads que receberam 3 templates sem responder
-- - eligible_followup_leads: limite de envios sobe de 2 para 3
-- - move_leads_to_base_fria: move leads em contato_feito com 3 templates + N dias sem inbound
-- - reopen_conversation_on_inbound: estende para mover lead base_fria -> contato_feito
-- - leads.reactivated_at: marca timestamp quando lead voltou de base_fria
-- - unit_automation_settings: max_followup_envios + move_to_base_fria_enabled + move_to_base_fria_after_days
-- - View lead_followup_summary: contagem de templates por lead p/ Kanban
-- ============================================================

-- 1. Coluna reactivated_at em leads (badge "Reativado")
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS reactivated_at timestamptz;

-- 2. Settings: novos campos para configurar a 3a tentativa + base fria
ALTER TABLE public.unit_automation_settings
  ADD COLUMN IF NOT EXISTS max_followup_envios integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS move_to_base_fria_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS move_to_base_fria_after_days integer NOT NULL DEFAULT 7;

-- 3. Atualiza eligible_followup_leads para usar max_followup_envios
CREATE OR REPLACE FUNCTION public.eligible_followup_leads(p_unit_id bigint, p_limit int DEFAULT 50)
RETURNS TABLE (
  lead_id uuid,
  contact_id bigint,
  conversation_id bigint,
  phone text,
  nome_completo text,
  envio_anterior_em timestamptz,
  envio_count int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_threshold_h int;
  v_resend_days int;
  v_max_envios int;
BEGIN
  SELECT threshold_hours, resend_after_days, max_followup_envios
    INTO v_threshold_h, v_resend_days, v_max_envios
    FROM public.unit_automation_settings
   WHERE unit_id = p_unit_id;

  IF v_threshold_h IS NULL THEN v_threshold_h := 72; END IF;
  IF v_max_envios IS NULL THEN v_max_envios := 3; END IF;

  RETURN QUERY
  WITH last_template AS (
    SELECT aml.lead_id,
           MAX(aml.sent_at) AS ultimo_envio,
           COUNT(*) FILTER (WHERE aml.status = 'sent') AS envios_ok
      FROM public.automated_message_log aml
     WHERE aml.template_name LIKE 'followup\_%' ESCAPE '\'
       AND aml.unit_id = p_unit_id
     GROUP BY aml.lead_id
  ),
  base AS (
    SELECT s.lead_id, s.id_unidade, s.id_contact, s.stage_entered_at,
           ct.id AS contact_pk, ct.phone_number, ct.wa_id,
           l.nome_completo,
           lt.ultimo_envio, COALESCE(lt.envios_ok, 0) AS envios_ok
      FROM public.lead_current_stage s
      JOIN public.leads l ON l.id = s.lead_id
      LEFT JOIN public.contacts ct ON ct.id = s.id_contact
      LEFT JOIN last_template lt ON lt.lead_id = s.lead_id
     WHERE s.situacao = 'contato_feito'
       AND s.id_unidade = p_unit_id
       AND s.stage_entered_at < now() - (v_threshold_h || ' hours')::interval
       AND s.stage_entered_at > now() - interval '60 days'
       AND ct.id IS NOT NULL
       AND COALESCE(ct.phone_number, ct.wa_id) IS NOT NULL
  )
  SELECT
    b.lead_id,
    b.contact_pk,
    (SELECT c.id FROM public.conversations c
      WHERE c.contact_id = b.contact_pk
      ORDER BY c.updated_at DESC LIMIT 1) AS conversation_id,
    COALESCE(b.phone_number, b.wa_id) AS phone,
    b.nome_completo,
    b.ultimo_envio,
    b.envios_ok::int
  FROM base b
  WHERE
    b.envios_ok < v_max_envios
    AND (
      b.ultimo_envio IS NULL
      OR (
        v_resend_days IS NOT NULL
        AND b.ultimo_envio < now() - (v_resend_days || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM public.messages m
          JOIN public.conversations cv ON cv.id = m.conversation_id
          WHERE cv.contact_id = b.contact_pk
            AND m.direction = 'inbound'
            AND COALESCE(m.sent_at, m.created_at) >= b.ultimo_envio
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.conversations cv ON cv.id = m.conversation_id
      WHERE cv.contact_id = b.contact_pk
        AND m.direction = 'outbound'
        AND m.type <> 'template'
        AND COALESCE(m.sent_at, m.created_at) > now() - (v_threshold_h || ' hours')::interval
    )
  ORDER BY b.stage_entered_at ASC
  LIMIT p_limit;
END;
$func$;

REVOKE ALL ON FUNCTION public.eligible_followup_leads(bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.eligible_followup_leads(bigint, int) TO service_role;

-- 4. RPC: move leads para base_fria
CREATE OR REPLACE FUNCTION public.move_leads_to_base_fria(p_unit_id bigint)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max_envios int;
  v_after_days int;
  v_enabled boolean;
  v_moved int := 0;
BEGIN
  SELECT max_followup_envios, move_to_base_fria_after_days, move_to_base_fria_enabled
    INTO v_max_envios, v_after_days, v_enabled
    FROM public.unit_automation_settings
   WHERE unit_id = p_unit_id;

  IF NOT COALESCE(v_enabled, true) THEN RETURN 0; END IF;
  IF v_max_envios IS NULL THEN v_max_envios := 3; END IF;
  IF v_after_days IS NULL THEN v_after_days := 7; END IF;

  WITH eligible AS (
    SELECT l.id AS lead_id, l.situacao
      FROM public.leads l
      JOIN public.lead_current_stage s ON s.lead_id = l.id
     WHERE l.id_unidade = p_unit_id
       AND s.situacao = 'contato_feito'
       AND EXISTS (
         -- Pelo menos max_envios templates enviados
         SELECT 1 FROM (
           SELECT lead_id, COUNT(*) AS c, MAX(sent_at) AS ult
             FROM public.automated_message_log
            WHERE status = 'sent'
              AND lead_id = l.id
              AND template_name LIKE 'followup\_%' ESCAPE '\'
            GROUP BY lead_id
         ) ag
         WHERE ag.c >= v_max_envios
           AND ag.ult < now() - (v_after_days || ' days')::interval
       )
       -- Sem inbound do cliente desde o último template
       AND NOT EXISTS (
         SELECT 1 FROM public.messages m
         JOIN public.conversations cv ON cv.id = m.conversation_id
         WHERE cv.contact_id = l.id_contact
           AND m.direction = 'inbound'
           AND COALESCE(m.sent_at, m.created_at) >= (
             SELECT MAX(sent_at) FROM public.automated_message_log
              WHERE lead_id = l.id AND status = 'sent'
           )
       )
  ),
  ins_history AS (
    INSERT INTO public.lead_history (lead_id, field_changed, old_value, new_value, changed_at)
    SELECT lead_id, 'situacao', situacao, 'base_fria', now()
      FROM eligible
    RETURNING lead_id
  ),
  upd AS (
    UPDATE public.leads
       SET situacao = 'base_fria',
           motivo_cancelamento = COALESCE(motivo_cancelamento, 'Sem resposta após follow-ups automáticos')
     WHERE id IN (SELECT lead_id FROM eligible)
    RETURNING id
  )
  SELECT COUNT(*) INTO v_moved FROM upd;

  RETURN v_moved;
END;
$$;
REVOKE ALL ON FUNCTION public.move_leads_to_base_fria(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_leads_to_base_fria(bigint) TO service_role;

-- 5. Estende reopen_conversation_on_inbound: também move lead base_fria -> contato_feito
CREATE OR REPLACE FUNCTION public.reopen_conversation_on_inbound()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contact_id bigint;
BEGIN
  -- Reabre conversa se estava closed
  UPDATE public.conversations
     SET status = 'open', closed_at = NULL
   WHERE id = NEW.conversation_id
     AND status = 'closed';

  -- Acha contact_id da conversa
  SELECT contact_id INTO v_contact_id FROM public.conversations WHERE id = NEW.conversation_id;

  IF v_contact_id IS NOT NULL THEN
    -- Reativa leads em base_fria desse contato
    -- (registra em lead_history, seta reactivated_at, volta para contato_feito)
    WITH leads_para_reativar AS (
      SELECT id FROM public.leads
       WHERE id_contact = v_contact_id
         AND situacao = 'base_fria'
    ),
    ins_history AS (
      INSERT INTO public.lead_history (lead_id, field_changed, old_value, new_value, changed_at)
      SELECT id, 'situacao', 'base_fria', 'contato_feito', now()
        FROM leads_para_reativar
    )
    UPDATE public.leads
       SET situacao = 'contato_feito',
           reactivated_at = now()
     WHERE id IN (SELECT id FROM leads_para_reativar);
  END IF;

  RETURN NEW;
END;
$$;

-- 6. View lead_followup_summary: usada pelo Kanban para mostrar badges
CREATE OR REPLACE VIEW public.lead_followup_summary
WITH (security_invoker = true) AS
SELECT
  l.id AS lead_id,
  l.id_unidade,
  l.reactivated_at,
  COALESCE(ag.envios, 0) AS followup_count,
  ag.ultimo_envio,
  CASE
    WHEN l.reactivated_at IS NOT NULL AND l.reactivated_at > now() - interval '14 days'
      THEN true ELSE false
  END AS recently_reactivated
FROM public.leads l
LEFT JOIN (
  SELECT lead_id, COUNT(*) FILTER (WHERE status = 'sent') AS envios, MAX(sent_at) AS ultimo_envio
    FROM public.automated_message_log
   WHERE template_name LIKE 'followup\_%' ESCAPE '\'
   GROUP BY lead_id
) ag ON ag.lead_id = l.id;

GRANT SELECT ON public.lead_followup_summary TO authenticated;
