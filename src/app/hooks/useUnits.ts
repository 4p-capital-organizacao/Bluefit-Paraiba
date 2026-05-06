import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys, STALE_TIMES } from '../lib/react-query';

export interface Unit {
  id: number;
  name: string;
}

async function fetchUnits(): Promise<Unit[]> {
  const { data, error } = await supabase
    .from('units')
    .select('id, name')
    .order('name');

  if (error) throw error;
  return data ?? [];
}

/**
 * Hook compartilhado para listar unidades.
 * Cache de 30min: unidades mudam raramente.
 * Substitui chamadas duplicadas de loadUnits() em ContactsModule, CRMView, Dashboard, etc.
 */
export function useUnits() {
  const query = useQuery({
    queryKey: queryKeys.units.lists(),
    queryFn: fetchUnits,
    staleTime: STALE_TIMES.static,
    gcTime: STALE_TIMES.static,
  });

  return {
    units: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
