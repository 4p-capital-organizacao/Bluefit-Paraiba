-- ================================================================
-- ONDA 5 — Atualizar policies de leads e lead_history para multi-unit
-- ================================================================
-- Objetivo: substituir get_user_unit_id() (single-unit) por
-- user_can_access_unit(p_unit_id) (multi-unit + admin).
--
-- Pré-requisito: Onda 1 aplicada.
-- Idempotente: DROP IF EXISTS antes de CREATE.
-- ================================================================

-- ================================================================
-- 5.1) leads — substituir 4 policies
-- ================================================================
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leads_select_policy" ON public.leads;
DROP POLICY IF EXISTS "leads_insert_policy" ON public.leads;
DROP POLICY IF EXISTS "leads_update_policy" ON public.leads;
DROP POLICY IF EXISTS "leads_delete_policy" ON public.leads;
-- Limpar nomes alternativos legados (de setup_rls_completo.sql)
DROP POLICY IF EXISTS "users_read_own_unit_leads" ON public.leads;
DROP POLICY IF EXISTS "users_insert_own_unit_leads" ON public.leads;
DROP POLICY IF EXISTS "users_update_own_unit_leads" ON public.leads;
DROP POLICY IF EXISTS "users_delete_own_unit_leads" ON public.leads;

CREATE POLICY "leads_select_policy" ON public.leads FOR SELECT
  TO authenticated
  USING (public.user_can_access_unit(id_unidade));

CREATE POLICY "leads_insert_policy" ON public.leads FOR INSERT
  TO authenticated
  WITH CHECK (public.user_can_access_unit(id_unidade));

CREATE POLICY "leads_update_policy" ON public.leads FOR UPDATE
  TO authenticated
  USING (public.user_can_access_unit(id_unidade))
  WITH CHECK (public.user_can_access_unit(id_unidade));

CREATE POLICY "leads_delete_policy" ON public.leads FOR DELETE
  TO authenticated
  USING (public.user_can_access_unit(id_unidade));

-- ================================================================
-- 5.2) lead_history — substituir via subquery em leads
-- ================================================================
ALTER TABLE public.lead_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_history_select_policy" ON public.lead_history;
DROP POLICY IF EXISTS "lead_history_insert_policy" ON public.lead_history;
DROP POLICY IF EXISTS "users_read_own_unit_lead_history" ON public.lead_history;
DROP POLICY IF EXISTS "users_insert_lead_history" ON public.lead_history;

CREATE POLICY "lead_history_select_policy" ON public.lead_history FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.id = lead_history.lead_id
        AND public.user_can_access_unit(l.id_unidade)
    )
  );

CREATE POLICY "lead_history_insert_policy" ON public.lead_history FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.id = lead_history.lead_id
        AND public.user_can_access_unit(l.id_unidade)
    )
  );

-- ================================================================
-- 5.3) (opcional) drop get_user_unit_id() — só se nada mais a usa
-- ================================================================
-- Validar primeiro:
SELECT proname, pg_get_functiondef(oid)
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'get_user_unit_id';

-- Se confirmado que nenhuma outra policy/function usa, descomente:
-- DROP FUNCTION IF EXISTS public.get_user_unit_id();

-- ================================================================
-- VERIFICAÇÃO
-- ================================================================

-- 5.A) Confirmar policies novas
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('leads', 'lead_history')
ORDER BY tablename, policyname;

-- 5.B) Smoke test: usuário multi-unit deve ver leads de TODAS as unidades dele
-- (rode no app — CRMView)
-- Antes: filtro `id_unidade = primary_unit` cortava unidades secundárias.
-- Depois: helper considera profile_units (todas).

-- ================================================================
-- TESTE FUNCIONAL:
--   1) Usuário com 2+ unidades em profile_units:
--      - CRMView mostra leads de AMBAS as unidades
--      - LeadFormDialog cria lead em qualquer unidade dele
--      - DeleteLeadDialog deleta lead de qualquer unidade dele
--   2) Atendente sem multi-unit: comportamento idêntico ao anterior
--   3) Admin: vê todos os leads (isso já era — não regrediu)
--   4) lead_history em LeadHistory.tsx: histórico carrega corretamente
-- ================================================================
