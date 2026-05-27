import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { authFetch, API_BASE } from '../lib/api';
import { supabase } from '../lib/supabase';
import { queryKeys, STALE_TIMES } from '../lib/react-query';
import { useDebouncedInvalidation } from './useDebouncedInvalidation';

export interface Contact {
  id: string;
  wa_id: string;
  phone_number: string;
  display_name: string;
  first_name?: string;
  last_name?: string;
  unit_id: string;
  situation: string;
  created_at: string;
  [key: string]: any;
}

interface UseContactsOptions {
  search?: string;
  unitId?: string;       // 'all' | '<id>'
  situation?: string;    // 'all' | '<value>'
  enabled?: boolean;
}

interface ContactsPage {
  contacts: Contact[];
  total: number;
  hasMore: boolean;
  offset: number;
}

const PAGE_SIZE = 50;

async function fetchContactsPage(
  { pageParam = 0 }: { pageParam?: number },
  filters: { search: string; unitId: string; situation: string },
): Promise<ContactsPage> {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(pageParam),
  });
  if (filters.search) params.set('search', filters.search);
  if (filters.unitId && filters.unitId !== 'all') params.set('unit_id', filters.unitId);
  if (filters.situation && filters.situation !== 'all') params.set('situation', filters.situation);

  const response = await authFetch(`${API_BASE}/api/contacts?${params.toString()}`, { method: 'GET' });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Erro ao carregar contatos');
  }
  const contacts: Contact[] = result.contacts ?? [];
  return {
    contacts,
    total: result.total ?? 0,
    hasMore: !!result.hasMore,
    offset: pageParam + contacts.length,
  };
}

/**
 * Hook para listar contatos com paginação + filtros server-side.
 *
 * - Backend (`/api/contacts`) aceita `limit`, `offset`, `search`, `unit_id`,
 *   `situation` e aplica RBAC server-side (atendente/sup/gerente forçados
 *   pra unidade deles; admin pode escolher).
 * - Filtros viram parte da query key → trocar de filtro dispara refetch
 *   (com `placeholderData` mantendo a tela viva enquanto carrega).
 * - Scroll infinito via `fetchNextPage()` no consumidor.
 * - Realtime: qualquer mudança (INSERT/UPDATE/DELETE) invalida com debounce.
 *   Patches cirúrgicos em listas paginadas são complexos demais pro retorno.
 */
export function useContacts(options: UseContactsOptions = {}) {
  const queryClient = useQueryClient();
  const filters = useMemo(
    () => ({
      search: options.search?.trim() ?? '',
      unitId: options.unitId ?? 'all',
      situation: options.situation ?? 'all',
    }),
    [options.search, options.unitId, options.situation],
  );

  const debouncedInvalidate = useDebouncedInvalidation(queryKeys.contacts.all);

  const query = useInfiniteQuery({
    queryKey: queryKeys.contacts.infinite(filters),
    queryFn: (ctx) => fetchContactsPage(ctx as { pageParam: number }, filters),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset : undefined),
    enabled: options.enabled ?? true,
    staleTime: STALE_TIMES.list,
    placeholderData: (previous) => previous,
  });

  // Realtime: qualquer mudança em contacts invalida cache (debounced).
  useEffect(() => {
    const channel = supabase
      .channel('contacts-realtime-cache')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'contacts' },
        () => debouncedInvalidate(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [debouncedInvalidate]);

  const contacts = useMemo(
    () => query.data?.pages.flatMap((p) => p.contacts) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });

  return {
    contacts,
    total,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: !!query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
    refresh,
    error: query.error,
  };
}
