/**
 * 🚀 REACT QUERY - Configuração do TanStack Query
 * 
 * Sistema de cache inteligente para melhorar performance do Blue Desk:
 * - Cache automático de requisições
 * - Invalidação inteligente via Realtime
 * - Deduplicação de requests
 * - Scroll infinito otimizado
 * - Background refetch
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // ⏱️ Quanto tempo os dados ficam "fresh" (sem refetch automático)
      staleTime: 60 * 1000, // 60 segundos (reduz refetches desnecessários)
      
      // 🗑️ Quanto tempo manter dados em cache após ficarem "unused"
      gcTime: 5 * 60 * 1000, // 5 minutos (antes era "cacheTime")
      
      // 🔄 Refetch automático quando a janela ganha foco
      refetchOnWindowFocus: true,
      
      // 📶 Refetch quando reconectar à internet
      refetchOnReconnect: true,
      
      // 🔁 Retry em caso de erro
      retry: 2,
      
      // ⏳ Delay entre retries
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      
      // 🎯 Não refetch em mount se dados estão fresh
      refetchOnMount: true,
    },
    mutations: {
      // 🔁 Retry em caso de erro em mutations
      retry: 1,
    },
  },
});

/**
 * ⏱️ STALE_TIMES por domínio
 *
 * Cada hook escolhe o staleTime adequado para os dados que carrega:
 * - Estáticos (units, cargos): 30 min
 * - Histórico/agregado (dashboard): 10 min
 * - Listas operacionais (contatos, leads, conversas): 60 s
 * - Detalhe sob edição: 30 s
 */
export const STALE_TIMES = {
  static: 30 * 60 * 1000,
  dashboard: 10 * 60 * 1000,
  list: 60 * 1000,
  detail: 30 * 1000,
} as const;

/**
 * 🔑 Query Keys - Centralizar as keys para facilitar invalidação
 */
export const queryKeys = {
  // 💬 Conversas
  conversations: {
    all: ['conversations'] as const,
    lists: () => [...queryKeys.conversations.all, 'list'] as const,
    list: (filters: Record<string, any>) => [...queryKeys.conversations.lists(), filters] as const,
    infinite: (filters: Record<string, any>) => [...queryKeys.conversations.all, 'infinite', filters] as const,
    detail: (id: string) => [...queryKeys.conversations.all, 'detail', id] as const,
  },
  
  // 💬 Mensagens
  messages: {
    all: ['messages'] as const,
    byConversation: (conversationId: string) => [...queryKeys.messages.all, 'conversation', conversationId] as const,
  },
  
  // 👤 Contatos
  contacts: {
    all: ['contacts'] as const,
    lists: () => [...queryKeys.contacts.all, 'list'] as const,
    list: (filters?: Record<string, any>) => [...queryKeys.contacts.lists(), filters || {}] as const,
    infinite: (filters?: Record<string, any>) => [...queryKeys.contacts.all, 'infinite', filters || {}] as const,
    detail: (id: string) => [...queryKeys.contacts.all, 'detail', id] as const,
  },

  // 📈 Leads (CRM)
  leads: {
    all: ['leads'] as const,
    lists: () => [...queryKeys.leads.all, 'list'] as const,
    list: (filters?: Record<string, any>) => [...queryKeys.leads.lists(), filters || {}] as const,
    infinite: (filters?: Record<string, any>) => [...queryKeys.leads.all, 'infinite', filters || {}] as const,
    detail: (id: string) => [...queryKeys.leads.all, 'detail', id] as const,
  },
  
  // 🏷️ Tags
  tags: {
    all: ['tags'] as const,
    lists: () => [...queryKeys.tags.all, 'list'] as const,
  },
  
  // 👥 Usuários/Atendentes
  users: {
    all: ['users'] as const,
    profile: (id?: string) => [...queryKeys.users.all, 'profile', id || 'me'] as const,
    unitAgents: (unitIds: string[]) => [...queryKeys.users.all, 'unit-agents', unitIds] as const,
  },
  
  // 📊 Dashboard
  dashboard: {
    all: ['dashboard'] as const,
    stats: () => [...queryKeys.dashboard.all, 'stats'] as const,
    charts: (period?: string) => [...queryKeys.dashboard.all, 'charts', period || 'today'] as const,
  },
  
  // 🏢 Unidades
  units: {
    all: ['units'] as const,
    lists: () => [...queryKeys.units.all, 'list'] as const,
  },
  
  // ⏰ Horário Comercial
  businessHours: {
    all: ['business-hours'] as const,
    config: (unitId?: string) => [...queryKeys.businessHours.all, 'config', unitId || 'default'] as const,
  },
};

/**
 * 🎯 Helpers para invalidar cache de forma inteligente
 */
export const invalidateQueries = {
  // Invalidar todas as conversas
  allConversations: () => {
    return queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
  },

  // Invalidar uma conversa específica
  conversation: (id: string) => {
    return queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) });
  },

  // Invalidar mensagens de uma conversa
  conversationMessages: (conversationId: string) => {
    return queryClient.invalidateQueries({ queryKey: queryKeys.messages.byConversation(conversationId) });
  },

  // Invalidar dashboard
  dashboard: () => {
    return queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  },

  // Invalidar tags
  tags: () => {
    return queryClient.invalidateQueries({ queryKey: queryKeys.tags.all });
  },
};

/**
 * 🎯 Helpers para atualizar cache de forma otimista
 */
export const updateCache = {
  // Atualizar cache de uma conversa específica (para Realtime)
  conversation: (id: string, updater: (old: any) => any) => {
    queryClient.setQueryData(queryKeys.conversations.detail(id), updater);
  },
  
  // Adicionar nova mensagem ao cache (para Realtime)
  addMessage: (conversationId: string, message: any) => {
    queryClient.setQueryData(
      queryKeys.messages.byConversation(conversationId),
      (old: any) => {
        if (!old) return { pages: [[message]], pageParams: [0] };
        const newPages = [[message], ...old.pages];
        return { ...old, pages: newPages };
      }
    );
  },
};
