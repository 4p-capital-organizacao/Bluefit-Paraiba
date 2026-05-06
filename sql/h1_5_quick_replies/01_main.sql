-- ============================================================
-- BlueDesk H1.5 — Snippets dinamicos (canned responses)
-- ============================================================
-- Tabela quick_replies persistida em Supabase (substitui localStorage do
-- QuickReplies.tsx orfao). Suporta escopo global (unit_id NULL, admin only)
-- e por unidade (supervisor+ da unidade pode editar).
-- Atendentes consomem (SELECT) e incrementam usage_count via RPC.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.quick_replies (
  id bigserial PRIMARY KEY,
  unit_id bigint REFERENCES public.units(id) ON DELETE CASCADE,  -- NULL = global
  category text NOT NULL DEFAULT 'geral' CHECK (category IN ('saudacao','visita','cobranca','aniversario','duvida','encerramento','geral')),
  title text NOT NULL,
  body text NOT NULL,
  is_global_favorite boolean NOT NULL DEFAULT false,
  usage_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quick_replies_unit ON public.quick_replies(unit_id);
CREATE INDEX IF NOT EXISTS idx_quick_replies_category ON public.quick_replies(category);
CREATE INDEX IF NOT EXISTS idx_quick_replies_favorite ON public.quick_replies(is_global_favorite) WHERE is_global_favorite = true;

-- updated_at automatico
DROP TRIGGER IF EXISTS trg_quick_replies_updated_at ON public.quick_replies;
CREATE TRIGGER trg_quick_replies_updated_at
  BEFORE UPDATE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.quick_replies ENABLE ROW LEVEL SECURITY;

-- SELECT: todos os autenticados veem globais + os da propria unidade
DROP POLICY IF EXISTS quick_replies_select ON public.quick_replies;
CREATE POLICY quick_replies_select ON public.quick_replies FOR SELECT
  USING (
    unit_id IS NULL
    OR public.is_admin_user()
    OR unit_id IN (SELECT public.user_unit_ids())
  );

-- INSERT: supervisor+ (cargo>=3) na unidade; global so admin (Administrador, cargo 5)
DROP POLICY IF EXISTS quick_replies_insert ON public.quick_replies;
CREATE POLICY quick_replies_insert ON public.quick_replies FOR INSERT
  WITH CHECK (
    (
      unit_id IS NOT NULL
      AND public.current_profile_cargo_level() >= 3
      AND (public.is_admin_user() OR unit_id IN (SELECT public.user_unit_ids()))
    )
    OR
    (
      unit_id IS NULL
      AND public.current_profile_cargo_level() >= 5
    )
  );

-- UPDATE: mesmas regras do INSERT (e o usage_count vai por RPC, nao por UPDATE direto)
DROP POLICY IF EXISTS quick_replies_update ON public.quick_replies;
CREATE POLICY quick_replies_update ON public.quick_replies FOR UPDATE
  USING (
    (
      unit_id IS NOT NULL
      AND public.current_profile_cargo_level() >= 3
      AND (public.is_admin_user() OR unit_id IN (SELECT public.user_unit_ids()))
    )
    OR
    (
      unit_id IS NULL
      AND public.current_profile_cargo_level() >= 5
    )
  )
  WITH CHECK (
    (
      unit_id IS NOT NULL
      AND public.current_profile_cargo_level() >= 3
      AND (public.is_admin_user() OR unit_id IN (SELECT public.user_unit_ids()))
    )
    OR
    (
      unit_id IS NULL
      AND public.current_profile_cargo_level() >= 5
    )
  );

DROP POLICY IF EXISTS quick_replies_delete ON public.quick_replies;
CREATE POLICY quick_replies_delete ON public.quick_replies FOR DELETE
  USING (
    (
      unit_id IS NOT NULL
      AND public.current_profile_cargo_level() >= 3
      AND (public.is_admin_user() OR unit_id IN (SELECT public.user_unit_ids()))
    )
    OR
    (
      unit_id IS NULL
      AND public.current_profile_cargo_level() >= 5
    )
  );

-- RPC: incrementar usage_count (atendente sem permissao de UPDATE direto)
CREATE OR REPLACE FUNCTION public.increment_quick_reply_usage(p_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  -- Caller precisa ter cargo valido (>=2)
  IF public.current_profile_cargo_level() < 2 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Increment usage; respeita escopo (global ou da unidade do caller)
  UPDATE public.quick_replies
     SET usage_count = usage_count + 1
   WHERE id = p_id
     AND (
       unit_id IS NULL
       OR public.is_admin_user()
       OR unit_id IN (SELECT public.user_unit_ids())
     );
END;
$$;
REVOKE ALL ON FUNCTION public.increment_quick_reply_usage(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_quick_reply_usage(bigint) TO authenticated;

-- Seeds opcionais (snippets globais base)
INSERT INTO public.quick_replies (unit_id, category, title, body, is_global_favorite)
VALUES
  (NULL, 'saudacao',    'Saudação',
   'Olá {{primeiro_nome}}! Aqui é {{nome_consultor}} da Bluefit {{unidade}}. Em que posso ajudar?',
   true),
  (NULL, 'visita',      'Confirmar visita',
   'Oi {{primeiro_nome}}, posso confirmar sua visita na Bluefit {{unidade}}? É só me dizer um horário que melhor te atenda.',
   true),
  (NULL, 'duvida',      'Aguardar verificação',
   'Aguarde só um instante {{primeiro_nome}}, vou verificar essa informação para você.',
   false),
  (NULL, 'encerramento','Encerrar atendimento',
   'Foi um prazer falar com você, {{primeiro_nome}}! Qualquer dúvida estou à disposição. — {{nome_consultor}}',
   true),
  (NULL, 'duvida',      'Horário de atendimento',
   'Nosso horário de atendimento é {{horario_atendimento}}. Caso precise fora desse horário, me chama por aqui que respondo assim que possível!',
   false)
ON CONFLICT DO NOTHING;
