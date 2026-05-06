-- ============================================================
-- BlueDesk — Templates Module (cria\xc3\xa7\xc3\xa3o de templates Meta + permiss\xc3\xb5es)
-- ============================================================
-- Tabela menu_item_permissions: admin define quais cargos veem cada item de menu.
-- RPC user_can_access_module(key) usado por backend (rota templates) e frontend (hook).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.menu_item_permissions (
  id bigserial PRIMARY KEY,
  module_key text NOT NULL UNIQUE,
  required_cargo_levels integer[] NOT NULL DEFAULT '{}',
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_menu_item_permissions_updated_at ON public.menu_item_permissions;
CREATE TRIGGER trg_menu_item_permissions_updated_at
  BEFORE UPDATE ON public.menu_item_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.menu_item_permissions ENABLE ROW LEVEL SECURITY;

-- SELECT: qualquer usu\xc3\xa1rio autenticado pode ler (precisa para o menu lateral)
DROP POLICY IF EXISTS menu_perms_select ON public.menu_item_permissions;
CREATE POLICY menu_perms_select ON public.menu_item_permissions FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- INSERT/UPDATE/DELETE: apenas Administrador (cargo level 5)
DROP POLICY IF EXISTS menu_perms_insert ON public.menu_item_permissions;
CREATE POLICY menu_perms_insert ON public.menu_item_permissions FOR INSERT
  WITH CHECK (public.is_admin_user());

DROP POLICY IF EXISTS menu_perms_update ON public.menu_item_permissions;
CREATE POLICY menu_perms_update ON public.menu_item_permissions FOR UPDATE
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

DROP POLICY IF EXISTS menu_perms_delete ON public.menu_item_permissions;
CREATE POLICY menu_perms_delete ON public.menu_item_permissions FOR DELETE
  USING (public.is_admin_user());

-- Seeds iniciais
INSERT INTO public.menu_item_permissions (module_key, required_cargo_levels, description)
VALUES
  ('templates', '{4,5}', 'Cria\xc3\xa7\xc3\xa3o e gest\xc3\xa3o de templates WhatsApp')
ON CONFLICT (module_key) DO NOTHING;

-- RPC para checar se o caller tem acesso ao m\xc3\xb3dulo
CREATE OR REPLACE FUNCTION public.user_can_access_module(p_module_key text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.menu_item_permissions m
    JOIN public.profiles p ON p.id = auth.uid()
    JOIN public.cargos c ON c.id = p.id_cargo
    WHERE m.module_key = p_module_key
      AND c.level = ANY(m.required_cargo_levels)
  );
$$;

REVOKE ALL ON FUNCTION public.user_can_access_module(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_can_access_module(text) TO authenticated;
