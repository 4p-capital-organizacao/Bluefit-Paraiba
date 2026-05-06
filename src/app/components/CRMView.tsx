import { useState, useEffect, useCallback, useRef } from 'react';
import { LeadWithDetails, LeadStatus, ConversationWithDetails } from '../types/database';
import { supabase } from '../lib/supabase';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { useUserProfile } from '../hooks/useUserProfile';
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
import { LayoutGrid, List, Plus, Search, Filter, ChevronLeft, ChevronRight, Building2, Shield, RefreshCw, Eye, EyeOff, Star, Loader2, AlertTriangle } from 'lucide-react';
import { cn } from './ui/utils';
import { toast } from 'sonner';

type ViewMode = 'kanban' | 'list';
type ScoreFilter = 'all' | 'sem_nota' | '0-20' | '21-40' | '41-60' | '61-80' | '81-100';

export function CRMView() {
  const [leads, setLeads] = useState<LeadWithDetails[]>([]);
  const [filteredLeads, setFilteredLeads] = useState<LeadWithDetails[]>([]);
  const [paginatedLeads, setPaginatedLeads] = useState<LeadWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('kanban');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<LeadStatus | 'all'>('all');
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>('all');
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadWithDetails | null>(null);
  const [leadToDelete, setLeadToDelete] = useState<LeadWithDetails | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showAllUnits, setShowAllUnits] = useState(false);
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
  const ITEMS_PER_PAGE = 50;

  // 💬 Estado do fluxo WhatsApp CRM (simplificado)
  const [whatsappLead, setWhatsappLead] = useState<LeadWithDetails | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(false);
  const [crmChatConversation, setCrmChatConversation] = useState<ConversationWithDetails | null>(null);
  const [crmChatLeadName, setCrmChatLeadName] = useState('');

  // Hook de perfil do usuário
  const { profile: userProfile, loading: profileLoading, error: profileError } = useUserProfile();

  // Carregar leads quando o perfil estiver pronto
  useEffect(() => {
    if (userProfile.isLoaded) {
      loadLeads();
    }
  }, [userProfile.isLoaded, showAllUnits]);

  useEffect(() => {
    filterLeads();
  }, [leads, searchTerm, statusFilter, scoreFilter]);

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

  // Subscription Realtime na tabela messages (INSERT)
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
          if (!leadId) return; // Mensagem não pertence a nenhum lead do CRM


          setLeads(prev => prev.map(lead =>
            lead.id === leadId
              ? { ...lead, lastMessageDirection: newMsg.direction as 'inbound' | 'outbound' }
              : lead
          ));
        }
      )
      .subscribe((status, err) => {
        if (err) {
        } else {
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []); // Subscription única, o callback usa ref que sempre está atualizado

  const loadLeads = useCallback(async () => {
    try {
      setLoading(true);
      setDebugInfo(null);

      if (!userProfile.isLoaded) {
        setLoading(false);
        return;
      }

      const { id_unidade, isAdmin, id_cargo } = userProfile;
      const unitIds = userProfile.unitIds;
      const isFullAdmin = userProfile.isFullAdmin;

      let query = supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false });

      // Apenas Administrador (isFullAdmin) pode ver todas as unidades
      const shouldFilterByUnit = !isFullAdmin || (isFullAdmin && !showAllUnits);

      if (shouldFilterByUnit && unitIds.length > 0) {
        // Filtrar por TODAS as unidades do usuário (multi-unidade)
        const unitFilters = unitIds.map(id => `id_unidade.eq.${id}`).join(',');
        query = query.or(`${unitFilters},id_unidade.is.null`);
      } else if (shouldFilterByUnit && id_unidade != null) {
        // Fallback: filtrar pela unidade principal do profiles
        query = query.or(`id_unidade.eq.${id_unidade},id_unidade.is.null`);
      } else if (!isFullAdmin && unitIds.length === 0 && id_unidade == null) {
        query = query.is('id_unidade', null);
      } else {
      }

      const { data: leadsData, error: leadsError } = await query;

      if (leadsError) {
        throw leadsError;
      }

      const totalLeads = leadsData?.length || 0;
      const unitNamesStr = unitIds.length > 0
        ? Object.values(userProfile.unitNames).join(', ')
        : userProfile.unitName || String(id_unidade);
      const debugMsg = shouldFilterByUnit && (unitIds.length > 0 || id_unidade != null)
        ? `Mostrando ${totalLeads} leads de ${unitIds.length > 1 ? `${unitIds.length} unidades` : `unidade ${unitNamesStr}`}`
        : isFullAdmin
          ? `Admin: mostrando todos os ${totalLeads} leads`
          : `Mostrando ${totalLeads} leads (sem unidade definida)`;
      setDebugInfo(debugMsg);

      if (!leadsData || leadsData.length === 0) {
        setLeads([]);
        setLoading(false);
        return;
      }

      const validStatuses = ['novo', 'contato_feito', 'visita_agendada', 'visita_realizada', 'visita_cancelada', 'matriculado', 'base_fria', 'perdido'];

      // IDs de leads que precisam de correção no banco
      const leadsToFix: string[] = [];

      const enrichedLeads = leadsData.map(lead => {
        const originalSituacao = lead.situacao;
        const isValid = originalSituacao && validStatuses.includes(originalSituacao.toLowerCase());
        
        if (!isValid) {
          leadsToFix.push(lead.id);
        }

        return {
          ...lead,
          situacao: isValid
            ? originalSituacao.toLowerCase() as LeadStatus
            : 'novo' as LeadStatus,
          lastMessageDirection: null as 'inbound' | 'outbound' | null,
        };
      });

      // Corrigir leads com situacao NULL/inválida diretamente no banco (fire-and-forget)
      if (leadsToFix.length > 0) {
        supabase
          .from('leads')
          .update({ situacao: 'novo' })
          .in('id', leadsToFix)
          .then(({ error }) => {
            if (error) {
            } else {
            }
          });
      }

      // Setar leads imediatamente para renderizar cards
      setLeads(enrichedLeads);
      setLoading(false); // Desbloquear renderização dos cards

      // ── 🔄 H2.2: enriquecer com follow-up summary (count + reactivated) em BATCH ──
      try {
        const leadIds = enrichedLeads.map(l => l.id);
        if (leadIds.length > 0) {
          const { data: summary } = await supabase
            .from('lead_followup_summary')
            .select('lead_id, followup_count, reactivated_at, recently_reactivated')
            .in('lead_id', leadIds);

          if (summary && summary.length > 0) {
            const byId = new Map(summary.map((s: any) => [s.lead_id, s]));
            setLeads(prev => prev.map(l => {
              const s = byId.get(l.id);
              return s
                ? { ...l, followup_count: s.followup_count, reactivated_at: s.reactivated_at, recently_reactivated: s.recently_reactivated }
                : l;
            }));
          }
        }
      } catch (e) {
        // Não quebra renderização se a view falhar
        console.warn('[CRMView] lead_followup_summary fetch falhou:', e);
      }

      // ── 🚀 OTIMIZAÇÃO: Buscar direção da última mensagem em BATCH (async, não bloqueia renderização) ──
      try {
        const leadsWithContact = enrichedLeads.filter(l => l.id_contact);
        if (leadsWithContact.length > 0) {
          const contactIds = leadsWithContact.map(l => l.id_contact!);
          
          // Buscar conversas dos contatos
          const { data: conversations } = await supabase
            .from('conversations')
            .select('id, contact_id')
            .in('contact_id', contactIds);

          if (conversations && conversations.length > 0) {
            const conversationIds = conversations.map(c => c.id);
            
            // 🚀 OTIMIZAÇÃO: Buscar TODAS as últimas mensagens em 1 query usando window function
            // Antes: N queries (1 por conversa) → Agora: 1 query total
            const { data: lastMessages } = await supabase
              .from('messages')
              .select('conversation_id, direction, sent_at')
              .in('conversation_id', conversationIds)
              .order('sent_at', { ascending: false });
            
            // Filtrar apenas a última mensagem de cada conversa (client-side)
            const lastMsgByConv: Record<string, string> = {};
            if (lastMessages) {
              for (const msg of lastMessages) {
                if (!lastMsgByConv[msg.conversation_id]) {
                  lastMsgByConv[msg.conversation_id] = msg.direction;
                }
              }
            }

            // Mapa: contact_id → direction da última mensagem
            const contactDirMap: Record<string, string> = {};
            for (const conv of conversations) {
              const direction = lastMsgByConv[conv.id];
              if (direction) {
                contactDirMap[conv.contact_id] = direction;
              }
            }

            // Verificar se algum lead tem mensagem inbound
            let hasChanges = false;
            const updatedLeads = enrichedLeads.map(lead => {
              if (lead.id_contact && contactDirMap[lead.id_contact]) {
                hasChanges = true;
                return { ...lead, lastMessageDirection: contactDirMap[lead.id_contact] as 'inbound' | 'outbound' };
              }
              return lead;
            });

            // Só atualizar estado se houver mudanças
            if (hasChanges) {
              setLeads(updatedLeads);
            }
          }
        }
      } catch (msgError) {
      }

    } catch (error) {
      toast.error('Erro ao carregar leads');
      setLoading(false);
    }
  }, [userProfile, showAllUnits]);

  function filterLeads() {
    let filtered = [...leads];

    if (searchTerm.trim()) {
      const search = searchTerm.toLowerCase();
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

    setFilteredLeads(filtered);
  }

  function handleLeadClick(lead: LeadWithDetails) {
    setSelectedLead(lead);
    setShowLeadForm(true);
  }

  function handleNewLead() {
    setSelectedLead(null);
    setShowLeadForm(true);
  }

  async function handleStatusChange(leadId: string, newStatus: LeadStatus) {
    try {
      const lead = leads.find(l => l.id === leadId);
      if (!lead) {
        toast.error('Lead não encontrado');
        return;
      }

      const oldStatus = lead.situacao;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error('Usuário não autenticado');
        return;
      }

      const updateData: any = {
        situacao: newStatus,
      };

      if (oldStatus === 'novo' && newStatus !== 'novo' && !lead.data_primeiro_contato) {
        updateData.data_primeiro_contato = new Date().toISOString();
      }

      const { error: updateError } = await supabase
        .from('leads')
        .update(updateData)
        .eq('id', leadId);

      if (updateError) throw updateError;

      const { error: historyError } = await supabase
        .from('lead_history')
        .insert({
          lead_id: leadId,
          user_id: user.id,
          field_changed: 'situacao',
          old_value: oldStatus || null,
          new_value: newStatus,
        });

      if (historyError) {
      }

      toast.success('Status atualizado com sucesso!');
      loadLeads();
    } catch (error) {
      toast.error('Erro ao atualizar status');
    }
  }

  // =============================================
  // 💬 WHATSAPP CRM FLOW (simplificado)
  // Botão WhatsApp no card → check-contact → abrir modal
  // Se lead legado (sem contato), faz onboarding automático sem template
  // =============================================

  async function handleWhatsAppClick(lead: LeadWithDetails) {
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
  }

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
  }, [searchTerm, statusFilter, scoreFilter]);

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

    const { isAdmin, unitName, id_unidade, id_cargo, nome, sobrenome } = userProfile;
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

        {isFullAdmin && (
          <>
            <div className="w-px h-4 bg-slate-300" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAllUnits(prev => !prev)}
              className={cn(
                "h-7 px-2.5 gap-1.5 text-xs font-medium",
                showAllUnits
                  ? "bg-amber-200/60 text-amber-800 hover:bg-amber-200"
                  : "bg-white/60 text-slate-600 hover:bg-white"
              )}
            >
              {showAllUnits ? (
                <>
                  <Eye className="w-3.5 h-3.5" />
                  Todas as unidades
                </>
              ) : (
                <>
                  <EyeOff className="w-3.5 h-3.5" />
                  {multiUnit
                    ? `Minhas unidades (${userProfile.unitIds.length})`
                    : `Minha unidade (${unitName || `ID ${id_unidade}`})`
                  }
                </>
              )}
            </Button>
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
          onClick={() => loadLeads()}
          className="h-7 w-7 p-0 text-slate-500 hover:text-slate-700 ml-auto flex-shrink-0"
          title="Recarregar leads"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
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
          <div className="flex items-center gap-1 bg-red-50 border border-red-200 rounded-md px-2 py-0.5 flex-shrink-0">
            <span className="text-[10px] text-red-600 font-medium">Perdido</span>
            <span className="text-xs font-bold text-red-700">
              {filteredLeads.filter(l => l.situacao?.toLowerCase() === 'perdido').length}
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
        onSuccess={loadLeads}
        userProfile={userProfile}
      />

      {/* Dialog de Exclusão */}
      {leadToDelete && (
        <DeleteLeadDialog
          open={true}
          onOpenChange={(open) => { if (!open) setLeadToDelete(null); }}
          lead={leadToDelete}
          onSuccess={loadLeads}
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