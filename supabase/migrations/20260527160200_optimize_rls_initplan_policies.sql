-- Otimiza 10 RLS policies que chamam auth.uid() por linha.
-- Wrap em (select auth.uid()) faz o Postgres avaliar uma única vez por query
-- via initplan, eliminando re-execução por linha. Mesma lógica, sem mudar
-- comportamento. Lint: auth_rls_initplan.

-- lead_history: INSERT with_check
ALTER POLICY "Permitir inserção no histórico de leads" ON public.lead_history
  WITH CHECK (((select auth.uid()) IS NOT NULL));

-- menu_item_permissions: SELECT
ALTER POLICY menu_perms_select ON public.menu_item_permissions
  USING (((select auth.uid()) IS NOT NULL));

-- alerts: SELECT
ALTER POLICY alerts_select ON public.alerts
  USING (
    is_admin_user()
    OR ((unit_id IS NOT NULL) AND (unit_id IN (SELECT user_unit_ids())))
    OR (assigned_user_id = (select auth.uid()))
  );

-- alerts: UPDATE (qual + with_check)
ALTER POLICY alerts_update ON public.alerts
  USING (
    is_admin_user()
    OR ((unit_id IS NOT NULL) AND (unit_id IN (SELECT user_unit_ids())))
    OR (assigned_user_id = (select auth.uid()))
  )
  WITH CHECK (
    is_admin_user()
    OR ((unit_id IS NOT NULL) AND (unit_id IN (SELECT user_unit_ids())))
    OR (assigned_user_id = (select auth.uid()))
  );

-- profiles: UPDATE
ALTER POLICY profiles_update ON public.profiles
  USING ((id = (select auth.uid())) OR is_admin_user())
  WITH CHECK ((id = (select auth.uid())) OR is_admin_user());

-- profile_units: SELECT
ALTER POLICY profile_units_select ON public.profile_units
  USING ((profile_id = (select auth.uid())) OR is_admin_user());

-- unit_memberships: SELECT
ALTER POLICY unit_memberships_select ON public.unit_memberships
  USING ((user_id = (select auth.uid())) OR is_admin_user());

-- profile_events: SELECT
ALTER POLICY profile_events_select ON public.profile_events
  USING ((user_id = (select auth.uid())) OR is_admin_user());

-- profile_events: INSERT
ALTER POLICY profile_events_insert ON public.profile_events
  WITH CHECK (user_id = (select auth.uid()));

-- tags: INSERT
ALTER POLICY tags_insert ON public.tags
  WITH CHECK (((select auth.uid()) IS NOT NULL));
