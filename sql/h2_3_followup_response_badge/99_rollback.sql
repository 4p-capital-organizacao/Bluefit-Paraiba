-- ============================================================
-- Rollback H2.3 — restaura lead_followup_summary ao estado H2.2
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
  END AS recently_reactivated
FROM public.leads l
LEFT JOIN (
  SELECT lead_id, COUNT(*) FILTER (WHERE status = 'sent') AS envios, MAX(sent_at) AS ultimo_envio
    FROM public.automated_message_log
   WHERE template_name LIKE 'followup\_%' ESCAPE '\'
   GROUP BY lead_id
) ag ON ag.lead_id = l.id;

GRANT SELECT ON public.lead_followup_summary TO authenticated;
