-- Remove os 247 índices duplicados em public.kv_store_844b77a1.
-- A tabela tinha 248 cópias do mesmo índice (kv_store_844b77a1_key_idx,
-- kv_store_844b77a1_key_idx1, ..., kv_store_844b77a1_key_idx247) — provável
-- lixo de migração que rodou em loop. Mantemos só o original sem sufixo.
DO $$
DECLARE
  idx_name TEXT;
  dropped_count INT := 0;
BEGIN
  FOR idx_name IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'kv_store_844b77a1'
      AND indexname ~ '^kv_store_844b77a1_key_idx[0-9]+$'
  LOOP
    EXECUTE 'DROP INDEX IF EXISTS public.' || quote_ident(idx_name);
    dropped_count := dropped_count + 1;
  END LOOP;
  RAISE NOTICE 'Dropped % duplicate indexes from kv_store_844b77a1', dropped_count;
END $$;
