import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { MessageSquare, Users, Clock, Activity, UserPlus, Send, ArrowUp, ArrowDown, Minus, Building2, Target, Briefcase, TrendingUp, BarChart3, Tag, CalendarDays } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@/app/components/ui/popover';
import { Calendar } from '@/app/components/ui/calendar';
import type { DateRange } from 'react-day-picker';
import { supabase } from '@/app/lib/supabase';
import { format, subDays, startOfDay, parseISO, differenceInMinutes, eachDayOfInterval, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertsAttentionPanel } from '@/app/components/AlertsAttentionPanel';

interface MetricCard {
  title: string;
  value: string;
  change: string;
  trend: 'up' | 'down' | 'neutral';
  icon: React.ReactNode;
  color: string;
  subtitle?: string;
}

const COLORS = {
  primary: '#0028e6',
  cyan: '#00e5ff',
  magenta: '#d10073',
  dark: '#600021',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  purple: '#8b5cf6',
  blue: '#3b82f6',
  indigo: '#6366f1',
  teal: '#14b8a6',
  rose: '#f43f5e',
  orange: '#f97316',
  lime: '#84cc16',
  sky: '#0ea5e9',
  amber: '#d97706',
};

const PIE_PALETTE = [COLORS.primary, COLORS.success, COLORS.warning, COLORS.magenta, COLORS.purple, COLORS.cyan, COLORS.blue, COLORS.orange, COLORS.teal, COLORS.rose];

// ── Custom Tooltip para PieCharts: mostra contagem no hover ──
function PieTooltip({ active, payload }: any) {
  if (active && payload && payload.length) {
    const entry = payload[0];
    return (
      <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-lg">
        <p className="text-sm font-semibold text-slate-900">{entry.name}</p>
        <p className="text-sm text-slate-600">{entry.value} registros</p>
      </div>
    );
  }
  return null;
}

// ── Custom Legend para PieCharts: mostra nome + porcentagem ──
function renderPieLegend(dataWithPercentage: { name: string; percentage: string }[]) {
  return (props: any) => {
    const { payload } = props;
    return (
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
        {payload?.map((entry: any, index: number) => {
          const item = dataWithPercentage.find(d => d.name === entry.value);
          return (
            <span key={`legend-${index}`} className="flex items-center gap-1.5 text-xs text-slate-600">
              <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: entry.color }} />
              {entry.value} ({item?.percentage || '0'}%)
            </span>
          );
        })}
      </div>
    );
  };
}

// ── Cores para status das conversas ──
const STATUS_COLORS: Record<string, string> = {
  'Abertas': COLORS.success,
  'Fechadas': COLORS.primary,
  'Pendentes': COLORS.warning,
  'Aguardando Cliente': COLORS.orange,
};

// ── Cores para situação dos leads ──
const LEAD_STATUS_COLORS: Record<string, string> = {
  'Novo': COLORS.blue,
  'Contato Feito': COLORS.purple,
  'Visita Agendada': COLORS.amber,
  'Visita Realizada': COLORS.cyan,
  'Visita Cancelada': COLORS.orange,
  'Matriculado': COLORS.success,
  'Perdido': COLORS.danger,
};

// ── Cores para categorias de contatos ──
const CATEGORY_COLORS: Record<string, string> = {
  'Lead': COLORS.blue,
  'Cliente': COLORS.success,
  'Novo contato': COLORS.purple,
  'Sem Categoria': '#94a3b8',
};

