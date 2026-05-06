-- ================================================================
-- ONDA 6 — Hardening pós-aplicação
-- ================================================================
-- Resolve warnings do Supabase Advisor após aplicação das ondas 1-5.
-- Idempotente.
-- ================================================================

-- ----------------------------------------------------------------
-- 6.1) scheduled_callbacks tinha RLS habilitado mas SEM policies
-- (deny-all silencioso). Adiciona policies via FK conversations.
-- ----------------------------------------------------------------
ALTER TABLE public.scheduled_callbacks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scheduled_callbacks_select" ON public.scheduled_callbacks;
DROP POLICY IF EXISTS "scheduled_callbacks_insert" ON public.scheduled_callbacks;
DROP POLICY IF EXISTS "scheduled_callbacks_update" ON public.scheduled_callbacks;
DROP POLICY IF EXISTS "scheduled_callbacks_delete" ON public.scheduled_callbacks;

CREATE POLICY "scheduled_callbacks_select" ON public.scheduled_callbacks FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = scheduled_callbacks.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "scheduled_callbacks_insert" ON public.scheduled_callbacks FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = scheduled_callbacks.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "scheduled_callbacks_update" ON public.scheduled_callbacks FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = scheduled_callbacks.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = scheduled_callbacks.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "scheduled_callbacks_delete" ON public.scheduled_callbacks FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ----------------------------------------------------------------
-- 6.2) Restringir search_path nas helpers (SECURITY DEFINER best practice)
-- Evita ataque de search_path hijack — sempre resolve para pg_catalog/public.
-- ----------------------------------------------------------------
ALTER FUNCTION public.is_admin_user()           SET search_path = pg_catalog, public;
ALTER FUNCTION public.user_unit_ids()           SET search_path = pg_catalog, public;
ALTER FUNCTION public.user_can_access_unit(int8) SET search_path = pg_catalog, public;

-- ----------------------------------------------------------------
-- 6.3) Restringir tags_insert e tags_update — eram (true)
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "tags_insert" ON public.tags;
DROP POLICY IF EXISTS "tags_update" ON public.tags;

-- Qualquer atendente pode criar tag nova (compartilhada entre unidades).
-- Isso é razoável para o uso do app, mas exige authenticated genuíno
-- (auth.uid() não é null para um JWT válido).
CREATE POLICY "tags_insert" ON public.tags FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- Update só admin (proteção contra renomear tag em uso por toda a base).
CREATE POLICY "tags_update" ON public.tags FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

-- ----------------------------------------------------------------
-- 6.4) Revogar EXECUTE das helpers do role `anon`
-- O app não tem fluxo anônimo. Apenas authenticated precisa.
-- ----------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.is_admin_user()           FROM anon;
REVOKE EXECUTE ON FUNCTION public.user_unit_ids()           FROM anon;
REVOKE EXECUTE ON FUNCTION public.user_can_access_unit(int8) FROM anon;

-- ----------------------------------------------------------------
-- VERIFICAÇÃO
-- ----------------------------------------------------------------
-- Confirmar policies de scheduled_callbacks
SELECT policyname, cmd FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'scheduled_callbacks'
ORDER BY policyname;

-- Confirmar search_path nas funções
SELECT proname, proconfig
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('is_admin_user', 'user_unit_ids', 'user_can_access_unit');

-- Confirmar grants
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN ('is_admin_user', 'user_unit_ids', 'user_can_access_unit')
ORDER BY routine_name, grantee;
