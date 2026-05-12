import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { STALE_TIMES } from '../lib/react-query';

export interface UnitAutomationSettings {
  unit_id: number;
  followup_enabled: boolean;
  max_followup_envios: number;
  daily_cap: number;
  template_name: string;
  threshold_hours: number;
}

const DEFAULT_MAX_FOLLOWUP = 2;

async function fetchAutomationSettings(): Promise<UnitAutomationSettings[]> {
  const { data, error } = await supabase
    .from('unit_automation_settings')
    .select('unit_id, followup_enabled, max_followup_envios, daily_cap, template_name, threshold_hours');

  if (error) throw error;
  return (data ?? []) as UnitAutomationSettings[];
}

/**
 * Hook que expõe os settings de automação por unidade.
 * Cache longo (30 min) porque a config muda raramente.
 *
 * Retorna utilitários:
 * - `byUnit`: Map<unit_id, settings>
 * - `getMaxFollowupForUnit(unitId)`: número de envios máximos da unidade
 *   (fallback 2 quando não houver settings para a unidade)
 */
export function useAutomationSettings() {
  const query = useQuery({
    queryKey: ['automation', 'unit-settings'],
    queryFn: fetchAutomationSettings,
    staleTime: STALE_TIMES.static,
    gcTime: STALE_TIMES.static,
  });

  const byUnit = useMemo(
    () =>
      (query.data ?? []).reduce<Record<number, UnitAutomationSettings>>((acc, s) => {
        acc[s.unit_id] = s;
        return acc;
      }, {}),
    [query.data],
  );

  const getMaxFollowupForUnit = useCallback(
    (unitId: number | null | undefined): number => {
      if (unitId == null) return DEFAULT_MAX_FOLLOWUP;
      return byUnit[unitId]?.max_followup_envios ?? DEFAULT_MAX_FOLLOWUP;
    },
    [byUnit],
  );

  return {
    settings: query.data ?? [],
    byUnit,
    getMaxFollowupForUnit,
    isLoading: query.isLoading,
    error: query.error,
  };
}
