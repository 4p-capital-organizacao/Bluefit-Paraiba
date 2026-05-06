/**
 * H1.2 — Auto-atribuicao + Fila virtual
 *
 * Widget que mostra o tamanho da fila de conversas nao-atribuidas
 * da(s) unidade(s) do usuario e permite "Pegar proxima conversa"
 * via RPC public.claim_next_conversation(p_unit_id).
 *
 * Backend: sql/h1_2_assignment_queue/01_main.sql
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '../lib/supabase';
import { ConversationWithDetails } from '../types/database';
import { useUserProfile } from '../hooks/useUserProfile';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { cn } from './ui/utils';

interface QueueStatsRow {
  unit_id: number | null;
  unit_name: string | null;
  queue_size: number;
  waiting_over_15min: number;
  waiting_over_1h: number;
  in_progress: number;
}

interface AssignmentQueueWidgetProps {
  onClaimed: (conversation: ConversationWithDetails) => void;
  onAfterClaim?: () => void;
}

const POLL_MS = 30_000;

export function AssignmentQueueWidget({ onClaimed, onAfterClaim }: AssignmentQueueWidgetProps) {
  const { profile } = useUserProfile();
  const [stats, setStats] = useState<QueueStatsRow[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<number | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);

  const canClaim = useMemo(() => {
    if (!profile.isLoaded) return false;
    const cargo = (profile.cargoName || '').toLowerCase();
    if (!cargo || cargo === 'sem cargo') return false;
    return ['atendente', 'supervisor', 'gerente', 'administrador'].some(r => cargo.includes(r));
  }, [profile.cargoName, profile.isLoaded]);

  const userUnitIds = useMemo(() => {
    if (profile.unitIds.length > 0) return profile.unitIds;
    return profile.id_unidade ? [profile.id_unidade] : [];
  }, [profile.unitIds, profile.id_unidade]);

  const visibleStats = useMemo(() => {
    if (profile.isFullAdmin) return stats.filter(s => s.unit_id !== null);
    return stats.filter(s => s.unit_id !== null && userUnitIds.includes(s.unit_id));
  }, [stats, profile.isFullAdmin, userUnitIds]);

  const activeStat = useMemo(() => {
    if (selectedUnit === null) return null;
    return visibleStats.find(s => s.unit_id === selectedUnit) || null;
  }, [visibleStats, selectedUnit]);

  const fetchStats = useCallback(async () => {
    if (!canClaim) return;
    setLoadingStats(true);
    const { data, error } = await supabase
      .from('assignment_queue_stats')
      .select('unit_id, unit_name, queue_size, waiting_over_15min, waiting_over_1h, in_progress');
    if (error) {
      console.error('[AssignmentQueueWidget] Falha ao carregar stats:', error);
    } else if (data) {
      setStats(data as QueueStatsRow[]);
    }
    setLoadingStats(false);
  }, [canClaim]);

  useEffect(() => {
    if (!canClaim) return;
    fetchStats();
    const id = setInterval(fetchStats, POLL_MS);
    return () => clearInterval(id);
  }, [canClaim, fetchStats]);

  // Seleciona unidade default: primeira disponivel com fila > 0, senao a primary do usuario, senao a primeira
  useEffect(() => {
    if (selectedUnit !== null) return;
    if (visibleStats.length === 0) return;
    const withQueue = visibleStats.find(s => s.queue_size > 0);
    const primaryFromProfile = profile.id_unidade
      ? visibleStats.find(s => s.unit_id === profile.id_unidade)
      : null;
    const fallback = withQueue ?? primaryFromProfile ?? visibleStats[0];
    if (fallback?.unit_id != null) setSelectedUnit(fallback.unit_id);
  }, [visibleStats, selectedUnit, profile.id_unidade]);

  async function loadConversationDetails(id: number | string): Promise<ConversationWithDetails | null> {
    const { data: convData, error } = await supabase
      .from('conversations')
      .select(`
        *,
        contact:contacts(*),
        assigned_user:profiles(*),
        unit:units(*)
      `)
      .eq('id', id)
      .single();

    if (error || !convData) {
      console.error('[AssignmentQueueWidget] Falha ao carregar conversa pos-claim:', error);
      return null;
    }

    const { data: tagsData } = await supabase
      .from('conversation_tags')
      .select('tag:tags(*)')
      .eq('conversation_id', id);

    const tags = tagsData?.map((ct: any) => ct.tag).filter(Boolean) || [];

    const { data: recentMessages } = await supabase
      .from('messages')
      .select('direction')
      .eq('conversation_id', id)
      .order('sent_at', { ascending: false })
      .limit(20);

    let pendingCount = 0;
    if (recentMessages) {
      for (const msg of recentMessages) {
        if (msg.direction === 'inbound') pendingCount++;
        else if (msg.direction === 'outbound') break;
      }
    }

    return { ...convData, tags, pending_messages_count: pendingCount } as ConversationWithDetails;
  }

  async function handleClaim() {
    if (claiming || selectedUnit === null) return;
    setClaiming(true);
    try {
      const { data, error } = await supabase.rpc('claim_next_conversation', { p_unit_id: selectedUnit });

      if (error) {
        console.error('[AssignmentQueueWidget] Erro no claim:', error);
        toast.error('Nao foi possivel pegar proxima conversa', { description: error.message });
        return;
      }

      // RPC retorna 1 row (conversations) ou null
      const claimed = Array.isArray(data) ? data[0] : data;
      if (!claimed) {
        toast.info('Fila vazia', { description: 'Nenhuma conversa aguardando atribuicao nesta unidade.' });
        await fetchStats();
        return;
      }

      const full = await loadConversationDetails(claimed.id);
      if (!full) {
        toast.error('Conversa atribuida, mas falhou ao carregar detalhes. Atualize a lista.');
        await fetchStats();
        return;
      }

      toast.success('Conversa atribuida a voce', {
        description: full.contact?.display_name || full.contact?.phone_number || `Conversa #${full.id}`,
      });
      onClaimed(full);
      onAfterClaim?.();
      await fetchStats();
    } finally {
      setClaiming(false);
    }
  }

  if (!canClaim || visibleStats.length === 0) return null;

  const showSelect = visibleStats.length > 1;
  const total = activeStat?.queue_size ?? 0;
  const over1h = activeStat?.waiting_over_1h ?? 0;

  return (
    <div className="px-5 pt-3 pb-3 border-b border-[#E5E7EB] bg-white">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex items-center gap-2 px-2.5 h-9 rounded-md bg-[#F3F3F3] text-[12px] font-medium text-[#1B1B1B] flex-shrink-0',
            total > 0 ? 'border border-amber-300' : 'border border-[#E5E7EB]'
          )}
        >
          <Inbox className="w-3.5 h-3.5 text-[#4B5563]" />
          <span>
            {loadingStats && stats.length === 0 ? '…' : total} na fila
          </span>
          {over1h > 0 && (
            <span className="text-[10px] text-amber-700 font-semibold">
              +{over1h} &gt;1h
            </span>
          )}
        </div>

        {showSelect && (
          <Select
            value={selectedUnit !== null ? String(selectedUnit) : ''}
            onValueChange={(v) => setSelectedUnit(Number(v))}
          >
            <SelectTrigger className="flex-1 h-9 text-xs border-[#E5E7EB] bg-[#F3F3F3] rounded-md min-w-0 hover:border-[#0023D5] transition-colors duration-150 text-[#1B1B1B]">
              <SelectValue placeholder="Unidade" />
            </SelectTrigger>
            <SelectContent>
              {visibleStats.map((s) => (
                <SelectItem key={s.unit_id ?? 'na'} value={String(s.unit_id)}>
                  {s.unit_name || `Unidade ${s.unit_id}`} ({s.queue_size})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          onClick={handleClaim}
          disabled={claiming || total === 0 || selectedUnit === null}
          size="sm"
          className="h-9 bg-[#0023D5] hover:bg-[#001AAA] text-white text-xs font-medium px-3 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150 ml-auto"
        >
          {claiming ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Atribuindo…
            </>
          ) : (
            <>Pegar próxima</>
          )}
        </Button>
      </div>
    </div>
  );
}
