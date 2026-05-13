-- ============================================================
-- BlueDesk H2.3.2 — 🔥 some quando o consultor responde
-- ============================================================
-- Refina respondeu_apos_followup para significar:
--   "cliente respondeu o template automático E ainda nao recebeu
--    resposta humana apos esse inbound"
--
-- Antes (H2.3): so checava se havia inbound apos o template, mantendo
-- o 🔥 aceso mesmo depois do consultor responder. Gerava ruido visual.
--
-- Agora: 2o LATERAL JOIN procura outbound nao-template (type <> 'template')
-- posterior ao ultimo inbound. Se existe -> consultor ja atendeu -> 🔥 some.
-- Se cliente fala de novo (sem nova resposta humana) -> 🔥 volta naturalmente.
--
-- Aplicado em prod via MCP em 2026-05-13.
-- Mantem security_invoker=false (herdado de H2.3.1) para bypassar RLS de
-- messages no LATERAL — view so expoe boolean+timestamp derivados, frontend
-- ja filtra por lead_id com leads que o usuario tem acesso.
-- ============================================================

CREATE OR REPLACE VIEW public.lead_followup_summary
WITH (security_invoker = false) AS
SELECT
  l.id AS lead_id,
  l.id_unidade,
  l.reactivated_at,
  COALESCE(ag.envios, 0) AS followup_count,
  ag.ultimo_envio,
  CASE
    WHEN l.reactivated_at IS NOT NULL AND l.reactivated_at > now() - interval '14 days'
      THEN true ELSE false
  END AS recently_reactivated,
  ri.ultimo_inbound_apos_followup,
  -- Refinado: inbound novo E sem outbound humano posterior
  (ri.ultimo_inbound_apos_followup IS NOT NULL
   AND ro.ultimo_outbound_humano_apos_inbound IS NULL) AS respondeu_apos_followup
FROM public.leads l
LEFT JOIN (
  SELECT lead_id,
         COUNT(*) FILTER (WHERE status = 'sent') AS envios,
         MAX(sent_at) AS ultimo_envio
    FROM public.automated_message_log
   WHERE template_name LIKE 'followup\_%' ESCAPE '\'
   GROUP BY lead_id
) ag ON ag.lead_id = l.id
LEFT JOIN LATERAL (
  SELECT MAX(COALESCE(m.sent_at, m.created_at)) AS ultimo_inbound_apos_followup
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
   WHERE ag.ultimo_envio IS NOT NULL
     AND c.contact_id = l.id_contact
     AND m.direction = 'inbound'
     AND COALESCE(m.sent_at, m.created_at) > ag.ultimo_envio
) ri ON true
-- 🆕 2o LATERAL: outbound humano (nao-template) APOS o ultimo inbound
LEFT JOIN LATERAL (
  SELECT MAX(COALESCE(m.sent_at, m.created_at)) AS ultimo_outbound_humano_apos_inbound
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
   WHERE ri.ultimo_inbound_apos_followup IS NOT NULL
     AND c.contact_id = l.id_contact
     AND m.direction = 'outbound'
     AND m.type <> 'template'
     AND COALESCE(m.sent_at, m.created_at) > ri.ultimo_inbound_apos_followup
) ro ON true;

GRANT SELECT ON public.lead_followup_summary TO authenticated;
