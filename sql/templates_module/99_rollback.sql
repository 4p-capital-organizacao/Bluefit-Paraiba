-- Rollback Templates Module
DROP FUNCTION IF EXISTS public.user_can_access_module(text);
DROP TRIGGER IF EXISTS trg_menu_item_permissions_updated_at ON public.menu_item_permissions;
DROP TABLE IF EXISTS public.menu_item_permissions;