export function DashboardModule() {
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<MetricCard[]>([]);
  const [conversationsByDay, setConversationsByDay] = useState<any[]>([]);
  const [messagesByHour, setMessagesByHour] = useState<any[]>([]);
  const [conversationsByStatus, setConversationsByStatus] = useState<any[]>([]);
  const [topAgents, setTopAgents] = useState<any[]>([]);
  const [responseTimeData, setResponseTimeData] = useState<any[]>([]);
  const [messageTypeDistribution, setMessageTypeDistribution] = useState<any[]>([]);
  const [selectedUnit, setSelectedUnit] = useState<string>('all');
  const [availableUnits, setAvailableUnits] = useState<{ id: number; name: string }[]>([]);
  // dateRange = o que está aplicado (dispara fetch)
  // draftRange = o que o usuário está selecionando no picker (não dispara nada)
  const initialRange: DateRange = { from: subDays(new Date(), 7), to: new Date() };
  const [dateRange, setDateRange] = useState<DateRange>(initialRange);
  const [draftRange, setDraftRange] = useState<DateRange>(initialRange);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // ── Estados para métricas adicionais ──
  const [conversationsByUnit, setConversationsByUnit] = useState<any[]>([]);
  const [contactsByCategory, setContactsByCategory] = useState<any[]>([]);
  const [leadsBySituation, setLeadsBySituation] = useState<any[]>([]);
  const [leadsByOrigem, setLeadsByOrigem] = useState<any[]>([]);
  const [tagsByCount, setTagsByCount] = useState<any[]>([]);

  // Carregar unidades
  useEffect(() => {
    supabase.from('units').select('id, name').order('name').then(({ data }) => {
      if (data) setAvailableUnits(data);
    });
  }, []);

  const { startDate, endDate, previousStartDate, days } = useMemo(() => {
    const from = dateRange.from ? startOfDay(dateRange.from) : startOfDay(subDays(new Date(), 7));
    const to = dateRange.to ? new Date(new Date(dateRange.to).setHours(23, 59, 59, 999)) : new Date();
    const d = Math.max(differenceInDays(to, from), 1);
    return { startDate: from, endDate: to, previousStartDate: startOfDay(subDays(from, d)), days: d };
  }, [dateRange]);

  function selectPreset(d: number) {
    const range: DateRange = { from: subDays(new Date(), d), to: new Date() };
    setDraftRange(range);
    setDateRange(range);
    setDatePickerOpen(false);
  }

  function applyDateRange() {
    if (draftRange.from && draftRange.to) {
      setDateRange(draftRange);
      setDatePickerOpen(false);
    }
  }

  useEffect(() => {
    loadDashboardData();
  }, [startDate, previousStartDate, selectedUnit]);

  // Helper: busca TODOS os registros paginando automaticamente (sem limite de 1000)
  async function fetchAll<T = any>(
    table: string,
    select: string,
    filters?: (query: any) => any,
    orderCol?: string,
    ascending = true
  ): Promise<T[]> {
    const PAGE = 1000;
    let all: T[] = [];
    let from = 0;
    let done = false;
    while (!done) {
      let query = supabase.from(table).select(select);
      if (filters) query = filters(query);
      if (orderCol) query = query.order(orderCol, { ascending });
      query = query.range(from, from + PAGE - 1);
      const { data, error } = await query;
      if (error || !data || data.length === 0) { done = true; break; }
      all = all.concat(data as T[]);
      if (data.length < PAGE) { done = true; } else { from += PAGE; }
    }
    return all;
  }

  async function loadDashboardData() {
    setLoading(true);
    try {

      // Buscar dados em paralelo — paginação automática para tabelas grandes
      const [
        conversations,
        previousConversations,
        messages,
        previousMessagesResult,
        contacts,
        previousContactsResult,
        units,
        allContacts,
        leads,
        tags,
      ] = await Promise.all([
        // Conversas do período atual (com joins)
        fetchAll('conversations',
          `*, contact:contacts!conversations_contact_id_fkey(id, wa_id, phone_number, display_name, first_name, last_name, situation), assigned_user:profiles!conversations_assigned_user_id_fkey(id, nome, sobrenome, email)`,
          (q: any) => q.gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString()),
          'created_at', false
        ),

        // Conversas do período anterior
        fetchAll('conversations', 'id, created_at, status, unit_id',
          (q: any) => q.gte('created_at', previousStartDate.toISOString()).lt('created_at', startDate.toISOString())
        ),

        // Mensagens do período atual
        fetchAll('messages', 'id, conversation_id, direction, type, sent_at',
          (q: any) => q.gte('sent_at', startDate.toISOString()).lte('sent_at', endDate.toISOString()),
          'sent_at', true
        ),

        // Mensagens do período anterior (só contagem)
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .gte('sent_at', previousStartDate.toISOString())
          .lt('sent_at', startDate.toISOString()),

        // Contatos novos do período atual
        fetchAll('contacts', 'id, created_at, unit_id',
          (q: any) => q.gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString())
        ),

        // Contatos do período anterior (só contagem)
        supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', previousStartDate.toISOString())
          .lt('created_at', startDate.toISOString()),

        // Unidades (tabela pequena)
        fetchAll('units', 'id, name'),

        // Contatos com situation
        fetchAll('contacts', 'id, situation, unit_id',
          (q: any) => q.gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString())
        ),

        // Leads do período
        fetchAll('leads', 'id, situacao, origem, created_at, id_unidade',
          (q: any) => q.gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString())
        ),

        // Tags (filtro por período feito no JS)
        fetchAll('conversation_tags', 'conversation_id, tag:tags(id, name, color)'),
      ]);

      const previousMessageCount = previousMessagesResult.count || 0;
      const previousContactCount = previousContactsResult.count || 0;

      // Aplicar filtro de unidade (client-side)
      const unitId = selectedUnit !== 'all' ? Number(selectedUnit) : null;

      const fConversations = unitId ? conversations.filter((c: any) => c.unit_id === unitId) : conversations;
      const fPrevConversations = unitId ? previousConversations.filter((c: any) => c.unit_id === unitId) : previousConversations;
      const fConvIds = new Set(fConversations.map((c: any) => c.id));
      const fMessages = unitId ? messages.filter((m: any) => fConvIds.has(m.conversation_id)) : messages;
      const fPrevConvIds = unitId ? new Set(fPrevConversations.map((c: any) => c.id)) : null;
      const fContacts = unitId ? contacts.filter((c: any) => c.unit_id === unitId) : contacts;
      const fAllContacts = unitId ? allContacts.filter((c: any) => c.unit_id === unitId) : allContacts;
      const fLeads = unitId ? leads.filter((l: any) => l.id_unidade === unitId) : leads;

      // Para contagens do período anterior com filtro, recalcular
      const fPrevMessageCount = unitId
        ? messages.filter((m: any) => fPrevConvIds && fPrevConvIds.has(m.conversation_id)).length
        : previousMessageCount;
      const fPrevContactCount = unitId
        ? contacts.filter((c: any) => c.unit_id === unitId).length // aproximação
        : previousContactCount;

      if (fConversations.length > 0 || fMessages.length > 0) {
        calculateMetrics(fConversations, fPrevConversations, fMessages, fPrevMessageCount, fContacts, fPrevContactCount, fLeads);
        calculateConversationsByDay(fConversations);
        calculateMessagesByHour(fMessages);
        calculateConversationsByStatus(fConversations);
        calculateTopAgents(fConversations);
        calculateResponseTime(fMessages);
        calculateMessageTypeDistribution(fMessages);

        // Cálculos adicionais
        calculateConversationsByUnit(fConversations, units);
        calculateContactsByCategory(fAllContacts);
        calculateLeadsBySituation(fLeads);
        calculateLeadsByOrigem(fLeads);
        // Filtrar tags apenas das conversas do período + unidade
        const periodTags = tags.filter((t: any) => fConvIds.has(t.conversation_id));
        calculateTagsByCount(periodTags);
      } else {
        // Limpar dados quando não há resultados
        setMetrics([]);
        setConversationsByDay([]);
        setMessagesByHour([]);
        setConversationsByStatus([]);
        setTopAgents([]);
        setResponseTimeData([]);
        setMessageTypeDistribution([]);
        setConversationsByUnit([]);
        setContactsByCategory([]);
        setLeadsBySituation([]);
        setLeadsByOrigem([]);
        setTagsByCount([]);
      }

    } catch (error) {
    } finally {
      setLoading(false);
    }
  }

  // ═══════════════════════════════════════════════
  // CÁLCULOS EXISTENTES
  // ═══════════════════════════════════════════════

  function calculateMetrics(
    conversations: any[],
    previousConversations: any[],
    messages: any[],
    previousMessageCount: number,
    contacts: any[],
    previousContactCount: number,
    leads: any[]
  ) {
    const totalConversations = conversations.length;
    const previousTotal = previousConversations.length;
    const conversationChange = previousTotal > 0
      ? (((totalConversations - previousTotal) / previousTotal) * 100).toFixed(1)
      : '0';

    const totalMessages = messages.length;
    const messageChange = previousMessageCount > 0
      ? (((totalMessages - previousMessageCount) / previousMessageCount) * 100).toFixed(1)
      : '0';

    const activeConversations = conversations.filter(c => c.status === 'open').length;
    const closedConversations = conversations.filter(c => c.status === 'closed').length;
    const avgResponseTime = calculateAverageResponseTime(messages);
    const newContacts = contacts.length;
    const totalLeads = leads.length;

    // % de contatos comparado ao período anterior (corrigido: compara contatos com contatos)
    const contactChange = previousContactCount > 0
      ? (((newContacts - previousContactCount) / previousContactCount) * 100).toFixed(1)
      : (newContacts > 0 ? '+100' : '0');

    const metricsData: MetricCard[] = [
      {
        title: 'Total de Conversas',
        value: totalConversations.toString(),
        change: `${conversationChange}%`,
        trend: parseFloat(conversationChange) >= 0 ? 'up' : 'down',
        icon: <MessageSquare className="w-5 h-5" />,
        color: COLORS.primary,
        subtitle: `${activeConversations} ativas`,
      },
      {
        title: 'Mensagens Trocadas',
        value: totalMessages.toString(),
        change: `${messageChange}%`,
        trend: parseFloat(messageChange) >= 0 ? 'up' : 'down',
        icon: <Send className="w-5 h-5" />,
        color: COLORS.cyan,
        subtitle: `${messages.filter(m => m.direction === 'inbound').length} recebidas / ${messages.filter(m => m.direction === 'outbound').length} enviadas`,
      },
      {
        title: 'Novos Contatos',
        value: newContacts.toString(),
        change: `${contactChange}%`,
        trend: parseFloat(contactChange) > 0 ? 'up' : parseFloat(contactChange) < 0 ? 'down' : 'neutral',
        icon: <UserPlus className="w-5 h-5" />,
        color: COLORS.success,
        subtitle: 'No período',
      },
      {
        title: 'Leads Captados',
        value: totalLeads.toString(),
        change: '',
        trend: 'neutral',
        icon: <Target className="w-5 h-5" />,
        color: COLORS.purple,
        subtitle: `${leads.filter(l => l.situacao === 'matriculado').length} matriculados`,
      },
      {
        title: 'Tempo Médio Resposta',
        value: avgResponseTime,
        change: '',
        trend: 'neutral',
        icon: <Clock className="w-5 h-5" />,
        color: COLORS.warning,
        subtitle: 'Primeira resposta',
      },
      {
        title: 'Taxa de Resolução',
        value: totalConversations > 0
          ? `${Math.round((closedConversations / totalConversations) * 100)}%`
          : '0%',
        change: '',
        trend: 'neutral',
        icon: <Briefcase className="w-5 h-5" />,
        color: COLORS.magenta,
        subtitle: `${closedConversations} fechadas`,
      },
    ];

    setMetrics(metricsData);
  }

  function calculateAverageResponseTime(messages: any[]): string {
    if (messages.length === 0) return '0min';

    // Agrupar mensagens por conversa (já vêm ordenadas por sent_at ASC)
    const byConversation: Record<string, any[]> = {};
    messages.forEach(m => {
      if (!byConversation[m.conversation_id]) byConversation[m.conversation_id] = [];
      byConversation[m.conversation_id].push(m);
    });

    let totalResponseTime = 0;
    let count = 0;

    // O(n): percorrer mensagens de cada conversa sequencialmente
    Object.values(byConversation).forEach(convMessages => {
      for (let i = 0; i < convMessages.length; i++) {
        if (convMessages[i].direction !== 'inbound') continue;
        // Encontrar próxima outbound na sequência
        for (let j = i + 1; j < convMessages.length; j++) {
          if (convMessages[j].direction === 'outbound') {
            const diff = differenceInMinutes(
              new Date(convMessages[j].sent_at),
              new Date(convMessages[i].sent_at)
            );
            if (diff >= 0 && diff < 1440) {
              totalResponseTime += diff;
              count++;
            }
            break;
          }
        }
      }
    });

    if (count === 0) return '0min';

    const avg = Math.round(totalResponseTime / count);
    if (avg < 60) return `${avg}min`;
    if (avg < 1440) return `${Math.round(avg / 60)}h`;
    return `${Math.round(avg / 1440)}d`;
  }

  function calculateConversationsByDay(conversations: any[]) {
    const interval = eachDayOfInterval({ start: startDate, end: endDate });

    const data = interval.map(date => {
      const dateStr = format(date, 'yyyy-MM-dd');
      const count = conversations.filter(c =>
        format(parseISO(c.created_at), 'yyyy-MM-dd') === dateStr
      ).length;

      return { date: format(date, 'dd/MM', { locale: ptBR }), conversas: count };
    });

    setConversationsByDay(data);
  }

  function calculateMessagesByHour(messages: any[]) {
    const hourCounts: Record<number, { inbound: number; outbound: number }> = {};
    for (let i = 0; i < 24; i++) {
      hourCounts[i] = { inbound: 0, outbound: 0 };
    }

    messages.forEach(msg => {
      const hour = new Date(msg.sent_at).getHours();
      if (msg.direction === 'inbound') {
        hourCounts[hour].inbound++;
      } else {
        hourCounts[hour].outbound++;
      }
    });

    const data = Object.entries(hourCounts).map(([hour, counts]) => ({
      hora: `${hour.padStart(2, '0')}h`,
      inbound: counts.inbound,
      outbound: counts.outbound,
      total: counts.inbound + counts.outbound,
    }));

    setMessagesByHour(data);
  }

  function calculateConversationsByStatus(conversations: any[]) {
    const statusCount: Record<string, number> = {};

    conversations.forEach(conv => {
      const status = conv.status || 'pending';
      statusCount[status] = (statusCount[status] || 0) + 1;
    });

    const statusLabels: Record<string, string> = {
      open: 'Abertas',
      closed: 'Fechadas',
      pending: 'Pendentes',
      waiting_customer: 'Aguardando Cliente',
    };

    const total = conversations.length;
    const data = Object.entries(statusCount)
      .filter(([_, value]) => value > 0)
      .map(([name, value]) => ({
        name: statusLabels[name] || name,
        value,
        percentage: total > 0 ? ((value / total) * 100).toFixed(1) : '0',
      }));

    setConversationsByStatus(data);
  }

  function calculateTopAgents(conversations: any[]) {
    const agentStats: Record<string, { name: string; count: number; resolved: number }> = {};

    conversations.forEach(conv => {
      if (conv.assigned_user) {
        const agentId = conv.assigned_user_id;
        const agentName = conv.assigned_user.nome && conv.assigned_user.sobrenome
          ? `${conv.assigned_user.nome} ${conv.assigned_user.sobrenome}`
          : conv.assigned_user.email || 'Sem nome';

        if (!agentStats[agentId]) {
          agentStats[agentId] = { name: agentName, count: 0, resolved: 0 };
        }
        agentStats[agentId].count++;
        if (conv.status === 'closed') {
          agentStats[agentId].resolved++;
        }
      }
    });

    const data = Object.values(agentStats)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(agent => ({
        ...agent,
        taxa: agent.count > 0 ? Math.round((agent.resolved / agent.count) * 100) : 0,
      }));

    setTopAgents(data);
  }

  function calculateResponseTime(messages: any[]) {
    const last7Days = eachDayOfInterval({
      start: startDate,
      end: endDate,
    });

    const data = last7Days.map(date => {
      const dateStr = format(date, 'dd/MM');
      const dayMessages = messages.filter(m => {
        const msgDate = new Date(m.sent_at);
        return format(msgDate, 'dd/MM') === dateStr;
      });

      // Calcular tempo de resposta real para o dia
      const inbound = dayMessages.filter(m => m.direction === 'inbound');
      const outbound = dayMessages.filter(m => m.direction === 'outbound');
      let totalTime = 0;
      let count = 0;

      inbound.forEach(inMsg => {
        const nextOut = outbound.find(o =>
          new Date(o.sent_at) > new Date(inMsg.sent_at) &&
          o.conversation_id === inMsg.conversation_id
        );
        if (nextOut) {
          const diff = differenceInMinutes(new Date(nextOut.sent_at), new Date(inMsg.sent_at));
          if (diff >= 0 && diff < 1440) {
            totalTime += diff;
            count++;
          }
        }
      });

      const avgTime = count > 0 ? Math.round(totalTime / count) : 0;

      return {
        date: dateStr,
        tempo: avgTime,
        volume: dayMessages.length,
      };
    });

    setResponseTimeData(data);
  }

  function calculateMessageTypeDistribution(messages: any[]) {
    const typeCounts: Record<string, number> = {};
    messages.forEach(msg => {
      const type = msg.type || 'text';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    });

    const typeLabels: Record<string, string> = {
      text: 'Texto',
      image: 'Imagem',
      audio: 'Áudio',
      video: 'Vídeo',
      document: 'Documento',
      template: 'Template',
    };

    const total = messages.length;
    const data = Object.entries(typeCounts).map(([type, count]) => ({
      name: typeLabels[type] || type,
      value: count,
      percentage: total > 0 ? ((count / total) * 100).toFixed(1) : '0',
    }));

    setMessageTypeDistribution(data);
  }

  // ═══════════════════════════════════════════════
  // NOVOS CÁLCULOS
  // ═══════════════════════════════════════════════

  function calculateConversationsByUnit(conversations: any[], units: any[]) {
    const unitMap: Record<string, string> = {};
    units.forEach(u => { unitMap[u.id] = u.name; });

    const unitCounts: Record<string, number> = {};
    conversations.forEach(conv => {
      const unitName = conv.unit_id ? (unitMap[conv.unit_id] || `Unidade ${conv.unit_id}`) : 'Sem Unidade';
      unitCounts[unitName] = (unitCounts[unitName] || 0) + 1;
    });

    const data = Object.entries(unitCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    setConversationsByUnit(data);
  }

  function calculateContactsByCategory(contacts: any[]) {
    const categoryCounts: Record<string, number> = {};

    contacts.forEach(contact => {
      let category = contact.situation || 'Sem Categoria';
      // Normalizar: capitalizar primeira letra
      const lower = category.toLowerCase().trim();
      if (lower === 'lead') category = 'Lead';
      else if (lower === 'cliente') category = 'Cliente';
      else if (lower === '' || lower === 'null') category = 'Sem Categoria';
      else category = category.charAt(0).toUpperCase() + category.slice(1);

      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    });

    const total = contacts.length;
    const data = Object.entries(categoryCounts)
      .map(([name, value]) => ({
        name,
        value,
        percentage: total > 0 ? ((value / total) * 100).toFixed(1) : '0',
      }))
      .sort((a, b) => b.value - a.value);

    setContactsByCategory(data);
  }

  function calculateLeadsBySituation(leads: any[]) {
    const situacaoCounts: Record<string, number> = {};

    const situacaoLabels: Record<string, string> = {
      novo: 'Novo',
      contato_feito: 'Contato Feito',
      visita_agendada: 'Visita Agendada',
      visita_realizada: 'Visita Realizada',
      visita_cancelada: 'Visita Cancelada',
      matriculado: 'Matriculado',
      perdido: 'Perdido',
    };

    leads.forEach(lead => {
      const situacao = (lead.situacao || 'novo').toLowerCase();
      const label = situacaoLabels[situacao] || situacao;
      situacaoCounts[label] = (situacaoCounts[label] || 0) + 1;
    });

    // Manter a ordem do funil
    const orderedLabels = ['Novo', 'Contato Feito', 'Visita Agendada', 'Visita Realizada', 'Visita Cancelada', 'Matriculado', 'Perdido'];
    const data = orderedLabels
      .filter(label => situacaoCounts[label] > 0)
      .map(label => ({
        name: label,
        value: situacaoCounts[label],
        color: LEAD_STATUS_COLORS[label] || COLORS.primary,
      }));

    setLeadsBySituation(data);
  }

  function calculateLeadsByOrigem(leads: any[]) {
    const origemCounts: Record<string, number> = {};

    leads.forEach(lead => {
      const origem = normalizeOrigem(lead.origem);
      origemCounts[origem] = (origemCounts[origem] || 0) + 1;
    });

    const total = leads.length;
    const sorted = Object.entries(origemCounts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const TOP_N = 8;
    const top = sorted.slice(0, TOP_N);
    const rest = sorted.slice(TOP_N);
    const grouped = rest.length > 0
      ? [...top, { name: 'Outros', value: rest.reduce((sum, r) => sum + r.value, 0) }]
      : top;

    const data = grouped.map(({ name, value }) => ({
      name,
      value,
      percentage: total > 0 ? ((value / total) * 100).toFixed(1) : '0',
    }));

    setLeadsByOrigem(data);
  }

  function normalizeOrigem(raw: unknown): string {
    if (!raw || typeof raw !== 'string') return 'Sem Origem';
    const trimmed = raw.trim();
    if (!trimmed) return 'Sem Origem';
    try {
      const url = new URL(trimmed);
      return `${url.host}${url.pathname.replace(/\/+$/, '')}` || url.host;
    } catch {
      return trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
    }
  }

  function calculateTagsByCount(tagRows: any[]) {
    const tagCounts: Record<string, { count: number; color: string }> = {};

    tagRows.forEach((row: any) => {
      // conversation_tags retorna { tag: { id, name, color } }
      const tag = row.tag;
      if (!tag || !tag.name) return;
      const tagName = tag.name;
      if (!tagCounts[tagName]) {
        tagCounts[tagName] = { count: 0, color: tag.color || '#94a3b8' };
      }
      tagCounts[tagName].count++;
    });

    const total = tagRows.length;
    const data = Object.entries(tagCounts)
      .map(([name, { count, color }]) => ({
        name,
        value: count,
        color,
        percentage: total > 0 ? ((count / total) * 100).toFixed(1) : '0',
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 15); // Top 15 tags

    setTagsByCount(data);
  }

  // ═══════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════

  // Calcular intervalo dinâmico para labels do eixo X (evita sobreposição)
  const xAxisInterval = useMemo(() => {
    const totalDays = conversationsByDay.length;
    if (totalDays <= 7) return 0; // Mostrar todos
    if (totalDays <= 15) return 1; // Pular 1
    if (totalDays <= 30) return 3; // Pular 3
    if (totalDays <= 60) return 6; // Pular 6
    return Math.floor(totalDays / 10); // ~10 labels no máximo
  }, [conversationsByDay.length]);

  const tooltipStyle = {
    backgroundColor: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50/30">
        <div className="text-center">
          <Activity className="w-12 h-12 text-[#0028e6] animate-pulse mx-auto mb-4" />
          <p className="text-slate-600 font-medium">Carregando dashboard...</p>
          <p className="text-sm text-slate-500 mt-1">Analisando dados em tempo real</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br from-slate-50 to-blue-50/30 p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-slate-900 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#0028e6] to-[#00e5ff] flex items-center justify-center shadow-lg">
                  <Activity className="w-6 h-6 text-white" />
                </div>
                Dashboard
              </h1>
              <p className="text-slate-600 mt-1">Análise completa do atendimento</p>
            </div>

            {/* Filtros */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Unidade */}
              <Select value={selectedUnit} onValueChange={setSelectedUnit}>
                <SelectTrigger className="h-9 text-xs border-slate-200 bg-white rounded-lg w-[160px] hover:border-[#0028e6] transition-colors">
                  <div className="flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                    <SelectValue placeholder="Unidade" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas unidades</SelectItem>
                  {availableUnits.map(unit => (
                    <SelectItem key={unit.id} value={String(unit.id)}>{unit.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Date Range Picker */}
              <Popover open={datePickerOpen} onOpenChange={(open) => {
                setDatePickerOpen(open);
                if (open) setDraftRange(dateRange);
              }}>
                <PopoverTrigger asChild>
                  <button className="h-9 px-3 text-xs font-medium bg-white border border-slate-200 rounded-lg hover:border-[#0028e6] transition-colors flex items-center gap-2 text-slate-700">
                    <CalendarDays className="w-3.5 h-3.5 text-slate-400" />
                    {dateRange.from ? (
                      <span>
                        {format(dateRange.from, "dd MMM", { locale: ptBR })}
                        {dateRange.to && ` — ${format(dateRange.to, "dd MMM yyyy", { locale: ptBR })}`}
                      </span>
                    ) : (
                      <span>Selecionar período</span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <div className="flex">
                    {/* Atalhos rápidos */}
                    <div className="border-r border-slate-100 p-3 space-y-1 min-w-[130px]">
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
                          onClick={() => selectPreset(d)}
                          className={`w-full text-left px-2 py-1.5 text-xs rounded-md transition-colors ${
                            days === d
                              ? 'bg-[#0028e6] text-white font-medium'
                              : 'text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {/* Calendário + Botão aplicar */}
                    <div className="flex flex-col">
                      <div className="p-2">
                        <Calendar
                          mode="range"
                          selected={draftRange}
                          onSelect={(range) => { if (range) setDraftRange(range); }}
                          numberOfMonths={2}
                          locale={ptBR}
                          disabled={{ after: new Date() }}
                        />
                      </div>
                      <div className="border-t border-slate-100 px-4 py-3 flex items-center justify-between">
                        <span className="text-xs text-slate-500">
                          {draftRange.from && draftRange.to ? (
                            <>
                              {format(draftRange.from, "dd/MM/yyyy", { locale: ptBR })}
                              {' — '}
                              {format(draftRange.to, "dd/MM/yyyy", { locale: ptBR })}
                            </>
                          ) : (
                            'Selecione o intervalo'
                          )}
                        </span>
                        <button
                          onClick={applyDateRange}
                          disabled={!draftRange.from || !draftRange.to}
                          className="h-8 px-4 text-xs font-medium bg-[#0028e6] text-white rounded-lg hover:bg-[#001ec0] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Aplicar
                        </button>
                      </div>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>

        {/* ── Metric Cards (6 cards) ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {metrics.map((metric, index) => (
            <Card key={index} className="border-0 shadow-md hover:shadow-xl transition-all duration-300 overflow-hidden group">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110"
                    style={{ backgroundColor: `${metric.color}15` }}
                  >
                    <div style={{ color: metric.color }}>{metric.icon}</div>
                  </div>
                  {metric.change && (
                    <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      metric.trend === 'up' ? 'bg-green-100 text-green-700' :
                      metric.trend === 'down' ? 'bg-red-100 text-red-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>
                      {metric.trend === 'up' && <ArrowUp className="w-3 h-3" />}
                      {metric.trend === 'down' && <ArrowDown className="w-3 h-3" />}
                      {metric.trend === 'neutral' && <Minus className="w-3 h-3" />}
                      {metric.change}
                    </div>
                  )}
                </div>
                <h3 className="text-2xl font-bold text-slate-900 mb-0.5">{metric.value}</h3>
                <p className="text-xs font-medium text-slate-600">{metric.title}</p>
                {metric.subtitle && (
                  <p className="text-[10px] text-slate-400 mt-0.5">{metric.subtitle}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* H1.3: Painel de Atenção (alerts SLA não resolvidos) */}
        <AlertsAttentionPanel selectedUnit={selectedUnit} />

        {/* ── ROW 1: Atividade Diária + Status das Conversas ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle>Atividade Diária</CardTitle>
              <CardDescription>Novas conversas ao longo do tempo</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={conversationsByDay}>
                  <defs>
                    <linearGradient id="colorConversas" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={11} angle={-45} textAnchor="end" height={70} interval={xAxisInterval} />
                  <YAxis stroke="#64748b" fontSize={12} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="conversas"
                    stroke={COLORS.primary}
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorConversas)"
                    name="Conversas"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Status das Conversas (PieChart corrigido) */}
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle>Distribuição por Status</CardTitle>
              <CardDescription>Status atual das conversas</CardDescription>
            </CardHeader>
            <CardContent>
              {conversationsByStatus.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={conversationsByStatus}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percentage }) => `${percentage}%`}
                      outerRadius={90}
                      innerRadius={40}
                      dataKey="value"
                      paddingAngle={2}
                    >
                      {conversationsByStatus.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={STATUS_COLORS[entry.name] || PIE_PALETTE[index % PIE_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                    <Legend content={renderPieLegend(conversationsByStatus)} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<MessageSquare />} text="Nenhuma conversa no período" />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── ROW 2: Atendimentos por Unidade + Conversas por Categoria ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Atendimentos por Unidade */}
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-[#0028e6]" />
                Atendimentos por Unidade
              </CardTitle>
              <CardDescription>Quantidade de conversas por unidade</CardDescription>
            </CardHeader>
            <CardContent>
              {conversationsByUnit.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={conversationsByUnit} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      stroke="#64748b"
                      fontSize={11}
                      width={130}
                      tick={{ fill: '#475569' }}
                    />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [`${value} conversas`, 'Total']} />
                    <Bar dataKey="count" radius={[0, 6, 6, 0]} name="Conversas">
                      {conversationsByUnit.map((_, index) => (
                        <Cell key={`unit-${index}`} fill={PIE_PALETTE[index % PIE_PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<Building2 />} text="Nenhum dado de unidades" />
              )}
            </CardContent>
          </Card>

          {/* Conversas por Categoria */}
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Briefcase className="w-5 h-5 text-[#8b5cf6]" />
                Contatos por Categoria
              </CardTitle>
              <CardDescription>Distribuição Lead vs Cliente</CardDescription>
            </CardHeader>
            <CardContent>
              {contactsByCategory.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={contactsByCategory}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ percentage }) => `${percentage}%`}
                      outerRadius={90}
                      innerRadius={40}
                      dataKey="value"
                      paddingAngle={2}
                    >
                      {contactsByCategory.map((entry, index) => (
                        <Cell key={`cat-${index}`} fill={CATEGORY_COLORS[entry.name] || PIE_PALETTE[index % PIE_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                    <Legend content={renderPieLegend(contactsByCategory)} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<Briefcase />} text="Nenhum dado de categorias" />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── ROW 3: Funil de Leads + Leads por Origem ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Funil de Leads (BarChart vertical) */}
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="w-5 h-5 text-[#0028e6]" />
                Funil de Leads
              </CardTitle>
              <CardDescription>Distribuição dos leads por etapa do funil</CardDescription>
            </CardHeader>
            <CardContent>
              {leadsBySituation.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={leadsBySituation}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10} angle={-20} textAnchor="end" height={60} />
                    <YAxis stroke="#64748b" fontSize={12} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [`${value} leads`, 'Total']} />
                    <Bar dataKey="value" radius={[6, 6, 0, 0]} name="Leads">
                      {leadsBySituation.map((entry, index) => (
                        <Cell key={`lead-${index}`} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<Target />} text="Nenhum lead no período" />
              )}
            </CardContent>
          </Card>

          {/* Leads por Origem (PieChart) */}
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-[#10b981]" />
                Leads por Origem
              </CardTitle>
              <CardDescription>De onde vêm os leads captados</CardDescription>
            </CardHeader>
            <CardContent>
              {leadsByOrigem.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={leadsByOrigem}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ percentage }) => `${percentage}%`}
                      outerRadius={90}
                      innerRadius={40}
                      dataKey="value"
                      paddingAngle={2}
                    >
                      {leadsByOrigem.map((_, index) => (
                        <Cell key={`orig-${index}`} fill={PIE_PALETTE[index % PIE_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                    <Legend content={renderPieLegend(leadsByOrigem)} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<TrendingUp />} text="Nenhum dado de origem" />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── ROW 4: Volume por Horário + Top Atendentes ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle>Volume por Horário</CardTitle>
              <CardDescription>Distribuição de mensagens ao longo do dia</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={messagesByHour}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="hora" stroke="#64748b" fontSize={10} interval={2} />
                  <YAxis stroke="#64748b" fontSize={12} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Bar dataKey="inbound" fill={COLORS.primary} radius={[4, 4, 0, 0]} name="Recebidas" />
                  <Bar dataKey="outbound" fill={COLORS.cyan} radius={[4, 4, 0, 0]} name="Enviadas" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle>Top Atendentes</CardTitle>
              <CardDescription>Atendentes com mais conversas no período</CardDescription>
            </CardHeader>
            <CardContent>
              {topAgents.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={topAgents} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} />
                    <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={11} width={120} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend />
                    <Bar dataKey="count" fill={COLORS.magenta} radius={[0, 4, 4, 0]} name="Conversas" />
                    <Bar dataKey="resolved" fill={COLORS.success} radius={[0, 4, 4, 0]} name="Resolvidas" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<Users />} text="Nenhum dado de atendentes" />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── ROW 5: Tempo de Resposta + Tipos de Mensagens ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle>Tempo de Resposta</CardTitle>
              <CardDescription>Evolução do tempo médio de primeira resposta (min)</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={responseTimeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={11} angle={-45} textAnchor="end" height={70} interval={xAxisInterval} />
                  <YAxis stroke="#64748b" fontSize={12} label={{ value: 'Minutos', angle: -90, position: 'insideLeft' }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="tempo"
                    stroke={COLORS.warning}
                    strokeWidth={3}
                    dot={{ fill: COLORS.warning, r: 5 }}
                    name="Tempo Médio (min)"
                  />
                  <Line
                    type="monotone"
                    dataKey="volume"
                    stroke={COLORS.primary}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={{ fill: COLORS.primary, r: 3 }}
                    name="Volume de msgs"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Tipos de Mensagens (PieChart corrigido) */}
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle>Tipos de Mensagens</CardTitle>
              <CardDescription>Distribuição por tipo de conteúdo</CardDescription>
            </CardHeader>
            <CardContent>
              {messageTypeDistribution.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={messageTypeDistribution}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ percentage }) => `${percentage}%`}
                      outerRadius={90}
                      innerRadius={40}
                      dataKey="value"
                      paddingAngle={2}
                    >
                      {messageTypeDistribution.map((_, index) => (
                        <Cell key={`type-${index}`} fill={PIE_PALETTE[index % PIE_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                    <Legend content={renderPieLegend(messageTypeDistribution)} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<MessageSquare />} text="Nenhuma mensagem no período" />
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── ROW 6: Conversas por Tag ── */}
        <div className="grid grid-cols-1 gap-6">
          <Card className="border-0 shadow-md overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-[#6366f1]" />
                Conversas por Tag
              </CardTitle>
              <CardDescription>Quantidade de conversas associadas a cada tag (todas as conversas)</CardDescription>
            </CardHeader>
            <CardContent>
              {tagsByCount.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(300, tagsByCount.length * 40)}>
                  <BarChart data={tagsByCount} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} allowDecimals={false} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      stroke="#64748b"
                      fontSize={11}
                      width={150}
                      tick={{ fill: '#475569' }}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value: number, _name: string, props: any) => [
                        `${value} conversas (${props.payload.percentage}%)`,
                        'Total'
                      ]}
                    />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]} name="Conversas">
                      {tagsByCount.map((entry, index) => (
                        <Cell key={`tag-${index}`} fill={entry.color || PIE_PALETTE[index % PIE_PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<Tag />} text="Nenhuma tag associada a conversas" />
              )}
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}

// ── Componente auxiliar para estados vazios ──
function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="h-[300px] flex items-center justify-center">
      <div className="text-center">
        <div className="w-12 h-12 text-slate-300 mx-auto mb-3 flex items-center justify-center">
          {icon}
        </div>
        <p className="text-slate-500 text-sm">{text}</p>
      </div>
    </div>
  );
}