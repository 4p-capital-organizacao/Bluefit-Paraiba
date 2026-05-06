import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { queryKeys, STALE_TIMES } from '../lib/react-query';
import type { LeadWithDetails, LeadStatus } from '../types/database';
import type { UserProfile } from './useUserProfile';

export interface LeadsResult {
  leads: LeadWithDetails[];
  debugInfo: string;
  leadsToFix: string[];
}

const VALID_STATUSES: LeadStatus[] = [
  'novo',
  'contato_feito',
  'visita_agendada',
  'visita_realizada',
  'visita_cancelada',
  'matriculado',
  'base_fria',
  'perdido',
];

/**
 * Faz o fetch principal dos leads aplicando o filtro de RBAC
 * por unidade/cargo (mesmo cálculo que estava em CRMView.loadLeads).
 */
async function fetchLeadsByProfile(
  profile: UserProfile,
  showAllUnits: boolean,
): Promise<{ rows: any[]; debugInfo: string }> {
  const { id_unidade, unitIds, unitName, unitNames, isFullAdmin } = profile;

  let query = supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });

  const shouldFilterByUnit = !isFullAdmin || (isFullAdmin && !showAllUnits);

  if (shouldFilterByUnit && unitIds.length > 0) {
    const unitFilters = unitIds.map((id) => `id_unidade.eq.${id}`).join(',');
    query = query.or(`${unitFilters},id_unidade.is.null`);
  } else if (shouldFilterByUnit && id_unidade != null) {
    query = query.or(`id_unidade.eq.${id_unidade},id_unidade.is.null`);
  } else if (!isFullAdmin && unitIds.length === 0 && id_unidade == null) {
    query = query.is('id_unidade', null);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const total = rows.length;
  const namesStr = unitIds.length > 0
    ? Object.values(unitNames).join(', ')
    : unitName || String(id_unidade);
  const debugInfo = shouldFilterByUnit && (unitIds.length > 0 || id_unidade != null)
    ? `Mostrando ${total} leads de ${unitIds.length > 1 ? `${unitIds.length} unidades` : `unidade ${namesStr}`}`
    : isFullAdmin
      ? `Admin: mostrando todos os ${total} leads`
      : `Mostrando ${total} leads (sem unidade definida)`;

  return { rows, debugInfo };
}

async function fetchFollowupSummary(leadIds: string[]) {
  if (leadIds.length === 0) return new Map<string, any>();
  const { data } = await supabase
    .from('lead_followup_summary')
    .select('lead_id, followup_count, reactivated_at, recently_reactivated')
    .in('lead_id', leadIds);
  return new Map<string, any>((data ?? []).map((s: any) => [s.lead_id, s]));
}

async function fetchLastMessageDirections(contactIds: string[]) {
  if (contactIds.length === 0) return new Map<string, 'inbound' | 'outbound'>();

  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, contact_id')
    .in('contact_id', contactIds);

  if (!conversations || conversations.length === 0) {
    return new Map<string, 'inbound' | 'outbound'>();
  }

  const conversationIds = conversations.map((c) => c.id);
  const { data: lastMessages } = await supabase
    .from('messages')
    .select('conversation_id, direction, sent_at')
    .in('conversation_id', conversationIds)
    .order('sent_at', { ascending: false });

  // Última mensagem por conversa (client-side, evita N queries)
  const lastByConv: Record<string, string> = {};
  for (const msg of lastMessages ?? []) {
    if (!lastByConv[msg.conversation_id]) {
      lastByConv[msg.conversation_id] = msg.direction;
    }
  }

  // contact_id → direção
  const dirByContact = new Map<string, 'inbound' | 'outbound'>();
  for (const conv of conversations) {
    const direction = lastByConv[conv.id];
    if (direction === 'inbound' || direction === 'outbound') {
      dirByContact.set(conv.contact_id, direction);
    }
  }
  return dirByContact;
}

/**
 * Pipeline completo: fetch base + enriquecimento (followup_summary + lastMessageDirection)
 * em paralelo. Retorna lista pronta para renderizar.
 */
