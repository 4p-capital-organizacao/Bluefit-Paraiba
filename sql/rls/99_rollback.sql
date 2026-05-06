-- ================================================================
-- ROLLBACK COMPLETO — desabilita RLS e dropa policies das ondas 2–4
-- ================================================================
-- Use SOMENTE em emergência (algo quebrou em produção).
-- Para reverter UMA onda específica, copie só o bloco correspondente.
--
-- O que ESTE script NÃO faz:
--   - Não reverte a correção de is_admin_user() (Onda 1).
--     Isso é um bugfix, não deve ser revertido.
--   - Não dropa user_unit_ids() / user_can_access_unit().
--     São helpers — podem ficar, sem efeito sem policies.
--   - Não toca nas policies pré-existentes de leads/lead_history que
--     não venham da Onda 5. Se a Onda 5 foi aplicada e quebrou,
--     veja o bloco específico no final.
-- ================================================================

-- ----------------------------------------------------------------
-- ONDA 4 — Tabelas filhas
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "messages_select" ON public.messages;
DROP POLICY IF EXISTS "messages_insert" ON public.messages;
DROP POLICY IF EXISTS "messages_update" ON public.messages;
DROP POLICY IF EXISTS "messages_delete" ON public.messages;
ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_events_select" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_insert" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_update" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_delete" ON public.conversation_events;
ALTER TABLE public.conversation_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_tags_select" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_insert" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_update" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_delete" ON public.conversation_tags;
ALTER TABLE public.conversation_tags DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_assignments_select" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_insert" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_update" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_delete" ON public.conversation_assignments;
ALTER TABLE public.conversation_assignments DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contact_tags_select" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_insert" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_update" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_delete" ON public.contact_tags;
ALTER TABLE public.contact_tags DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contact_notes_select" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_insert" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_update" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_delete" ON public.contact_notes;
ALTER TABLE public.contact_notes DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "message_status_events_select" ON public.message_status_events;
DROP POLICY IF EXISTS "message_status_events_insert" ON public.message_status_events;
DROP POLICY IF EXISTS "message_status_events_update" ON public.message_status_events;
DROP POLICY IF EXISTS "message_status_events_delete" ON public.message_status_events;
ALTER TABLE public.message_status_events DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------
-- ONDA 3 — contacts, conversations
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "contacts_select" ON public.contacts;
DROP POLICY IF EXISTS "contacts_insert" ON public.contacts;
DROP POLICY IF EXISTS "contacts_update" ON public.contacts;
DROP POLICY IF EXISTS "contacts_delete" ON public.contacts;
ALTER TABLE public.contacts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations_select" ON public.conversations;
DROP POLICY IF EXISTS "conversations_insert" ON public.conversations;
DROP POLICY IF EXISTS "conversations_update" ON public.conversations;
DROP POLICY IF EXISTS "conversations_delete" ON public.conversations;
ALTER TABLE public.conversations DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------
-- ONDA 2 — Lookups e profiles
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "units_select" ON public.units;
DROP POLICY IF EXISTS "units_insert" ON public.units;
DROP POLICY IF EXISTS "units_update" ON public.units;
DROP POLICY IF EXISTS "units_delete" ON public.units;
ALTER TABLE public.units DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cargos_select" ON public.cargos;
DROP POLICY IF EXISTS "cargos_insert" ON public.cargos;
DROP POLICY IF EXISTS "cargos_update" ON public.cargos;
DROP POLICY IF EXISTS "cargos_delete" ON public.cargos;
ALTER TABLE public.cargos DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tags_select" ON public.tags;
DROP POLICY IF EXISTS "tags_insert" ON public.tags;
DROP POLICY IF EXISTS "tags_update" ON public.tags;
DROP POLICY IF EXISTS "tags_delete" ON public.tags;
ALTER TABLE public.tags DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_delete" ON public.profiles;
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profile_units_select" ON public.profile_units;
DROP POLICY IF EXISTS "profile_units_insert" ON public.profile_units;
DROP POLICY IF EXISTS "profile_units_update" ON public.profile_units;
DROP POLICY IF EXISTS "profile_units_delete" ON public.profile_units;
ALTER TABLE public.profile_units DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "unit_memberships_select" ON public.unit_memberships;
DROP POLICY IF EXISTS "unit_memberships_insert" ON public.unit_memberships;
DROP POLICY IF EXISTS "unit_memberships_update" ON public.unit_memberships;
DROP POLICY IF EXISTS "unit_memberships_delete" ON public.unit_memberships;
-- unit_memberships já tinha RLS antes da Onda 2; deixar habilitado.
-- Se quiser desabilitar, descomente:
-- ALTER TABLE public.unit_memberships DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profile_events_select" ON public.profile_events;
DROP POLICY IF EXISTS "profile_events_insert" ON public.profile_events;
DROP POLICY IF EXISTS "profile_events_update" ON public.profile_events;
DROP POLICY IF EXISTS "profile_events_delete" ON public.profile_events;
ALTER TABLE public.profile_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_deny_all" ON public."User";
-- "User" tinha RLS antes (deny-all não derruba). Manter habilitado.

DROP POLICY IF EXISTS "kv_store_deny_all" ON public.kv_store_844b77a1;
-- kv_store tinha RLS antes. Manter habilitado.

-- ----------------------------------------------------------------
-- ONDA 5 — REVERTER policies de leads para versão antiga (single-unit)
-- ----------------------------------------------------------------
-- Só execute esta seção se Onda 5 quebrou algo específico.
-- Restaura policies usando get_user_unit_id() (forma anterior).
--
-- DROP POLICY IF EXISTS "leads_select_policy" ON public.leads;
-- CREATE POLICY "leads_select_policy" ON public.leads FOR SELECT
--   USING (
--     public.is_admin_user()
--     OR id_unidade IS NULL
--     OR id_unidade = public.get_user_unit_id()
--   );
-- ... (idem para insert/update/delete e lead_history)

-- ================================================================
-- VERIFICAÇÃO PÓS-ROLLBACK
-- ================================================================
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity DESC, tablename;
