-- ================================================================
-- ONDA 7 — Performance fix de policies em tabelas filhas
-- ================================================================
-- Problema descoberto via EXPLAIN ANALYZE:
--   - Policy de messages chama subquery em conversations
--   - Subquery sofre RLS recursiva da policy de conversations
--   - Resultado: user_can_access_unit avaliado 2x por conversation
--     × 11k conversations = ~3860ms para 1000 messages
--   - PostgREST timeout (60s) → fetchAll engole erro → dashboard zerado
--
-- Solução:
--   1) Helpers SECURITY DEFINER que bypassam RLS de conversations/contacts
--      e retornam apenas os IDs acessíveis ao user atual.
--   2) Policies short-circuit: se admin, true imediato (escalar cacheado).
--      Senão, IN (lista pré-computada) — hashed subplan O(1) por linha.
-- ================================================================

-- ----------------------------------------------------------------
-- 7.1) Helpers que bypassam RLS recursiva
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_accessible_conversation_ids()
RETURNS SETOF bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.id FROM conversations c
  WHERE c.unit_id IS NULL
     OR c.unit_id IN (SELECT public.user_unit_ids())
$$;

CREATE OR REPLACE FUNCTION public.user_accessible_contact_ids()
RETURNS SETOF bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.id FROM contacts c
  WHERE c.unit_id IS NULL
     OR c.unit_id IN (SELECT public.user_unit_ids())
$$;

GRANT EXECUTE ON FUNCTION public.user_accessible_conversation_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_accessible_contact_ids()      TO authenticated;

-- ----------------------------------------------------------------
-- 7.2) Reescrever policies de messages (PK uuid, FK conversation_id bigint)
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "messages_select" ON public.messages;
DROP POLICY IF EXISTS "messages_insert" ON public.messages;
DROP POLICY IF EXISTS "messages_update" ON public.messages;
DROP POLICY IF EXISTS "messages_delete" ON public.messages;

CREATE POLICY "messages_select" ON public.messages FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "messages_insert" ON public.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "messages_update" ON public.messages FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "messages_delete" ON public.messages FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ----------------------------------------------------------------
-- 7.3) Reescrever policies de conversation_events
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "conversation_events_select" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_insert" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_update" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_delete" ON public.conversation_events;

CREATE POLICY "conversation_events_select" ON public.conversation_events FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_events_insert" ON public.conversation_events FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_events_update" ON public.conversation_events FOR UPDATE
  TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

CREATE POLICY "conversation_events_delete" ON public.conversation_events FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ----------------------------------------------------------------
-- 7.4) Reescrever policies de conversation_tags
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "conversation_tags_select" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_insert" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_update" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_delete" ON public.conversation_tags;

CREATE POLICY "conversation_tags_select" ON public.conversation_tags FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_tags_insert" ON public.conversation_tags FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_tags_update" ON public.conversation_tags FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_tags_delete" ON public.conversation_tags FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

-- ----------------------------------------------------------------
-- 7.5) Reescrever policies de conversation_assignments
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "conversation_assignments_select" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_insert" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_update" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_delete" ON public.conversation_assignments;

CREATE POLICY "conversation_assignments_select" ON public.conversation_assignments FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_assignments_insert" ON public.conversation_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_assignments_update" ON public.conversation_assignments FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "conversation_assignments_delete" ON public.conversation_assignments FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ----------------------------------------------------------------
-- 7.6) Reescrever policies de contact_tags (pai = contacts)
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "contact_tags_select" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_insert" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_update" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_delete" ON public.contact_tags;

CREATE POLICY "contact_tags_select" ON public.contact_tags FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  );

CREATE POLICY "contact_tags_insert" ON public.contact_tags FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  );

CREATE POLICY "contact_tags_update" ON public.contact_tags FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  );

CREATE POLICY "contact_tags_delete" ON public.contact_tags FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  );

-- ----------------------------------------------------------------
-- 7.7) Reescrever policies de contact_notes
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "contact_notes_select" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_insert" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_update" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_delete" ON public.contact_notes;

CREATE POLICY "contact_notes_select" ON public.contact_notes FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  );

