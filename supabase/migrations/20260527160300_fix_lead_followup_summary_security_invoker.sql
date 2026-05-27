-- View estava com security_invoker=false (= SECURITY DEFINER): executava com
-- as permissões do owner, bypassando RLS do usuário consultando.
--
-- As 4 tabelas subjacentes (leads, automated_message_log, messages,
-- conversations) já têm RLS por unidade. Switch pra SECURITY INVOKER faz a
-- view respeitar essas mesmas regras, mantendo a mesma quantidade de dados
-- visíveis para cada usuário (mas auditável).
ALTER VIEW public.lead_followup_summary SET (security_invoker = true);
