-- ================================================================
-- ONDA 2 — Lookups e tabelas de perfil (baixo risco)
-- ================================================================
-- Tabelas: units, cargos, tags, profiles, profile_units,
--          unit_memberships, profile_events, "User", kv_store_844b77a1
--
-- Pré-requisito: Onda 1 aplicada (is_admin_user, user_can_access_unit).
-- Idempotente: DROP POLICY IF EXISTS antes de cada CREATE POLICY.
-- ================================================================

-- ================================================================
-- 2.1) units — todos autenticados leem; só admin escreve
-- ================================================================
ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "units_select" ON public.units;
DROP POLICY IF EXISTS "units_insert" ON public.units;
DROP POLICY IF EXISTS "units_update" ON public.units;
DROP POLICY IF EXISTS "units_delete" ON public.units;

CREATE POLICY "units_select" ON public.units FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "units_insert" ON public.units FOR INSERT
  TO authenticated WITH CHECK (public.is_admin_user());

CREATE POLICY "units_update" ON public.units FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

CREATE POLICY "units_delete" ON public.units FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 2.2) cargos — todos autenticados leem; só admin escreve
-- ================================================================
ALTER TABLE public.cargos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cargos_select" ON public.cargos;
DROP POLICY IF EXISTS "cargos_insert" ON public.cargos;
DROP POLICY IF EXISTS "cargos_update" ON public.cargos;
DROP POLICY IF EXISTS "cargos_delete" ON public.cargos;

CREATE POLICY "cargos_select" ON public.cargos FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "cargos_insert" ON public.cargos FOR INSERT
  TO authenticated WITH CHECK (public.is_admin_user());

CREATE POLICY "cargos_update" ON public.cargos FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

CREATE POLICY "cargos_delete" ON public.cargos FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 2.3) tags — todos autenticados leem e CRUD
-- (tabela vazia hoje; tags são compartilhadas globalmente entre unidades)
-- ================================================================
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tags_select" ON public.tags;
DROP POLICY IF EXISTS "tags_insert" ON public.tags;
DROP POLICY IF EXISTS "tags_update" ON public.tags;
DROP POLICY IF EXISTS "tags_delete" ON public.tags;

CREATE POLICY "tags_select" ON public.tags FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "tags_insert" ON public.tags FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "tags_update" ON public.tags FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "tags_delete" ON public.tags FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 2.4) profiles — leitura aberta para autenticados (necessária para JOINs)
--       UPDATE: self ou admin. INSERT/DELETE: só admin.
-- ================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_delete" ON public.profiles;

-- SELECT aberto: ChatView, ConversationList, LeadHistory, NotificationContext
-- todos fazem JOIN com profiles para mostrar nome/avatar do assigned_user.
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT
  TO authenticated USING (true);

-- INSERT: signup vai pelo Supabase Auth + trigger; só admin manualmente.
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT
  TO authenticated WITH CHECK (public.is_admin_user());

-- UPDATE: usuário edita o próprio perfil; admin edita qualquer.
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid() OR public.is_admin_user())
  WITH CHECK (id = auth.uid() OR public.is_admin_user());

CREATE POLICY "profiles_delete" ON public.profiles FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 2.5) profile_units — usuário vê só as próprias; admin escreve
-- ================================================================
ALTER TABLE public.profile_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profile_units_select" ON public.profile_units;
DROP POLICY IF EXISTS "profile_units_insert" ON public.profile_units;
DROP POLICY IF EXISTS "profile_units_update" ON public.profile_units;
DROP POLICY IF EXISTS "profile_units_delete" ON public.profile_units;

CREATE POLICY "profile_units_select" ON public.profile_units FOR SELECT
  TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin_user());

CREATE POLICY "profile_units_insert" ON public.profile_units FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin_user());

CREATE POLICY "profile_units_update" ON public.profile_units FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

CREATE POLICY "profile_units_delete" ON public.profile_units FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 2.6) unit_memberships — vazia hoje, padrão coerente
-- (esta tabela usa user_id, não profile_id — schema diferente do
--  profile_units que é a fonte canônica)
-- ================================================================
ALTER TABLE public.unit_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_memberships" ON public.unit_memberships;
DROP POLICY IF EXISTS "unit_memberships_select" ON public.unit_memberships;
DROP POLICY IF EXISTS "unit_memberships_insert" ON public.unit_memberships;
DROP POLICY IF EXISTS "unit_memberships_update" ON public.unit_memberships;
DROP POLICY IF EXISTS "unit_memberships_delete" ON public.unit_memberships;

CREATE POLICY "unit_memberships_select" ON public.unit_memberships FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_user());

CREATE POLICY "unit_memberships_insert" ON public.unit_memberships FOR INSERT
  TO authenticated WITH CHECK (public.is_admin_user());

CREATE POLICY "unit_memberships_update" ON public.unit_memberships FOR UPDATE
  TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

CREATE POLICY "unit_memberships_delete" ON public.unit_memberships FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 2.7) profile_events — usuário só lê/escreve os próprios eventos
-- (72k linhas — é a maior tabela; filtro por user_id é eficiente)
-- ================================================================
ALTER TABLE public.profile_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profile_events_select" ON public.profile_events;
DROP POLICY IF EXISTS "profile_events_insert" ON public.profile_events;
DROP POLICY IF EXISTS "profile_events_update" ON public.profile_events;
DROP POLICY IF EXISTS "profile_events_delete" ON public.profile_events;

CREATE POLICY "profile_events_select" ON public.profile_events FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_user());

CREATE POLICY "profile_events_insert" ON public.profile_events FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "profile_events_update" ON public.profile_events FOR UPDATE
  TO authenticated
  USING (public.is_admin_user())
  WITH CHECK (public.is_admin_user());

CREATE POLICY "profile_events_delete" ON public.profile_events FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 2.8) "User" (legacy/vazia) — deny all para anon-key (service_role bypassa)
-- ================================================================
-- RLS já está habilitado. Adiciona policy explícita "deny all".
ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_deny_all" ON public."User";

CREATE POLICY "user_deny_all" ON public."User" FOR ALL
  TO authenticated USING (false) WITH CHECK (false);

-- ================================================================
-- 2.9) kv_store_844b77a1 — só service_role (deny all para authenticated)
-- ================================================================
ALTER TABLE public.kv_store_844b77a1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kv_store_deny_all" ON public.kv_store_844b77a1;

CREATE POLICY "kv_store_deny_all" ON public.kv_store_844b77a1 FOR ALL
  TO authenticated USING (false) WITH CHECK (false);

-- ================================================================
-- VERIFICAÇÃO
-- ================================================================

-- 2.A) Confirmar RLS ativo nas 9 tabelas
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'units', 'cargos', 'tags', 'profiles', 'profile_units',
    'unit_memberships', 'profile_events', 'User', 'kv_store_844b77a1'
  )
ORDER BY tablename;

-- 2.B) Listar policies criadas
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'units', 'cargos', 'tags', 'profiles', 'profile_units',
    'unit_memberships', 'profile_events', 'User', 'kv_store_844b77a1'
  )
ORDER BY tablename, policyname;

-- ================================================================
-- TESTE FUNCIONAL (no app):
--   - Login como Atendente: dashboard carrega? avatar/nome do
--     assigned_user em conversas continua aparecendo?
--   - Login como Admin: ConfigModule lista profiles? consegue
--     editar usuário?
--   - usePresence: gravação de status continua funcionando?
--     (verifique inserts em profile_events com user_id = self)
-- ================================================================
