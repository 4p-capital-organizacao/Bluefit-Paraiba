-- ============================================================
-- BlueDesk H2.1 — Follow-up autom\xc3\xa1tico via template Meta
-- ============================================================
-- - automated_message_log: audit + dedup de envios autom\xc3\xa1ticos
-- - unit_automation_settings: toggle/cap/template por unidade (default OFF)
-- - RPC eligible_followup_leads(unit_id): retorna leads eleg\xc3\xadveis respeitando cap
-- - pg_cron schedule: chama edge function a cada hora 9-18h BRT seg-sex
-- ============================================================

-- 1. Log de mensagens autom\xc3\xa1ticas
CREATE TABLE IF NOT EXISTS public.automated_message_log (
  id bigserial PRIMARY KEY,
  template_name text NOT NULL,
  language text NOT NULL DEFAULT 'pt_BR',
  lead_id uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  conversation_id bigint REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_id bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  unit_id bigint REFERENCES public.units(id) ON DELETE SET NULL,
  reason text NOT NULL,
  meta_message_id text,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped')),
  error_message text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automated_log_lead ON public.automated_message_log(lead_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_automated_log_unit_day ON public.automated_message_log(unit_id, ((sent_at AT TIME ZONE 'America/Sao_Paulo')::date));
CREATE INDEX IF NOT EXISTS idx_automated_log_status ON public.automated_message_log(status, sent_at DESC);

ALTER TABLE public.automated_message_log ENABLE ROW LEVEL SECURITY;

-- SELECT: admin v\xc3\xaa tudo, gerente/superv./atendente v\xc3\xaa s\xc3\xb3 da pr\xc3\xb3pria unidade
DROP POLICY IF EXISTS aml_select ON public.automated_message_log;
CREATE POLICY aml_select ON public.automated_message_log FOR SELECT
  USING (
    public.is_admin_user()
    OR (unit_id IS NOT NULL AND unit_id IN (SELECT public.user_unit_ids()))
  );

-- INSERT/UPDATE/DELETE: apenas service_role (cron / edge function)
DROP POLICY IF EXISTS aml_no_modify ON public.automated_message_log;
-- (sem policy de INSERT/UPDATE/DELETE = nada; service_role bypassa RLS)

-- 2. Settings por unidade
CREATE TABLE IF NOT EXISTS public.unit_automation_settings (
  unit_id bigint PRIMARY KEY REFERENCES public.units(id) ON DELETE CASCADE,
  followup_enabled boolean NOT NULL DEFAULT false,
  daily_cap integer NOT NULL DEFAULT 50,
  threshold_hours integer NOT NULL DEFAULT 72,
  resend_after_days integer DEFAULT 7,
  template_name text NOT NULL DEFAULT 'followup_contato_feito_v1',
  template_language text NOT NULL DEFAULT 'pt_BR',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

DROP TRIGGER IF EXISTS trg_unit_automation_updated_at ON public.unit_automation_settings;
CREATE TRIGGER trg_unit_automation_updated_at
  BEFORE UPDATE ON public.unit_automation_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.unit_automation_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: admin + gerente/superv. da unidade
DROP POLICY IF EXISTS uas_select ON public.unit_automation_settings;
CREATE POLICY uas_select ON public.unit_automation_settings FOR SELECT
  USING (
    public.is_admin_user()
    OR (unit_id IN (SELECT public.user_unit_ids()) AND public.current_profile_cargo_level() >= 3)
  );

-- INSERT/UPDATE: admin + gerente da unidade (cargo >= 4)
DROP POLICY IF EXISTS uas_modify ON public.unit_automation_settings;
CREATE POLICY uas_modify ON public.unit_automation_settings FOR ALL
  USING (
    public.is_admin_user()
    OR (unit_id IN (SELECT public.user_unit_ids()) AND public.current_profile_cargo_level() >= 4)
  )
  WITH CHECK (
    public.is_admin_user()
    OR (unit_id IN (SELECT public.user_unit_ids()) AND public.current_profile_cargo_level() >= 4)
  );

-- Seed: cria settings padr\xc3\xa3o (OFF) para todas as unidades existentes
INSERT INTO public.unit_automation_settings (unit_id, followup_enabled)
SELECT id, false FROM public.units
ON CONFLICT (unit_id) DO NOTHING;

-- 3. RPC: leads eleg\xc3\xadveis para follow-up de uma unidade
-- Crit\xc3\xa9rios:
--  - lead em 'contato_feito'
--  - stage_entered_at < now() - threshold_hours
--  - sem outbound do consultor nas \xc3\xbaltimas threshold_hours
--  - se nunca recebeu template OU recebeu h\xc3\xa1 >= resend_after_days SEM inbound do cliente desde ent\xc3\xa3o
--  - ainda n\xc3\xa3o atingiu 2 envios totais (limite de reenvios)
--  - cap di\xc3\xa1rio j\xc3\xa1 considerado pelo caller (limit param)
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
AS $$
DECLARE
  v_threshold_h int;
  v_resend_days int;
BEGIN
  SELECT threshold_hours, resend_after_days
    INTO v_threshold_h, v_resend_days
    FROM public.unit_automation_settings
   WHERE unit_id = p_unit_id;

  IF v_threshold_h IS NULL THEN v_threshold_h := 72; END IF;

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
       AND s.stage_entered_at > now() - interval '60 days'  -- ignora zumbis muito antigos
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
    b.envios_ok < 2  -- m\xc3\xa1ximo 2 envios totais
    AND (
      b.ultimo_envio IS NULL  -- nunca recebeu
      OR (
        v_resend_days IS NOT NULL
        AND b.ultimo_envio < now() - (v_resend_days || ' days')::interval
        -- E n\xc3\xa3o houve inbound do cliente desde o \xc3\xbaltimo template
        AND NOT EXISTS (
          SELECT 1 FROM public.messages m
          JOIN public.conversations cv ON cv.id = m.conversation_id
          WHERE cv.contact_id = b.contact_pk
            AND m.direction = 'inbound'
            AND COALESCE(m.sent_at, m.created_at) >= b.ultimo_envio
        )
      )
    )
    -- Sem outbound do consultor nas \xc3\xbaltimas threshold_hours (n\xc3\xa3o pisar no humano)
    AND NOT EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.conversations cv ON cv.id = m.conversation_id
      WHERE cv.contact_id = b.contact_pk
        AND m.direction = 'outbound'
        AND m.type <> 'template'  -- ignora templates pr\xc3\xa9vios autom\xc3\xa1ticos
        AND COALESCE(m.sent_at, m.created_at) > now() - (v_threshold_h || ' hours')::interval
    )
  ORDER BY b.stage_entered_at ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.eligible_followup_leads(bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.eligible_followup_leads(bigint, int) TO service_role;

-- 4. RPC: contagem de envios j\xc3\xa1 feitos hoje pela unidade (cap)
CREATE OR REPLACE FUNCTION public.count_followups_today(p_unit_id bigint)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)::int
    FROM public.automated_message_log
   WHERE unit_id = p_unit_id
     AND status IN ('sent','failed')
     AND (sent_at AT TIME ZONE 'America/Sao_Paulo')::date
         = (now() AT TIME ZONE 'America/Sao_Paulo')::date;
$$;
REVOKE ALL ON FUNCTION public.count_followups_today(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_followups_today(bigint) TO service_role, authenticated;

-- 5. View: lista de unidades configur\xc3\xa1veis com stats r\xc3\xa1pidos para a UI
CREATE OR REPLACE VIEW public.unit_automation_overview
WITH (security_invoker = true) AS
SELECT
  u.id AS unit_id,
  u.name AS unit_name,
  COALESCE(s.followup_enabled, false) AS followup_enabled,
  COALESCE(s.daily_cap, 50) AS daily_cap,
  COALESCE(s.threshold_hours, 72) AS threshold_hours,
  s.resend_after_days,
  COALESCE(s.template_name, 'followup_contato_feito_v1') AS template_name,
  COALESCE(s.template_language, 'pt_BR') AS template_language,
  public.count_followups_today(u.id) AS sent_today,
  s.updated_at AS settings_updated_at
FROM public.units u
LEFT JOIN public.unit_automation_settings s ON s.unit_id = u.id
ORDER BY u.id;

GRANT SELECT ON public.unit_automation_overview TO authenticated;

-- 6. Schedule pg_cron: a cada hora aos 5min, das 12h-21h UTC (= 9h-18h BRT), seg-sex
-- O cron faz POST para a edge function via pg_net.
-- Header X-Cron-Secret precisa bater com env var BLUEDESK_CRON_SECRET na edge function.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('bluedesk-followup-automatico');
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

SELECT cron.schedule(
  'bluedesk-followup-automatico',
  '5 12-21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url := 'https://manvezhphopngpnaiyjv.supabase.co/functions/v1/make-server-844b77a1/api/automation/run-followup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Cron-Secret', 'e7d899bf-9363-4de5-8a89-f3ac03b433a3'
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cron$
);
