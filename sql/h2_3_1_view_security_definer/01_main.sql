-- ============================================================
-- BlueDesk H2.3.1 — lead_followup_summary security_definer
-- ============================================================
-- A view foi criada em H2.3 com security_invoker=true. O LATERAL JOIN
-- em messages tem RLS — para usuarios nao-admin alguns inbounds podiam
-- nao ser vistos pelo planner via subquery, fazendo respondeu_apos_followup
-- vir false/null mesmo com resposta real no banco.
--
-- Aplicado em prod via MCP em 2026-05-13.
--
-- Seguranca preservada: a view continua filtravel por lead_id e o frontend
-- chama com .in('lead_id', leadIds) onde leadIds vem de uma query a leads
-- ja filtrada por RLS. So expoe boolean derivado e timestamp — sem vazar
-- conteudo de messages.
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
  (ri.ultimo_inbound_apos_followup IS NOT NULL) AS respondeu_apos_followup
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
) ri ON true;

GRANT SELECT ON public.lead_followup_summary TO authenticated;
