-- ================================================================
-- ONDA 3 — Tabelas com unit_id direto: contacts, conversations
-- ================================================================
-- Tabelas: contacts (11.757 rows), conversations (11.231 rows)
--
-- Pré-requisito: Onda 1 aplicada (user_can_access_unit existe).
-- Idempotente: DROP POLICY IF EXISTS antes de CREATE.
--
-- Filtro padrão: user_can_access_unit(unit_id)
--   → admin sempre passa
--   → unit_id NULL passa (registros órfãos / globais)
--   → senão precisa estar em user_unit_ids() do auth.uid()
-- ================================================================

-- ================================================================
-- 3.1) contacts
-- ================================================================
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contacts_select" ON public.contacts;
DROP POLICY IF EXISTS "contacts_insert" ON public.contacts;
DROP POLICY IF EXISTS "contacts_update" ON public.contacts;
DROP POLICY IF EXISTS "contacts_delete" ON public.contacts;

CREATE POLICY "contacts_select" ON public.contacts FOR SELECT
  TO authenticated
  USING (public.user_can_access_unit(unit_id));

CREATE POLICY "contacts_insert" ON public.contacts FOR INSERT
  TO authenticated
  WITH CHECK (public.user_can_access_unit(unit_id));

-- UPDATE: usuário pode ler E gravar na própria unidade.
-- WITH CHECK aplica também ao novo unit_id, então mover contato
-- para unidade alheia exige ser admin (admin passa pelo OR no helper).
CREATE POLICY "contacts_update" ON public.contacts FOR UPDATE
  TO authenticated
  USING (public.user_can_access_unit(unit_id))
  WITH CHECK (public.user_can_access_unit(unit_id));

-- DELETE: só admin (proteção contra perda acidental de dado).
CREATE POLICY "contacts_delete" ON public.contacts FOR DELETE
  TO authenticated
  USING (public.is_admin_user());

-- ================================================================
-- 3.2) conversations
-- ================================================================
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations_select" ON public.conversations;
DROP POLICY IF EXISTS "conversations_insert" ON public.conversations;
DROP POLICY IF EXISTS "conversations_update" ON public.conversations;
DROP POLICY IF EXISTS "conversations_delete" ON public.conversations;

CREATE POLICY "conversations_select" ON public.conversations FOR SELECT
  TO authenticated
  USING (public.user_can_access_unit(unit_id));

-- INSERT: webhook do WhatsApp é via service_role e bypassa RLS,
-- então essa policy só afeta inserts vindos do front (via anon).
CREATE POLICY "conversations_insert" ON public.conversations FOR INSERT
  TO authenticated
  WITH CHECK (public.user_can_access_unit(unit_id));

CREATE POLICY "conversations_update" ON public.conversations FOR UPDATE
  TO authenticated
  USING (public.user_can_access_unit(unit_id))
  WITH CHECK (public.user_can_access_unit(unit_id));

CREATE POLICY "conversations_delete" ON public.conversations FOR DELETE
  TO authenticated
  USING (public.is_admin_user());

-- ================================================================
-- VERIFICAÇÃO
-- ================================================================

-- 3.A) RLS ativo
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('contacts', 'conversations');

-- 3.B) Policies criadas
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('contacts', 'conversations')
ORDER BY tablename, policyname;

-- 3.C) Plano de query — confirmar que policy não causou seq scan
-- (rode logado como atendente; aqui é só template)
-- EXPLAIN ANALYZE
-- SELECT id, contact_id FROM conversations LIMIT 50;

-- ================================================================
-- TESTE FUNCIONAL CRÍTICO:
--   1) Login como Atendente da unidade A:
--      - lista de conversas (useConversations) só mostra unidade A
--      - busca de contato (ContactsModule) só retorna unidade A
--      - tentar abrir conversa de unidade B via URL → bloqueado
--      - Realtime: postgres_changes em conversations só dispara
--        para unit A (RLS aplicado ao replication slot)
--
--   2) Login como Admin: vê tudo, edita tudo
--
--   3) Webhook WhatsApp continua funcionando:
--      tail logs da edge function — mensagens entram normalmente
--      (service_role bypassa RLS; teste enviando msg de fora)
--
--   4) EditContactDialog tentando mover contato para outra unit:
--      - se user é admin → ok
--      - se user não é admin → erro 403 esperado.
--        Confirmar que a UI exibe erro tratado (não tela branca).
-- ================================================================
