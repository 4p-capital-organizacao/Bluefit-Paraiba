import { QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Debounced invalidation - agrupa múltiplos eventos (Realtime, etc)
 * em uma única invalidação para evitar rajada de refetches.
 *
 * Uso típico:
 *   const debouncedInvalidate = useDebouncedInvalidation(queryKeys.contacts.all);
 *   // dentro de subscription:
 *   .on('postgres_changes', ..., () => debouncedInvalidate())
 */
export function useDebouncedInvalidation(queryKey: QueryKey, delayMs = 2000) {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef<QueryKey>(queryKey);
  keyRef.current = queryKey;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: keyRef.current });
    }, delayMs);
  }, [queryClient, delayMs]);
}
