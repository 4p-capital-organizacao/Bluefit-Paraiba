/**
 * Hook que carrega menu_item_permissions e expõe canAccess(moduleKey).
 *
 * Resolve client-side se o cargo do usuário (level) está em required_cargo_levels.
 * RLS já restringe SELECT a authenticated, e UPDATE/INSERT/DELETE a admin.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useUserProfile } from './useUserProfile';

export interface ModulePermissionRow {
  id: number;
  module_key: string;
  required_cargo_levels: number[];
  description: string | null;
}

interface UserCargoMeta {
  level: number;
}

const CARGO_LEVEL_BY_ID: Record<number, number> = {
  1: 1, // Sem cargo
  2: 2, // Atendente
  3: 3, // Supervisor
  4: 4, // Gerente
  5: 5, // Administrador
};

function levelOfCargoId(id_cargo: number | null): number {
  return id_cargo ? CARGO_LEVEL_BY_ID[id_cargo] ?? 0 : 0;
}

let cachedPerms: ModulePermissionRow[] | null = null;
let cacheTs = 0;
const CACHE_TTL = 60_000;

export function useModulePermissions() {
  const { profile } = useUserProfile();
  const [perms, setPerms] = useState<ModulePermissionRow[]>(cachedPerms ?? []);
  const [loading, setLoading] = useState(!cachedPerms);

  const reload = useCallback(async (force = false) => {
    if (!force && cachedPerms && Date.now() - cacheTs < CACHE_TTL) {
      setPerms(cachedPerms);
      setLoading(false);
      return cachedPerms;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('menu_item_permissions')
      .select('id, module_key, required_cargo_levels, description');
    if (error) {
      console.error('[useModulePermissions] erro:', error);
      setLoading(false);
      return [];
    }
    cachedPerms = (data as ModulePermissionRow[]) || [];
    cacheTs = Date.now();
    setPerms(cachedPerms);
    setLoading(false);
    return cachedPerms;
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const canAccess = useCallback(
    (moduleKey: string): boolean => {
      if (!profile.isLoaded) return false;
      const level = levelOfCargoId(profile.id_cargo);
      const row = perms.find((p) => p.module_key === moduleKey);
      if (!row) return false;
      return row.required_cargo_levels.includes(level);
    },
    [profile.isLoaded, profile.id_cargo, perms],
  );

  return { perms, loading, canAccess, reload };
}

export function clearModulePermissionsCache() {
  cachedPerms = null;
  cacheTs = 0;
}
