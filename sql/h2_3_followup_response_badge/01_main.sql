-- ============================================================
-- BlueDesk H2.3 — Sinalizacao "cliente respondeu ao follow-up"
-- ============================================================
-- Estende a view lead_followup_summary com 2 novos campos:
--   - respondeu_apos_followup (boolean)
--   - ultimo_inbound_apos_followup (timestamptz)
--
-- Detecta se o cliente mandou alguma mensagem inbound DEPOIS do
-- ultimo envio automatico de template (followup_*) deste lead.
--
-- Usado pelo Kanban (LeadCard) para mostrar emoji de foguinho e
-- empurrar esses cards para o topo da coluna, evitando que o
-- operador perca a resposta numa coluna com 400+ cards.
-- ============================================================

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
  END AS recently_reactivated,
  -- 🆕 H2.3: timestamp do ultimo inbound APOS o ultimo envio automatico
  ri.ultimo_inbound_apos_followup,
  -- 🆕 H2.3: flag para o card (🔥) + ordenacao
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
  -- Pega o ultimo inbound posterior ao ultimo envio do follow-up.
  -- Filtros indexados: conversations.contact_id, messages (conversation_id, sent_at).
  -- Roda so quando ag.ultimo_envio nao for null (curto-circuito via WHERE).
  SELECT MAX(COALESCE(m.sent_at, m.created_at)) AS ultimo_inbound_apos_followup
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
   WHERE ag.ultimo_envio IS NOT NULL
     AND c.contact_id = l.id_contact
     AND m.direction = 'inbound'
     AND COALESCE(m.sent_at, m.created_at) > ag.ultimo_envio
) ri ON true;

GRANT SELECT ON public.lead_followup_summary TO authenticated;

-- ============================================================
-- Smoke test (opcional, remova antes de commitar em prod):
--
-- SELECT lead_id, followup_count, ultimo_envio,
--        respondeu_apos_followup, ultimo_inbound_apos_followup
--   FROM public.lead_followup_summary
--  WHERE followup_count > 0
--  ORDER BY ultimo_inbound_apos_followup DESC NULLS LAST
--  LIMIT 20;
-- ============================================================