CREATE POLICY "contact_notes_insert" ON public.contact_notes FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  );

CREATE POLICY "contact_notes_update" ON public.contact_notes FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR contact_id IN (SELECT public.user_accessible_contact_ids())
  );

CREATE POLICY "contact_notes_delete" ON public.contact_notes FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ----------------------------------------------------------------
-- 7.8) Reescrever policies de scheduled_callbacks
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "scheduled_callbacks_select" ON public.scheduled_callbacks;
DROP POLICY IF EXISTS "scheduled_callbacks_insert" ON public.scheduled_callbacks;
DROP POLICY IF EXISTS "scheduled_callbacks_update" ON public.scheduled_callbacks;
DROP POLICY IF EXISTS "scheduled_callbacks_delete" ON public.scheduled_callbacks;

CREATE POLICY "scheduled_callbacks_select" ON public.scheduled_callbacks FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "scheduled_callbacks_insert" ON public.scheduled_callbacks FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "scheduled_callbacks_update" ON public.scheduled_callbacks FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR conversation_id IN (SELECT public.user_accessible_conversation_ids())
  );

CREATE POLICY "scheduled_callbacks_delete" ON public.scheduled_callbacks FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ----------------------------------------------------------------
-- 7.9) message_status_events (depende de messages)
-- (vazia hoje — mas preparar)
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "message_status_events_select" ON public.message_status_events;

CREATE POLICY "message_status_events_select" ON public.message_status_events FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_status_events.message_id
        AND m.conversation_id IN (SELECT public.user_accessible_conversation_ids())
    )
  );

-- ----------------------------------------------------------------
-- 7.10) Otimizar policies de contacts e conversations (unit_id direto)
--       Inline para evitar overhead da função user_can_access_unit
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "contacts_select" ON public.contacts;
DROP POLICY IF EXISTS "contacts_insert" ON public.contacts;
DROP POLICY IF EXISTS "contacts_update" ON public.contacts;

CREATE POLICY "contacts_select" ON public.contacts FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  );

CREATE POLICY "contacts_insert" ON public.contacts FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  );

CREATE POLICY "contacts_update" ON public.contacts FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  );

DROP POLICY IF EXISTS "conversations_select" ON public.conversations;
DROP POLICY IF EXISTS "conversations_insert" ON public.conversations;
DROP POLICY IF EXISTS "conversations_update" ON public.conversations;

CREATE POLICY "conversations_select" ON public.conversations FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  );

CREATE POLICY "conversations_insert" ON public.conversations FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  );

CREATE POLICY "conversations_update" ON public.conversations FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR unit_id IS NULL
    OR unit_id IN (SELECT public.user_unit_ids())
  );

-- ----------------------------------------------------------------
-- 7.11) Mesma otimização para leads
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "leads_select_policy" ON public.leads;
DROP POLICY IF EXISTS "leads_insert_policy" ON public.leads;
DROP POLICY IF EXISTS "leads_update_policy" ON public.leads;
DROP POLICY IF EXISTS "leads_delete_policy" ON public.leads;

CREATE POLICY "leads_select_policy" ON public.leads FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR id_unidade IS NULL
    OR id_unidade IN (SELECT public.user_unit_ids())
  );

CREATE POLICY "leads_insert_policy" ON public.leads FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR id_unidade IS NULL
    OR id_unidade IN (SELECT public.user_unit_ids())
  );

CREATE POLICY "leads_update_policy" ON public.leads FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR id_unidade IS NULL
    OR id_unidade IN (SELECT public.user_unit_ids())
  )
  WITH CHECK (
    (SELECT public.is_admin_user())
    OR id_unidade IS NULL
    OR id_unidade IN (SELECT public.user_unit_ids())
  );

CREATE POLICY "leads_delete_policy" ON public.leads FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_admin_user())
    OR id_unidade IS NULL
    OR id_unidade IN (SELECT public.user_unit_ids())
  );

-- ================================================================
-- VERIFICAÇÃO PÓS-APLICAÇÃO
-- ================================================================

-- Esperado: agora EXPLAIN deve mostrar tempo < 100ms para admin
-- (curto-circuita via is_admin_user() escalar)
