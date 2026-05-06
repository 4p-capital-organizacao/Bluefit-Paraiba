-- Rollback BlueDesk H1.5 — Snippets dinamicos
DROP FUNCTION IF EXISTS public.increment_quick_reply_usage(bigint);
DROP TRIGGER IF EXISTS trg_quick_replies_updated_at ON public.quick_replies;
DROP TABLE IF EXISTS public.quick_replies;
