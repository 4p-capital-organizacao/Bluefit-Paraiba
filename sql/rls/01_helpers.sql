-- ================================================================
-- ONDA 1 — Helpers SQL e correção de bug
-- ================================================================
-- BLOCO IDEMPOTENTE: pode rodar 2x sem erro.
-- Não altera dados. Só (re)cria funções.
--
-- O QUE MUDA:
--   1) is_admin_user() corrige bug ARRAY[1, 5] -> ARRAY[5]
--      (id_cargo=1 é "Sem cargo", não admin)
--   2) Cria user_unit_ids() — multi-unit via profile_units
--   3) Cria user_can_access_unit(p_unit_id) — helper boolean
--   4) Mantém get_user_unit_id() temporariamente (será dropada na Onda 5)
-- ================================================================

-- ----------------------------------------------------------------
-- 1.1) is_admin_user() — BUGFIX
-- ----------------------------------------------------------------
-- Antes: ARRAY[1, 5] dava bypass para usuários "Sem cargo".
-- Agora: apenas id_cargo=5 (Administrador).
-- LANGUAGE sql STABLE permite o planner cachear o resultado por linha
-- dentro de uma mesma query — crítico para performance de policies.
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND id_cargo = 5
  );
$$;

-- ----------------------------------------------------------------
-- 1.2) user_unit_ids() — fonte de verdade multi-unit
-- ----------------------------------------------------------------
-- profile_units é a tabela canônica (36 rows = 1 por usuário).
-- profiles.id_unidade é mantido como fallback (unidade primária).
-- UNION evita duplicatas se ambos apontarem pra mesma unidade.
CREATE OR REPLACE FUNCTION public.user_unit_ids()
RETURNS SETOF int8
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT unit_id FROM public.profile_units
   WHERE profile_id = auth.uid()
  UNION
  SELECT id_unidade FROM public.profiles
   WHERE id = auth.uid()
     AND id_unidade IS NOT NULL;
$$;

-- ----------------------------------------------------------------
-- 1.3) user_can_access_unit(p_unit_id) — helper para policies
-- ----------------------------------------------------------------
-- Regras:
--   - admin sempre true
--   - unit NULL é considerada acessível (registros órfãos / globais)
--   - se unit_id está em user_unit_ids(), ok
CREATE OR REPLACE FUNCTION public.user_can_access_unit(p_unit_id int8)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    public.is_admin_user()
    OR p_unit_id IS NULL
    OR p_unit_id IN (SELECT public.user_unit_ids());
$$;

-- ----------------------------------------------------------------
-- 1.4) Garantir GRANT EXECUTE (necessário para policies usarem em runtime)
-- ----------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.is_admin_user()           TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.user_unit_ids()           TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.user_can_access_unit(int8) TO authenticated, anon;

-- ================================================================
-- VERIFICAÇÃO
-- ================================================================

-- 1.A) Confirmar que admin é só id_cargo=5
-- (rode logado como admin via app; via SQL direto auth.uid() é null)
SELECT public.is_admin_user() AS sou_admin;

-- 1.B) Conferir as funções
SELECT proname, prorettype::regtype AS retorno, prosecdef AS sec_def
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('is_admin_user', 'user_unit_ids', 'user_can_access_unit', 'get_user_unit_id')
ORDER BY proname;

-- ================================================================
-- ROLLBACK (se precisar reverter):
--   Para voltar ao bug antigo (NÃO RECOMENDADO):
--     CREATE OR REPLACE FUNCTION public.is_admin_user() ...
--     -- com ARRAY[1, 5]
--   As novas funções podem ficar — não quebram nada.
-- ================================================================