async function fetchEnrichedLeads(
  profile: UserProfile,
  showAllUnits: boolean,
): Promise<LeadsResult> {
  const { rows, debugInfo } = await fetchLeadsByProfile(profile, showAllUnits);

  if (rows.length === 0) {
    return { leads: [], debugInfo, leadsToFix: [] };
  }

  // Normaliza situacao + coleta IDs com situacao inválida (correção fire-and-forget no CRMView)
  const leadsToFix: string[] = [];
  const baseLeads: LeadWithDetails[] = rows.map((lead: any) => {
    const original = lead.situacao;
    const isValid = original && VALID_STATUSES.includes(String(original).toLowerCase() as LeadStatus);
    if (!isValid) leadsToFix.push(lead.id);
    return {
      ...lead,
      situacao: isValid ? (String(original).toLowerCase() as LeadStatus) : ('novo' as LeadStatus),
      lastMessageDirection: null,
    } as LeadWithDetails;
  });

  // Enriquecimento em paralelo
  const leadIds = baseLeads.map((l) => l.id);
  const contactIds = baseLeads.map((l) => l.id_contact).filter(Boolean) as string[];

  const [summaryById, dirByContact] = await Promise.all([
    fetchFollowupSummary(leadIds),
    fetchLastMessageDirections(contactIds),
  ]);

  const enriched = baseLeads.map((lead) => {
    const s = summaryById.get(lead.id);
    const dir = lead.id_contact ? dirByContact.get(lead.id_contact) : undefined;
    return {
      ...lead,
      ...(s
        ? {
            followup_count: s.followup_count,
            reactivated_at: s.reactivated_at,
            recently_reactivated: s.recently_reactivated,
          }
        : {}),
      ...(dir ? { lastMessageDirection: dir } : {}),
    };
  });

  return { leads: enriched, debugInfo, leadsToFix };
}

interface UseLeadsOptions {
  profile: UserProfile;
  showAllUnits: boolean;
  enabled?: boolean;
}

/**
 * Hook para listar leads com cache via React Query + utilitários
 * para update otimista (usado no drag-drop do Kanban).
 *
 * - 1ª visita: faz a query enriquecida (3 fetches em paralelo após o principal).
 * - Próximas visitas: cache hit instantâneo (staleTime 60s).
 * - Update otimista: `updateLead(id, patch)` muta o cache localmente sem refetch.
 *
 * NOTA: realtime na tabela `leads` ainda não é assinado por este hook
 * para preservar o comportamento atual. O CRMView continua mantendo o
 * Realtime em `messages` e usa `updateLead` para refletir mudanças.
 */
export function useLeads({ profile, showAllUnits, enabled = true }: UseLeadsOptions) {
  const queryClient = useQueryClient();

  const filters = useMemo(
    () => ({
      showAllUnits,
      isFullAdmin: profile.isFullAdmin,
      unitIds: profile.unitIds.slice().sort().join(','),
      id_unidade: profile.id_unidade,
    }),
    [showAllUnits, profile.isFullAdmin, profile.unitIds, profile.id_unidade],
  );

  const queryKey = useMemo(() => queryKeys.leads.list(filters), [filters]);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchEnrichedLeads(profile, showAllUnits),
    enabled: enabled && profile.isLoaded,
    staleTime: STALE_TIMES.list,
  });

  const refresh = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: queryKeys.leads.all });
  }, [queryClient]);

  const updateLead = useCallback(
    (leadId: string, patch: Partial<LeadWithDetails>) => {
      queryClient.setQueryData<LeadsResult>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          leads: old.leads.map((l) =>
            String(l.id) === String(leadId) ? { ...l, ...patch } : l,
          ),
        };
      });
    },
    [queryClient, queryKey],
  );

  return {
    leads: query.data?.leads ?? [],
    debugInfo: query.data?.debugInfo ?? null,
    leadsToFix: query.data?.leadsToFix ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh,
    refetch: query.refetch,
    updateLead,
  };
}
