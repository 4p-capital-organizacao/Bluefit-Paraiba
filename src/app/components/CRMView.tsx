import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { LeadWithDetails, LeadStatus, ConversationWithDetails } from '../types/database';
import { supabase } from '../lib/supabase';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { useUserProfile } from '../hooks/useUserProfile';
import { useLeads } from '../hooks/useLeads';
import { useUnits } from '../hooks/useUnits';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { LeadsKanban } from './crm/LeadsKanban';
import { LeadsList } from './crm/LeadsList';
import { LeadFormDialog } from './crm/LeadFormDialog';
import { DeleteLeadDialog } from './crm/DeleteLeadDialog';
import { CrmChatModal } from './crm/CrmChatModal';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { LayoutGrid, List, Plus, Search, Filter, ChevronLeft, ChevronRight, Building2, Shield, RefreshCw, Star, Loader2, AlertTriangle, CalendarDays } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Calendar } from './ui/calendar';
import { cn } from './ui/utils';
import { toast } from 'sonner';
import { startOfDay, endOfDay, subDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { DateRange } from 'react-day-picker';

type ViewMode = 'kanban' | 'list';
type ScoreFilter = 'all' | 'sem_nota' | '0-20' | '21-40' | '41-60' | '61-80' | '81-100';

export function CRMView() {
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearchTerm = useDebouncedValue(searchTerm, 300);
  const [statusFilter, setStatusFilter] = useState<LeadStatus | 'all'>('all');
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>('all');
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadWithDetails | null>(null);
  const [leadToDelete, setLeadToDelete] = useState<LeadWithDetails | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  // Filtro de unidade: 'all' | 'mine' | '<id da unidade>'
  const [unitFilter, setUnitFilter] = useState<string>('mine');
  // Filtro por data de criação do lead (undefined = sem filtro)
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(undefined);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [paginatedLeads, setPaginatedLeads] = useState<LeadWithDetails[]>([]);
  const ITEMS_PER_PAGE = 50;

  // 💬 Estado do fluxo WhatsApp CRM (simplificado)
  const [whatsappLead, setWhatsappLead] = useState<LeadWithDetails | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(false);
  const [crmChatConversation, setCrmChatConversation] = useState<ConversationWithDetails | null>(null);
  const [crmChatLeadName, setCrmChatLeadName] = useState('');

  // Hook de perfil do usuário
  const { profile: userProfile, loading: profileLoading, error: profileError } = useUserProfile();

  // Lista de unidades para o dropdown (admin total = todas; demais = só as suas)
  const { units: allUnits } = useUnits();
  const unitOptions = useMemo(() => {
    if (userProfile.isFullAdmin) return allUnits;
    return userProfile.unitIds.map((id) => ({
      id,
      name: userProfile.unitNames[id] || `Unidade ${id}`,
    }));
  }, [userProfile.isFullAdmin, userProfile.unitIds, userProfile.unitNames, allUnits]);

  // 🚀 Cache via React Query — substitui loadLeads/setLeads/setLoading
  const {
    leads,
    debugInfo,
    leadsToFix,
    isLoading: loading,
    isFetching,
    refetch: refetchLeads,
    updateLead,
  } = useLeads({ profile: userProfile, unitFilter });

  // Auto-corrige situacao inválida no banco (fire-and-forget) quando detectado
  useEffect(() => {
    if (leadsToFix.length === 0) return;
    supabase
      .from('leads')
      .update({ situacao: 'novo' })
      .in('id', leadsToFix)
      .then(({ error }) => {
        if (error) console.warn('[CRMView] auto-fix situacao falhou:', error);
      });
  }, [leadsToFix]);

  // Filtros memoizados (search debounced p/ não rodar a cada tecla)
  const filteredLeads = useMemo(() => {
    let filtered: LeadWithDetails[] = leads;

    if (debouncedSearchTerm.trim()) {
      const search = debouncedSearchTerm.toLowerCase();
      filtered = filtered.filter(lead =>
        lead.nome_completo?.toLowerCase().includes(search) ||
        lead.telefone?.includes(search) ||
        lead.email?.toLowerCase().includes(search) ||
        lead.origem?.toLowerCase().includes(search)
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(lead =>
        lead.situacao?.toLowerCase() === statusFilter.toLowerCase()
      );
    }

    if (scoreFilter !== 'all') {
      filtered = filtered.filter(lead => {
        const nota = lead.pontuacao;
        if (scoreFilter === 'sem_nota') {
          return nota === null || nota === undefined;
        }
        const [min, max] = scoreFilter.split('-').map(Number);
        return nota !== null && nota !== undefined && nota >= min && nota <= max;
      });
    }

    if (dateRange?.from) {
      const start = startOfDay(dateRange.from).getTime();
      const end = endOfDay(dateRange.to ?? dateRange.from).getTime();
      filtered = filtered.filter(lead => {
        if (!lead.created_at) return false;
        const t = new Date(lead.created_at).getTime();
        return t >= start && t <= end;
      });
    }

    return filtered;
  }, [leads, debouncedSearchTerm, statusFilter, scoreFilter, dateRange]);

  function selectDatePreset(d: number) {
    const today = new Date();
    const range: DateRange = { from: startOfDay(subDays(today, d)), to: today };
    setDraftRange(range);
    setDateRange(range);
    setDatePickerOpen(false);
  }

  function applyDateRange() {
    if (draftRange?.from) {
      setDateRange(draftRange);
      setDatePickerOpen(false);
    }
  }

  function clearDateRange() {
    setDateRange(undefined);
    setDraftRange(undefined);
    setDatePickerOpen(false);
  }

  // =============================================
  // 🔴 REALTIME: Escutar novas mensagens para atualizar bolinha vermelha
  // Mapa conversation_id → lead_id fica em ref para evitar re-subscribe
  // =============================================
  const convToLeadMapRef = useRef<Record<string, string>>({});

  // Montar mapa de conversas → leads quando leads com contato mudam
  useEffect(() => {
    const leadsWithContact = leads.filter(l => l.id_contact);
    if (leadsWithContact.length === 0) {
      convToLeadMapRef.current = {};
      return;
    }

    const contactToLead: Record<string, string> = {};
    for (const lead of leadsWithContact) {
      contactToLead[lead.id_contact!] = lead.id;
    }

    const contactIds = leadsWithContact.map(l => l.id_contact!);

    supabase
      .from('conversations')
      .select('id, contact_id')
      .in('contact_id', contactIds)
      .then(({ data: conversations }) => {
        if (!conversations) return;
        const map: Record<string, string> = {};
        for (const conv of conversations) {
          const leadId = contactToLead[conv.contact_id];
          if (leadId) {
            map[conv.id] = leadId;
          }
        }
        convToLeadMapRef.current = map;
      });
  }, [
    // Só recalcular quando o conjunto de leads/contacts muda, não a cada mudança de direction
    leads.map(l => `${l.id}:${l.id_contact || ''}`).join('|')
  ]);

  // Subscription Realtime na tabela messages (INSERT) — atualiza lastMessageDirection via cache
  useEffect(() => {
    const channel = supabase
      .channel('crm-kanban-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
        },
        (payload) => {
          const newMsg = payload.new as { conversation_id: string; direction: string };
          const leadId = convToLeadMapRef.current[newMsg.conversation_id];
          if (!leadId) return;

          updateLead(leadId, {
            lastMessageDirection: newMsg.direction as 'inbound' | 'outbound',
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [updateLead]);

  const handleLeadClick = useCallback((lead: LeadWithDetails) => {
    setSelectedLead(lead);
    setShowLeadForm(true);
  }, []);

  function handleNewLead() {
    setSelectedLead(null);
    setShowLeadForm(true);
  }

  // 🚀 Update otimista: muta o cache antes da resposta do banco; reverte se falhar.
  const handleStatusChange = useCallback(async (leadId: string, newStatus: LeadStatus) => {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) {
      toast.error('Lead não encontrado');
      return;
    }

    const oldStatus = lead.situacao;
    const oldDataPrimeiroContato = lead.data_primeiro_contato;
    const shouldStampPrimeiroContato =
      oldStatus === 'novo' && newStatus !== 'novo' && !lead.data_primeiro_contato;

    // 1. Otimismo: atualiza UI imediatamente
    updateLead(leadId, {
      situacao: newStatus,
      ...(shouldStampPrimeiroContato ? { data_primeiro_contato: new Date().toISOString() } : {}),
    });

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        // Reverte
        updateLead(leadId, { situacao: oldStatus, data_primeiro_contato: oldDataPrimeiroContato });
        toast.error('Usuário não autenticado');
        return;
      }

      const updateData: any = { situacao: newStatus };
      if (shouldStampPrimeiroContato) {
        updateData.data_primeiro_contato = new Date().toISOString();
      }

      const { error: updateError } = await supabase
        .from('leads')
        .update(updateData)
        .eq('id', leadId);

      if (updateError) {
        // Reverte
        updateLead(leadId, { situacao: oldStatus, data_primeiro_contato: oldDataPrimeiroContato });
        toast.error('Erro ao atualizar status');
        return;
      }

      // Histórico (não-bloqueante)
      supabase
        .from('lead_history')
        .insert({
          lead_id: leadId,
          user_id: user.id,
          field_changed: 'situacao',
          old_value: oldStatus || null,
          new_value: newStatus,
        })
        .then(({ error }) => {
          if (error) console.warn('[CRMView] lead_history insert falhou:', error);
        });

      toast.success('Status atualizado com sucesso!');
    } catch (error) {
      // Reverte
      updateLead(leadId, { situacao: oldStatus, data_primeiro_contato: oldDataPrimeiroContato });
      toast.error('Erro ao atualizar status');
    }
  }, [leads, updateLead]);

  // =============================================
  // 💬 WHATSAPP CRM FLOW (simplificado)
  // Botão WhatsApp no card → check-contact → abrir modal
  // Se lead legado (sem contato), faz onboarding automático sem template
  // =============================================

  const handleWhatsAppClick = useCallback(async (lead: LeadWithDetails) => {
    if (!lead.telefone) {
      toast.error('Este lead não possui telefone cadastrado');
      return;
    }

    setWhatsappLead(lead);
    setWhatsappLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Sessão expirada. Faça login novamente.');
        setWhatsappLead(null);
        return;
      }

      // 1) Verificar se já existe contato/conversa
      const checkResponse = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/crm/check-contact`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${publicAnonKey}`,
            'apikey': publicAnonKey,
          },
          body: JSON.stringify({
            phone: lead.telefone,
            token: session.access_token,
          }),
        }
      );

      const checkResult = await checkResponse.json();

      if (!checkResult.success) {
        toast.error(checkResult.error || 'Erro ao verificar contato');
        setWhatsappLead(null);
        return;
      }

      if (checkResult.exists && checkResult.conversation) {
        // ✅ Contato + conversa existem → abrir modal direto
        setCrmChatConversation(checkResult.conversation);
        setCrmChatLeadName(lead.nome_completo);
        setWhatsappLead(null);
        return;
      }

      // ❌ Contato NÃO existe (lead legado) → fazer onboarding automático SEM template

      const parts = lead.nome_completo.trim().split(/\s+/);
      const nome = parts[0] || lead.nome_completo;
      const sobrenome = parts.slice(1).join(' ') || null;
      const unitId = lead.id_unidade || userProfile.id_unidade;

      if (!unitId) {
        toast.error('Não foi possível identificar a unidade do lead');
        setWhatsappLead(null);
        return;
      }

      const onboardResponse = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/crm/lead-onboarding`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${publicAnonKey}`,
            'apikey': publicAnonKey,
          },
          body: JSON.stringify({
            lead_id: lead.id,
            phone: lead.telefone,
            nome,
            sobrenome,
            unit_id: unitId,
            sendTemplate: false, // Lead legado: não enviar template
            token: session.access_token,
          }),
        }
      );

      const onboardResult = await onboardResponse.json();

      if (!onboardResult.success) {
        toast.error(onboardResult.error || 'Erro ao criar contato para o lead');
        setWhatsappLead(null);
        return;
      }

      setCrmChatConversation(onboardResult.conversation);
      setCrmChatLeadName(lead.nome_completo);
      setWhatsappLead(null);
      toast.success('Contato criado e chat aberto!');

    } catch (error) {
      toast.error('Erro de conexão. Tente novamente.');
      setWhatsappLead(null);
    } finally {
      setWhatsappLoading(false);
    }
  }, [userProfile.id_unidade]);

  function handleCloseChatModal() {
    setCrmChatConversation(null);
    setCrmChatLeadName('');
  }

  // =============================================

  function handlePageChange(page: number) {
    setCurrentPage(page);
  }

  useEffect(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    setPaginatedLeads(filteredLeads.slice(start, end));
  }, [filteredLeads, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchTerm, statusFilter, scoreFilter, unitFilter, dateRange]);

  const totalPages = Math.ceil(filteredLeads.length / ITEMS_PER_PAGE);
  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, filteredLeads.length);

  function renderPagination() {
    if (viewMode === 'kanban') return null;
    if (totalPages <= 1) return null;

    const pages: number[] = [];
    const maxVisiblePages = 7;

    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 4) {
        for (let i = 1; i <= 5; i++) pages.push(i);
        pages.push(-1);
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 3) {
        pages.push(1);
        pages.push(-1);
        for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push(-1);
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push(-2);
        pages.push(totalPages);
      }
    }

    return (
      <div className="bg-white border-t border-slate-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">
            Mostrando <span className="font-semibold text-slate-900">{startItem}</span> a{' '}
            <span className="font-semibold text-slate-900">{endItem}</span> de{' '}
            <span className="font-semibold text-slate-900">{filteredLeads.length}</span> leads
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="h-9 px-3"
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              Anterior
            </Button>

            <div className="flex items-center gap-1">
              {pages.map((page, idx) => {
                if (page === -1 || page === -2) {
                  return (
                    <span key={`ellipsis-${idx}`} className="px-2 text-slate-400">
                      ...
                    </span>
                  );
                }

                return (
                  <Button
                    key={page}
                    variant={currentPage === page ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handlePageChange(page)}
                    className={cn(
                      "h-9 w-9 p-0",
                      currentPage === page && "bg-[#0028e6] hover:bg-[#0020b8] text-white"
                    )}
                  >
                    {page}
                  </Button>
                );
              })}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="h-9 px-3"
            >
              Próximo
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Banner de informação do usuário/unidade
  function renderUnitBanner() {
    if (profileLoading || !userProfile.isLoaded) return null;

    if (profileError) {
      return (
        <div className="bg-red-50 border border-red-200 px-4 py-2.5 flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
          <span className="text-sm text-red-700">
            Erro ao carregar perfil: {profileError}. Os leads podem não estar filtrados corretamente.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.location.reload()}
            className="ml-auto text-red-600 hover:text-red-700 hover:bg-red-100 h-7 px-2"
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Recarregar
          </Button>
        </div>
      );
    }

    const { isAdmin, unitName, id_cargo, nome, sobrenome } = userProfile;
    const isFullAdmin = userProfile.isFullAdmin;
    const multiUnit = userProfile.unitIds.length > 1;
    const allUnitNamesStr = Object.values(userProfile.unitNames).join(', ');

    return (
      <div className={cn(
        "px-4 py-2 flex flex-wrap items-center gap-2 md:gap-3 text-sm border-b",
        isFullAdmin
          ? "bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200"
          : "bg-gradient-to-r from-blue-50 to-cyan-50 border-blue-200"
      )}>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isFullAdmin ? (
            <Shield className="w-4 h-4 text-amber-600" />
          ) : (
            <Building2 className="w-4 h-4 text-blue-600" />
          )}
          <span className={cn(
            "font-medium",
            isFullAdmin ? "text-amber-800" : "text-blue-800"
          )}>
            {nome} {sobrenome}
          </span>
        </div>

        <div className="w-px h-4 bg-slate-300" />

        <div className="flex items-center gap-1.5">
          {isFullAdmin ? (
            <span className="text-amber-700">
              Administrador (cargo {id_cargo})
            </span>
          ) : multiUnit ? (
            <span className="text-blue-700">
              Unidades: <span className="font-semibold">{allUnitNamesStr}</span>
            </span>
          ) : (
            <span className="text-blue-700">
              {unitName
                ? <>Unidade: <span className="font-semibold">{unitName}</span></>
                : <span className="text-slate-500">Sem unidade atribuída</span>
              }
            </span>
          )}
        </div>

        {(isFullAdmin || multiUnit) && (
          <>
            <div className="w-px h-4 bg-slate-300" />
            <Select value={unitFilter} onValueChange={setUnitFilter}>
              <SelectTrigger className="h-7 w-[190px] text-xs bg-white/70 border-slate-200">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Building2 className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                {isFullAdmin && (
                  <SelectItem value="all">Todas as unidades</SelectItem>
                )}
                <SelectItem value="mine">
                  {multiUnit
                    ? `Minhas unidades (${userProfile.unitIds.length})`
                    : `Minha unidade${unitName ? ` (${unitName})` : ''}`}
                </SelectItem>
                {unitOptions.map((unit) => (
                  <SelectItem key={unit.id} value={String(unit.id)}>
                    {unit.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        {debugInfo && (
          <>
            <div className="ml-auto text-xs text-slate-500 flex items-center gap-1">
              {debugInfo}
            </div>
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetchLeads()}
          className="h-7 w-7 p-0 text-slate-500 hover:text-slate-700 ml-auto flex-shrink-0"
          title="Recarregar leads"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", (loading || isFetching) && "animate-spin")} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0 bg-slate-50">
      {/* Banner de Unidade */}
      {renderUnitBanner()}

      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-3 md:px-4 py-2.5 flex-shrink-0">
        {/* Linha 1: Título + Botão Novo Lead + Toggle View */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <h1 className="text-base md:text-lg font-bold text-slate-900 truncate">CRM - Leads</h1>

          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-0.5 bg-slate-100 rounded-md p-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setViewMode('kanban')}
                className={cn(
                  "h-7 px-2 text-xs",
                  viewMode === 'kanban' && "bg-white shadow-sm"
                )}
              >
                <LayoutGrid className="w-3.5 h-3.5 mr-1" />
                <span className="hidden sm:inline">Kanban</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setViewMode('list')}
                className={cn(
                  "h-7 px-2 text-xs",
                  viewMode === 'list' && "bg-white shadow-sm"
                )}
              >
                <List className="w-3.5 h-3.5 mr-1" />
                <span className="hidden sm:inline">Lista</span>
              </Button>
            </div>

            <Button
              onClick={handleNewLead}
              size="sm"
              className="bg-[#0028e6] hover:bg-[#0020b8] shadow-sm h-7 px-3 text-xs"
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              <span className="hidden sm:inline">Novo Lead</span>
              <span className="sm:hidden">Novo</span>
            </Button>
          </div>
        </div>

        {/* Linha 2: Filtros compactos */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <Input
              placeholder="Buscar nome, telefone, email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Select
              value={statusFilter}
              onValueChange={(value: LeadStatus | 'all') => setStatusFilter(value)}
            >
              <SelectTrigger className="w-[140px] sm:w-[150px] h-8 text-xs">
                <Filter className="w-3.5 h-3.5 mr-1 flex-shrink-0" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os status</SelectItem>
                <SelectItem value="novo">Novo</SelectItem>
                <SelectItem value="contato_feito">Contato Feito</SelectItem>
                <SelectItem value="visita_agendada">Visita Agendada</SelectItem>
                <SelectItem value="visita_realizada">Visita Realizada</SelectItem>
                <SelectItem value="visita_cancelada">Visita Cancelada</SelectItem>
                <SelectItem value="matriculado">Matriculado</SelectItem>
                <SelectItem value="perdido">Perdido</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={scoreFilter}
              onValueChange={(value: ScoreFilter) => setScoreFilter(value)}
            >
              <SelectTrigger className="w-[130px] sm:w-[140px] h-8 text-xs">
                <Star className="w-3.5 h-3.5 mr-1 flex-shrink-0" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os scores</SelectItem>
                <SelectItem value="sem_nota">Sem nota</SelectItem>
                <SelectItem value="0-20">0-20</SelectItem>
                <SelectItem value="21-40">21-40</SelectItem>
                <SelectItem value="41-60">41-60</SelectItem>
                <SelectItem value="61-80">61-80</SelectItem>
                <SelectItem value="81-100">81-100</SelectItem>
              </SelectContent>
            </Select>

            {/* Filtro por data de criação */}
            <Popover
              open={datePickerOpen}
              onOpenChange={(open) => {
                setDatePickerOpen(open);
                if (open) setDraftRange(dateRange);
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "h-8 px-2.5 text-xs font-medium bg-white border rounded-md transition-colors flex items-center gap-1.5 flex-shrink-0 hover:border-[#0028e6]",
                    dateRange?.from ? "border-[#0028e6] text-slate-700" : "border-slate-200 text-slate-500"
                  )}
                  title="Filtrar por data de criação"
                >
                  <CalendarDays className="w-3.5 h-3.5 flex-shrink-0" />
                  {dateRange?.from ? (
                    <span>
                      {format(dateRange.from, "dd/MM", { locale: ptBR })}
                      {dateRange.to && ` – ${format(dateRange.to, "dd/MM", { locale: ptBR })}`}
                    </span>
                  ) : (
                    <span>Data de criação</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <div className="flex">
                  {/* Atalhos rápidos */}
                  <div className="border-r border-slate-100 p-3 space-y-1 min-w-[150px]">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2 px-2">Atalhos</p>
                    {[
                      { label: 'Hoje', d: 0 },
                      { label: 'Últimos 7 dias', d: 7 },
                      { label: 'Últimos 15 dias', d: 15 },
                      { label: 'Últimos 30 dias', d: 30 },
                      { label: 'Últimos 60 dias', d: 60 },
                      { label: 'Últimos 90 dias', d: 90 },
                    ].map(({ label, d }) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => selectDatePreset(d)}
                        className="w-full text-left px-2 py-1.5 text-xs rounded-md text-slate-600 hover:bg-slate-50 transition-colors"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* Calendário + ações */}
                  <div className="flex flex-col">
                    <div className="p-2">
                      <Calendar
                        mode="range"
                        selected={draftRange}
                        onSelect={(range) => setDraftRange(range)}
                        numberOfMonths={2}
                        locale={ptBR}
                        disabled={{ after: new Date() }}
                      />
                    </div>
                    <div className="border-t border-slate-100 px-4 py-3 flex items-center justify-between gap-3">
                      <span className="text-xs text-slate-500">
                        {draftRange?.from ? (
                          <>
                            {format(draftRange.from, "dd/MM/yyyy", { locale: ptBR })}
                            {draftRange.to && ` – ${format(draftRange.to, "dd/MM/yyyy", { locale: ptBR })}`}
                          </>
                        ) : (
                          'Selecione o intervalo'
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        {dateRange?.from && (
                          <button
                            type="button"
                            onClick={clearDateRange}
                            className="h-8 px-3 text-xs font-medium text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
                          >
                            Limpar
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={applyDateRange}
                          disabled={!draftRange?.from}
                          className="h-8 px-4 text-xs font-medium bg-[#0028e6] text-white rounded-lg hover:bg-[#001ec0] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Aplicar
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Linha 3: Stats compactas inline */}
        <div className="flex items-center gap-1.5 mt-2 overflow-x-auto pb-0.5">
          <div className="flex items-center gap-1 bg-blue-50 border border-blue-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-blue-600 font-medium">Novos</span>
            <span className="text-xs font-bold text-blue-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'novo').length}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-purple-50 border border-purple-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-purple-600 font-medium">Contato</span>
            <span className="text-xs font-bold text-purple-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'contato_feito').length}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-amber-50 border border-amber-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-amber-600 font-medium">Agendada</span>
            <span className="text-xs font-bold text-amber-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'visita_agendada').length}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-cyan-50 border border-cyan-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-cyan-600 font-medium">Realizada</span>
            <span className="text-xs font-bold text-cyan-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'visita_realizada').length}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-orange-50 border border-orange-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-orange-600 font-medium">Cancelada</span>
            <span className="text-xs font-bold text-orange-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'visita_cancelada').length}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-green-50 border border-green-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-green-600 font-medium">Matriculado</span>
            <span className="text-xs font-bold text-green-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'matriculado').length}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-slate-100 border border-slate-300 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-slate-500 font-medium">Base fria</span>
            <span className="text-xs font-bold text-slate-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'base_fria').length}
            </span>
          </div>
          <div className="flex items-center gap-1 bg-red-50 border border-red-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-red-600 font-medium">Perdido</span>
            <span className="text-xs font-bold text-red-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'perdido').length}
            </span>
          </div>

          {/* Separador + Total geral (soma de todos os status) */}
          <div className="w-px h-4 bg-slate-300 flex-shrink-0" />
          <div className="flex items-center gap-1 bg-[#0028e6] rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-blue-100 font-medium">Total</span>
            <span className="text-xs font-bold text-white">
              {filteredLeads.length}
            </span>
          </div>
        </div>
      </div>

      {/* Conteúdo Principal */}
      <div className={cn(
        "flex-1 min-h-0 min-w-0",
        viewMode === 'kanban' ? "overflow-x-auto overflow-y-hidden p-0" : "overflow-auto p-3 md:p-6"
      )}>
        {loading || profileLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-[#0028e6] border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-slate-500">
                {profileLoading ? 'Carregando perfil...' : 'Carregando leads...'}
              </p>
            </div>
          </div>
        ) : (
          <>
            {viewMode === 'kanban' ? (
              <div className="overflow-auto h-full w-full">
                <LeadsKanban
                  leads={filteredLeads}
                  onLeadClick={handleLeadClick}
                  onStatusChange={handleStatusChange}
                  onWhatsAppClick={handleWhatsAppClick}
                />
              </div>
            ) : (
              <LeadsList
                leads={paginatedLeads}
                onLeadClick={handleLeadClick}
                onDeleteLead={(lead) => setLeadToDelete(lead)}
                canDelete={userProfile.isAdmin}
              />
            )}
          </>
        )}
      </div>

      {/* Dialog de Formulário */}
      <LeadFormDialog
        open={showLeadForm}
        onOpenChange={setShowLeadForm}
        lead={selectedLead}
        onSuccess={() => refetchLeads()}
        userProfile={userProfile}
      />

      {/* Dialog de Exclusão */}
      {leadToDelete && (
        <DeleteLeadDialog
          open={true}
          onOpenChange={(open) => { if (!open) setLeadToDelete(null); }}
          lead={leadToDelete}
          onSuccess={() => refetchLeads()}
        />
      )}

      {/* Paginação */}
      {renderPagination()}

      {/* ============================================ */}
      {/* 💬 WHATSAPP CRM FLOW - Loading Overlay */}
      {/* ============================================ */}
      {whatsappLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 shadow-2xl flex items-center gap-4 max-w-sm mx-4">
            <Loader2 className="w-6 h-6 text-[#25D366] animate-spin flex-shrink-0" />
            <div>
              <p className="font-semibold text-[#1B1B1B]">Verificando contato...</p>
              <p className="text-sm text-[#6B7280] mt-0.5">
                Buscando {whatsappLead?.nome_completo}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ============================================ */}
      {/* 💬 MODAL DE CHAT CRM */}
      {/* ============================================ */}
      {crmChatConversation && (
        <CrmChatModal
          conversation={crmChatConversation}
          leadName={crmChatLeadName}
          onClose={handleCloseChatModal}
          onConversationUpdate={() => {
            // Reload leads se necessário
          }}
        />
      )}
    </div>
  );
}