-- ================================================================
-- ONDA 0 — PREFLIGHT (read-only, sem mudanças)
-- ================================================================
-- Objetivo: validar pré-requisitos antes de habilitar RLS.
-- Rode bloco por bloco, anote os resultados.
-- ================================================================

-- 0.1) Cargos atuais (referência)
-- Esperado:
--   1 = Sem cargo
--   2 = Atendente
--   3 = Supervisor
--   4 = Gerente
--   5 = Administrador
SELECT id, papeis FROM cargos ORDER BY id;

-- 0.2) Distribuição de usuários por cargo
SELECT id_cargo, COUNT(*) AS qtd
FROM profiles
GROUP BY id_cargo
ORDER BY id_cargo;

-- 0.3) Usuários que HOJE têm bypass de admin via bug em is_admin_user()
-- (id_cargo = 1 "Sem cargo" + id_cargo = 5 "Administrador")
-- Estes 3 usuários "Sem cargo" perderão privilégio de admin após Onda 1.
-- Confirme se algum deles é seu próprio login antes de aplicar.
SELECT id, nome, sobrenome, email, id_cargo
FROM profiles
WHERE id_cargo IN (1, 5)
ORDER BY id_cargo, nome;

-- 0.4) Estado atual de RLS por tabela (esperado: várias false)
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity, tablename;

-- 0.5) Policies já existentes (evitar conflito de nome)
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 0.6) Funções helper que JÁ existem
SELECT proname, prorettype::regtype AS retorno, prosecdef AS security_definer
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('is_admin_user', 'get_user_unit_id', 'user_unit_ids', 'user_can_access_unit')
ORDER BY proname;

-- 0.7) Índices críticos para performance das policies
-- Toda policy com subquery por estas colunas exige índice.
-- Se algum não aparecer, criar com CREATE INDEX CONCURRENTLY antes da Onda 3.
SELECT
  t.relname AS tabela,
  i.relname AS indice,
  array_to_string(array_agg(a.attname ORDER BY x.n), ', ') AS colunas
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n) ON true
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
WHERE n.nspname = 'public'
  AND t.relname IN (
    'contacts', 'conversations', 'messages',
    'conversation_events', 'conversation_tags', 'conversation_assignments',
    'contact_tags', 'contact_notes',
    'profile_events', 'profile_units',
    'message_status_events', 'leads', 'lead_history'
  )
GROUP BY t.relname, i.relname
ORDER BY t.relname, i.relname;

-- 0.8) Conferir colunas esperadas existem (defesa contra schema drift)
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'contacts' AND column_name = 'unit_id')
    OR (table_name = 'conversations' AND column_name IN ('unit_id', 'assigned_user_id'))
    OR (table_name = 'messages' AND column_name = 'conversation_id')
    OR (table_name = 'conversation_events' AND column_name = 'conversation_id')
    OR (table_name = 'conversation_tags' AND column_name = 'conversation_id')
    OR (table_name = 'conversation_assignments' AND column_name = 'conversation_id')
    OR (table_name = 'contact_tags' AND column_name = 'contact_id')
    OR (table_name = 'contact_notes' AND column_name = 'contact_id')
    OR (table_name = 'profile_events' AND column_name = 'user_id')
    OR (table_name = 'profile_units' AND column_name IN ('profile_id', 'unit_id'))
    OR (table_name = 'leads' AND column_name = 'id_unidade')
    OR (table_name = 'lead_history' AND column_name = 'lead_id')
    OR (table_name = 'message_status_events' AND column_name = 'message_id')
  )
ORDER BY table_name, column_name;

-- ================================================================
-- ✅ Critérios para avançar para Onda 1:
--   - 0.3: você decidiu se OK remover bypass dos "Sem cargo"
--   - 0.7: índices existem em conversation_id, contact_id, unit_id, user_id
--   - 0.8: todas as colunas esperadas existem com tipos compatíveis
-- ================================================================
