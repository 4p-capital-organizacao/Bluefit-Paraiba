-- ═══════════════════════════════════════════════════════════════════════
-- 🔎 ÍNDICES TRIGRAM (pg_trgm) - BLUE DESK
-- ═══════════════════════════════════════════════════════════════════════
-- Complementa sql/performance-indexes.sql.
--
-- Por que pg_trgm?
-- O Postgres não usa B-tree comum em queries `ILIKE '%termo%'`. Para essas
-- buscas (full-text "leve") é preciso um índice GIN com gin_trgm_ops.
--
-- Onde isso afeta:
--   - useConversations.ts → fetchConversationsBySearch  → .ilike('body', '%term%')
--   - useConversations.ts → busca em contacts          → .or('display_name.ilike...')
--   - ContactsModule (futuro server-side)              → idem
--
-- Impacto esperado: queries de busca caem de "tablescan completo" para
-- "lookup por bigrama" — ganho de 10-100x em tabelas com 100k+ linhas.
-- ═══════════════════════════════════════════════════════════════════════

-- 1️⃣ Habilitar a extensão (idempotente)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2️⃣ Índices em messages.body (busca de mensagens)
CREATE INDEX IF NOT EXISTS idx_messages_body_trgm
  ON messages USING gin (body gin_trgm_ops);

-- 3️⃣ Índices em contacts (busca por nome / telefone / wa_id)
CREATE INDEX IF NOT EXISTS idx_contacts_display_name_trgm
  ON contacts USING gin (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_first_name_trgm
  ON contacts USING gin (first_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_last_name_trgm
  ON contacts USING gin (last_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_phone_trgm
  ON contacts USING gin (phone_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_wa_id_trgm
  ON contacts USING gin (wa_id gin_trgm_ops);

-- 4️⃣ ANALYZE para o planner conhecer os novos índices
ANALYZE messages;
ANALYZE contacts;

-- ═══════════════════════════════════════════════════════════════════════
-- ✅ VERIFICAÇÃO
-- ═══════════════════════════════════════════════════════════════════════
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE '%_trgm'
ORDER BY tablename, indexname;

-- ═══════════════════════════════════════════════════════════════════════
-- 📝 COMO APLICAR
-- ═══════════════════════════════════════════════════════════════════════
-- Opção A — CLI Supabase (recomendado):
--   supabase db push   # se este arquivo virar uma migration em supabase/migrations/
--
-- Opção B — Manual:
--   Cole o conteúdo no Supabase Studio → SQL Editor → Run.
--
-- IMPORTANTE: índices GIN trigram ocupam ~3-5x mais espaço que B-tree.
-- Em tabelas grandes (messages com milhões de linhas), o CREATE INDEX
-- pode levar minutos. Considere CREATE INDEX CONCURRENTLY para evitar
-- locks de escrita prolongados em produção:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_body_trgm
--     ON messages USING gin (body gin_trgm_ops);
-- (CONCURRENTLY não pode estar dentro de uma transação — rodar 1 por vez)
-- ═══════════════════════════════════════════════════════════════════════
