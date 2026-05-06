import { useEffect, useState } from 'react';

/**
 * Retorna o valor após `delayMs` sem mudanças.
 * Uso típico: debounce de input de busca antes de disparar query.
 *
 *   const [search, setSearch] = useState('');
 *   const debouncedSearch = useDebouncedValue(search, 500);
 *   useQuery({ queryKey: ['x', debouncedSearch], ... });
 */
export function useDebouncedValue<T>(value: T, delayMs = 500): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
