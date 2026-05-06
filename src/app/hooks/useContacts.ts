import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
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

interface ContactsResponse {
  success: boolean;
  contacts?: Contact[];
  error?: string;
}

async function fetchContacts(): Promise<Contact[]> {
  const response = await authFetch(`${API_BASE}/api/contacts`, { method: 'GET' });
  const result: ContactsResponse = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Erro ao carregar contatos');
  }

  return result.contacts ?? [];
}

/**
 * Hook para listar contatos com cache + realtime seletivo.
 *
 * - 1ª visita: busca via edge function (RBAC server-side aplicado lá).
 * - Próximas visitas: cache hit instantâneo (staleTime 60s, gcTime 5min).
 * - Realtime UPDATE: muta o item em cache sem refetch.
 * - Realtime INSERT/DELETE: invalida com debounce 2s (evita rajada).
 *
 * NOTA: filtros (busca, unidade, situação) ficam client-side por ora
 * porque a edge function `/api/contacts` ainda devolve a lista inteira.
 * Quando ela ganhar paginação/filtros server-side, este hook passará
 * a aceitar `{ unit, situation, search }` e usar `useInfiniteQuery`.
 */
export function useContacts() {
  const queryClient = useQueryClient();
  const debouncedInvalidate = useDebouncedInvalidation(queryKeys.contacts.all);

  const query = useQuery({
    queryKey: queryKeys.contacts.list(),
    queryFn: fetchContacts,
    staleTime: STALE_TIMES.list,
  });

  useEffect(() => {
    const channel = supabase
      .channel('contacts-realtime-cache')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'contacts' },
        (payload) => {
          const updated = payload.new as Contact;
          queryClient.setQueryData<Contact[]>(queryKeys.contacts.list(), (old) => {
            if (!old) return old;
            return old.map((c) => (String(c.id) === String(updated.id) ? { ...c, ...updated } : c));
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'contacts' },
        () => debouncedInvalidate(),
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'contacts' },
        (payload) => {
          const deletedId = (payload.old as Partial<Contact>)?.id;
          if (deletedId == null) {
            debouncedInvalidate();
            return;
          }
          queryClient.setQueryData<Contact[]>(queryKeys.contacts.list(), (old) => {
            if (!old) return old;
            return old.filter((c) => String(c.id) !== String(deletedId));
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, debouncedInvalidate]);

  return {
    contacts: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}
