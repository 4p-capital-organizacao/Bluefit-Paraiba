-- ================================================================
-- ONDA 4 — Tabelas filhas (subquery via FK)
-- ================================================================
-- Tabelas: messages (41k), conversation_events (10k),
--          conversation_tags (8k), conversation_assignments (3.7k),
--          contact_tags (10k), contact_notes (58),
--          message_status_events (0)
--
-- Pré-requisitos:
--   - Onda 1 aplicada (user_can_access_unit existe)
--   - Onda 3 aplicada (contacts e conversations já com RLS)
--   - Índices em FKs (validar via 00_preflight.sql §0.7)
--
-- Padrão: filtrar via subquery EXISTS na tabela pai.
-- O Postgres consegue inlinar essa subquery se há índice na FK.
-- ================================================================

-- ================================================================
-- 4.1) messages — via conversations.unit_id
-- ================================================================
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_select" ON public.messages;
DROP POLICY IF EXISTS "messages_insert" ON public.messages;
DROP POLICY IF EXISTS "messages_update" ON public.messages;
DROP POLICY IF EXISTS "messages_delete" ON public.messages;

CREATE POLICY "messages_select" ON public.messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

-- INSERT: webhook (service_role) bypassa. Front-end também insere
-- via send-message-endpoint (service_role na edge function).
-- Esta policy só protege contra anon-key tentando inserir direto.
CREATE POLICY "messages_insert" ON public.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "messages_update" ON public.messages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "messages_delete" ON public.messages FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 4.2) conversation_events — via conversations.unit_id
-- ================================================================
ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_events_select" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_insert" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_update" ON public.conversation_events;
DROP POLICY IF EXISTS "conversation_events_delete" ON public.conversation_events;

CREATE POLICY "conversation_events_select" ON public.conversation_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_events.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "conversation_events_insert" ON public.conversation_events FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_events.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

-- Eventos são append-only — sem UPDATE pelo front.
CREATE POLICY "conversation_events_update" ON public.conversation_events FOR UPDATE
  TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

CREATE POLICY "conversation_events_delete" ON public.conversation_events FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 4.3) conversation_tags — via conversations.unit_id
-- ================================================================
ALTER TABLE public.conversation_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_tags_select" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_insert" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_update" ON public.conversation_tags;
DROP POLICY IF EXISTS "conversation_tags_delete" ON public.conversation_tags;

CREATE POLICY "conversation_tags_select" ON public.conversation_tags FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_tags.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "conversation_tags_insert" ON public.conversation_tags FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_tags.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "conversation_tags_update" ON public.conversation_tags FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_tags.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_tags.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

-- ChatView faz "delete + insert" para sincronizar tags.
CREATE POLICY "conversation_tags_delete" ON public.conversation_tags FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_tags.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

-- ================================================================
-- 4.4) conversation_assignments — via conversations.unit_id
-- ================================================================
ALTER TABLE public.conversation_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversation_assignments_select" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_insert" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_update" ON public.conversation_assignments;
DROP POLICY IF EXISTS "conversation_assignments_delete" ON public.conversation_assignments;

CREATE POLICY "conversation_assignments_select" ON public.conversation_assignments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_assignments.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "conversation_assignments_insert" ON public.conversation_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_assignments.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "conversation_assignments_update" ON public.conversation_assignments FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_assignments.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_assignments.conversation_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

CREATE POLICY "conversation_assignments_delete" ON public.conversation_assignments FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 4.5) contact_tags — via contacts.unit_id
-- ================================================================
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contact_tags_select" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_insert" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_update" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_delete" ON public.contact_tags;

CREATE POLICY "contact_tags_select" ON public.contact_tags FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_tags.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  );

CREATE POLICY "contact_tags_insert" ON public.contact_tags FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_tags.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  );

CREATE POLICY "contact_tags_update" ON public.contact_tags FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_tags.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_tags.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  );

CREATE POLICY "contact_tags_delete" ON public.contact_tags FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_tags.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  );

-- ================================================================
-- 4.6) contact_notes — via contacts.unit_id
-- (acessada hoje só via edge function/service_role, mas fechamos
--  o vetor anon-key direto)
-- ================================================================
ALTER TABLE public.contact_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contact_notes_select" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_insert" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_update" ON public.contact_notes;
DROP POLICY IF EXISTS "contact_notes_delete" ON public.contact_notes;

CREATE POLICY "contact_notes_select" ON public.contact_notes FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  );

CREATE POLICY "contact_notes_insert" ON public.contact_notes FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  );

CREATE POLICY "contact_notes_update" ON public.contact_notes FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND public.user_can_access_unit(ct.unit_id)
    )
  );

CREATE POLICY "contact_notes_delete" ON public.contact_notes FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- 4.7) message_status_events — via messages → conversations
-- (vazia hoje, mas RLS para o futuro)
-- ================================================================
ALTER TABLE public.message_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "message_status_events_select" ON public.message_status_events;
DROP POLICY IF EXISTS "message_status_events_insert" ON public.message_status_events;
DROP POLICY IF EXISTS "message_status_events_update" ON public.message_status_events;
DROP POLICY IF EXISTS "message_status_events_delete" ON public.message_status_events;

CREATE POLICY "message_status_events_select" ON public.message_status_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = message_status_events.message_id
        AND public.user_can_access_unit(c.unit_id)
    )
  );

-- INSERT/UPDATE/DELETE: só admin (write path real é via service_role no webhook)
CREATE POLICY "message_status_events_insert" ON public.message_status_events FOR INSERT
  TO authenticated WITH CHECK (public.is_admin_user());

CREATE POLICY "message_status_events_update" ON public.message_status_events FOR UPDATE
  TO authenticated USING (public.is_admin_user()) WITH CHECK (public.is_admin_user());

CREATE POLICY "message_status_events_delete" ON public.message_status_events FOR DELETE
  TO authenticated USING (public.is_admin_user());

-- ================================================================
-- VERIFICAÇÃO
-- ================================================================

-- 4.A) RLS ativo
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'messages', 'conversation_events', 'conversation_tags',
    'conversation_assignments', 'contact_tags', 'contact_notes',
    'message_status_events'
  );

-- 4.B) Policies criadas
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'messages', 'conversation_events', 'conversation_tags',
    'conversation_assignments', 'contact_tags', 'contact_notes',
    'message_status_events'
  )
ORDER BY tablename, policyname;

-- 4.C) PERFORMANCE — rodar EXPLAIN ANALYZE em queries críticas
-- (rodar logado como atendente; aqui é só template comentado):
-- EXPLAIN ANALYZE SELECT * FROM messages
--   WHERE conversation_id = '<algum-id>' ORDER BY created_at DESC LIMIT 50;
-- Esperar: usar índice em messages.conversation_id; subquery em
-- conversations resolvida via index scan em conversations.id (PK).

-- ================================================================
-- TESTE FUNCIONAL CRÍTICO:
--   1) Atendente: abrir chat de conversa da própria unidade
--      → mensagens carregam; enviar nova mensagem funciona
--   2) Atendente: tentar abrir conversa de outra unidade via URL
--      → mensagens vazias (RLS bloqueia)
--   3) Realtime de messages: enviar msg em conversa minha → chega;
--      msg em conversa alheia → NÃO chega (RLS aplicado ao replication)
--   4) ChatView add tag, remove tag, fechar conversa → eventos
--      gravados em conversation_events corretamente
--   5) Admin: vê tudo, edita tudo
--   6) Webhook WhatsApp: continuar funcionando (service_role bypassa)
-- ================================================================
