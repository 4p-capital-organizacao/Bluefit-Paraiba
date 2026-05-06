import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import { MessageSquare, Users, Clock, Activity, Send, UsersRound, CalendarDays, User, CheckCircle2, Inbox, Building2, TrendingDown } from 'lucide-react';
import { FunnelPanel } from '@/app/components/FunnelPanel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { Popover, PopoverTrigger, PopoverContent } from '@/app/components/ui/popover';
import { Calendar } from '@/app/components/ui/calendar';
import type { DateRange } from 'react-day-picker';
import { supabase } from '@/app/lib/supabase';
import { format, subDays, startOfDay, differenceInMinutes, eachDayOfInterval, differenceInDays, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useUserProfile } from '@/app/hooks/useUserProfile';

// ── Tipos ──
interface OperatorMetric {
  id: string;
  name: string;
  totalConversations: number;
  activeConversations: number;
  closedConversations: number;
  messagesSent: number;
  messagesReceived: number;
  avgResponseTimeMin: number;
  resolutionRate: number;
}

// ── Cores ──
const COLORS = {
  primary: '#0028e6',
  cyan: '#00e5ff',
  magenta: '#d10073',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  purple: '#8b5cf6',
  blue: '#3b82f6',
  orange: '#f97316',
  teal: '#14b8a6',
  rose: '#f43f5e',
  sky: '#0ea5e9',
};

const OPERATOR_PALETTE = [COLORS.primary, COLORS.success, COLORS.purple, COLORS.cyan, COLORS.orange, COLORS.rose, COLORS.teal, COLORS.blue, COLORS.warning, COLORS.magenta];

const CATEGORY_COLORS: Record<string, string> = {
  'Lead': COLORS.blue,
  'Cliente': COLORS.success,
  'Sem Categoria': '#94a3b8',
};

// ── Helpers ──
function PieTooltip({ active, payload }: any) {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-lg">
        <p className="text-sm font-semibold text-slate-900">{payload[0].name}</p>
        <p className="text-sm text-slate-600">{payload[0].value} registros</p>
      </div>
    );
  }
  return null;
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-slate-400">
      <div className="w-10 h-10 mb-2 opacity-40">{icon}</div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

function formatResponseTime(min: number): string {
  if (min === 0) return '0min';
  if (min < 60) return `${Math.round(min)}min`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

// ══════════════════════════════════════
// COMPONENTE PRINCIPAL
// ══════════════════════════════════════
export function TeamDashboardModule() {
  const { profile: userProfile } = useUserProfile();

  const [loading, setLoading] = useState(true);
  const [selectedOperator, setSelectedOperator] = useState<string>('all');
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null);

  // Date range (mesmo pattern do DashboardModule)
  const initialRange: DateRange = { from: subDays(new Date(), 7), to: new Date() };
  const [dateRange, setDateRange] = useState<DateRange>(initialRange);
  const [draftRange, setDraftRange] = useState<DateRange>(initialRange);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Dados brutos (filtrados por unidade, não por operador)
  const [operators, setOperators] = useState<{ id: string; name: string }[]>([]);
  const [operatorMetrics, setOperatorMetrics] = useState<OperatorMetric[]>([]);
  const [rawConversations, setRawConversations] = useState<any[]>([]);
  const [rawMessages, setRawMessages] = useState<any[]>([]);
  const [rawTags, setRawTags] = useState<any[]>([]);
  const [rawContacts, setRawContacts] = useState<any[]>([]);
  const [convToOpMap, setConvToOpMap] = useState<Record<number, string>>({});
  const [opNameMap, setOpNameMap] = useState<Record<string, string>>({});

  // Datas calculadas
  const { startDate, endDate, days } = useMemo(() => {
    const from = dateRange.from ? startOfDay(dateRange.from) : startOfDay(subDays(new Date(), 7));
    const to = dateRange.to ? new Date(new Date(dateRange.to).setHours(23, 59, 59, 999)) : new Date();
    const d = Math.max(differenceInDays(to, from), 1);
    return { startDate: from, endDate: to, days: d };
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

  // Paginação automática (mesmo helper do DashboardModule)
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

  // Unidades disponíveis para este usuário
  const userUnitIds = useMemo(() => {
    if (!userProfile.isLoaded) return [];
    return userProfile.unitIds.length > 0
      ? userProfile.unitIds
      : (userProfile.id_unidade != null ? [userProfile.id_unidade] : []);
  }, [userProfile.isLoaded, userProfile.unitIds, userProfile.id_unidade]);

  const hasMultipleUnits = userUnitIds.length > 1;

  // Auto-selecionar unidade ao carregar perfil
  useEffect(() => {
    if (userUnitIds.length > 0 && selectedUnitId === null) {
      // Seleciona a unidade principal (id_unidade) ou a primeira disponível
      setSelectedUnitId(userProfile.id_unidade ?? userUnitIds[0]);
    }
  }, [userUnitIds, userProfile.id_unidade]);

  // Unidade ativa para filtro (a selecionada ou fallback para a primeira)
  const activeUnitId = selectedUnitId ?? userUnitIds[0] ?? null;

  useEffect(() => {
    if (userProfile.isLoaded && activeUnitId !== null) loadData();
  }, [startDate, endDate, userProfile.isLoaded, activeUnitId]);

  async function loadData() {
    setLoading(true);
    try {
      // Sempre filtra pelo activeUnitId selecionado no header (mesmo para admin):
      // o objetivo do TeamDashboard é ter visão por unidade.
      const filterUnitIds = activeUnitId ? [activeUnitId] : userUnitIds;

      const [conversations, messages, teamProfiles, contacts, tags] = await Promise.all([
        fetchAll('conversations',
          `*, contact:contacts!conversations_contact_id_fkey(id, situation), assigned_user:profiles!conversations_assigned_user_id_fkey(id, nome, sobrenome, email)`,
          (q: any) => q.gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString()),
          'created_at', false
        ),
        fetchAll('messages', 'id, conversation_id, direction, type, sent_at',
          (q: any) => q.gte('sent_at', startDate.toISOString()).lte('sent_at', endDate.toISOString()),
          'sent_at', true
        ),
        fetchAll('profiles', 'id, nome, sobrenome, email, id_unidade, ativo',
          (q: any) => q.eq('ativo', true)
        ),
        fetchAll('contacts', 'id, situation, unit_id',
          (q: any) => q.gte('created_at', startDate.toISOString()).lte('created_at', endDate.toISOString())
        ),
        fetchAll('conversation_tags', 'conversation_id, tag:tags(id, name, color)'),
      ]);

      // Filtrar por unidade (sempre — admin/gerente/supervisor)
      const fConversations = conversations.filter((c: any) => filterUnitIds.includes(c.unit_id));
      const fConvIds = new Set(fConversations.map((c: any) => c.id));
      const fMessages = messages.filter((m: any) => fConvIds.has(m.conversation_id));
      const fContacts = contacts.filter((c: any) => filterUnitIds.includes(c.unit_id));
      const fTags = tags.filter((t: any) => fConvIds.has(t.conversation_id));

      // Operadores da unidade selecionada
      const fTeam = teamProfiles.filter((p: any) => filterUnitIds.includes(p.id_unidade));
      const ops = fTeam.map((p: any) => ({
        id: p.id,
        name: p.nome && p.sobrenome ? `${p.nome} ${p.sobrenome}` : p.email || 'Sem nome',
      }));
      setOperators(ops);

      // Calcular métricas por operador
      const opMap: Record<string, OperatorMetric> = {};
      // Inicializar todos os operadores com zeros
      ops.forEach((op: any) => {
        opMap[op.id] = {
          id: op.id, name: op.name,
          totalConversations: 0, activeConversations: 0, closedConversations: 0,
          messagesSent: 0, messagesReceived: 0, avgResponseTimeMin: 0, resolutionRate: 0,
        };
      });
      // "Não atribuído"
      opMap['__unassigned__'] = {
        id: '__unassigned__', name: 'Não atribuído',
        totalConversations: 0, activeConversations: 0, closedConversations: 0,
        messagesSent: 0, messagesReceived: 0, avgResponseTimeMin: 0, resolutionRate: 0,
      };

      // Mapear conversation_id → assigned_user_id
      const convToOp: Record<number, string> = {};
      fConversations.forEach((c: any) => {
        const opId = c.assigned_user_id || '__unassigned__';
        convToOp[c.id] = opId;
        if (!opMap[opId]) {
          opMap[opId] = {
            id: opId,
            name: c.assigned_user ? `${c.assigned_user.nome || ''} ${c.assigned_user.sobrenome || ''}`.trim() || c.assigned_user.email : 'Não atribuído',
            totalConversations: 0, activeConversations: 0, closedConversations: 0,
            messagesSent: 0, messagesReceived: 0, avgResponseTimeMin: 0, resolutionRate: 0,
          };
        }
        opMap[opId].totalConversations++;
        if (c.status === 'open') opMap[opId].activeConversations++;
        if (c.status === 'closed') opMap[opId].closedConversations++;
      });

      // Contar mensagens por operador
      fMessages.forEach((m: any) => {
        const opId = convToOp[m.conversation_id];
        if (!opId || !opMap[opId]) return;
        if (m.direction === 'outbound') opMap[opId].messagesSent++;
        else opMap[opId].messagesReceived++;
      });

      // Tempo de resposta por operador
      const msgByConv: Record<number, any[]> = {};
      fMessages.forEach((m: any) => {
        if (!msgByConv[m.conversation_id]) msgByConv[m.conversation_id] = [];
        msgByConv[m.conversation_id].push(m);
      });

      const opResponseTimes: Record<string, number[]> = {};
      Object.entries(msgByConv).forEach(([convId, msgs]) => {
        const opId = convToOp[Number(convId)];
        if (!opId) return;
        if (!opResponseTimes[opId]) opResponseTimes[opId] = [];
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i].direction !== 'inbound') continue;
          for (let j = i + 1; j < msgs.length; j++) {
            if (msgs[j].direction === 'outbound') {
              const diff = differenceInMinutes(new Date(msgs[j].sent_at), new Date(msgs[i].sent_at));
              if (diff >= 0 && diff < 1440) opResponseTimes[opId].push(diff);
              break;
            }
          }
        }
      });

      Object.entries(opResponseTimes).forEach(([opId, times]) => {
        if (times.length > 0 && opMap[opId]) {
          opMap[opId].avgResponseTimeMin = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        }
      });

      // Taxa de resolução
      Object.values(opMap).forEach(op => {
        op.resolutionRate = op.totalConversations > 0
          ? Math.round((op.closedConversations / op.totalConversations) * 100) : 0;
      });

      const metricsArr = Object.values(opMap)
        .filter(op => op.totalConversations > 0 || ops.some((o: any) => o.id === op.id))
        .sort((a, b) => b.totalConversations - a.totalConversations);

      setOperatorMetrics(metricsArr);

      // Guardar dados brutos para recalcular via useMemo quando operador mudar
      setRawConversations(fConversations);
      setRawMessages(fMessages);
      setRawTags(fTags);
      setRawContacts(fContacts);
      setConvToOpMap(convToOp);
      const nameMap: Record<string, string> = {};
      Object.values(opMap).forEach(op => { nameMap[op.id] = op.name; });
      setOpNameMap(nameMap);

    } catch (error) {
      console.error('Erro ao carregar dashboard do time:', error);
    } finally {
      setLoading(false);
    }
  }

  // ── Tudo reativo ao operador selecionado ──
  const isFiltered = selectedOperator !== 'all';

  // Conversas filtradas
  const fConvs = useMemo(() => {
    if (!isFiltered) return rawConversations;
    return rawConversations.filter((c: any) => (c.assigned_user_id || '__unassigned__') === selectedOperator);
  }, [rawConversations, selectedOperator, isFiltered]);

  const fConvIds = useMemo(() => new Set(fConvs.map((c: any) => c.id)), [fConvs]);

  // Mensagens filtradas
  const fMsgs = useMemo(() => {
    if (!isFiltered) return rawMessages;
    return rawMessages.filter((m: any) => fConvIds.has(m.conversation_id));
  }, [rawMessages, fConvIds, isFiltered]);

  // Métricas filtradas
  const filteredMetrics = useMemo(() => {
    if (!isFiltered) return operatorMetrics;
    return operatorMetrics.filter(m => m.id === selectedOperator);
  }, [operatorMetrics, selectedOperator, isFiltered]);

  const totals = useMemo(() => {
    const m = filteredMetrics;
    const withResponse = m.filter(o => o.avgResponseTimeMin > 0);
    return {
      conversations: m.reduce((s, o) => s + o.totalConversations, 0),
      sent: m.reduce((s, o) => s + o.messagesSent, 0),
      received: m.reduce((s, o) => s + o.messagesReceived, 0),
      active: m.reduce((s, o) => s + o.activeConversations, 0),
      closed: m.reduce((s, o) => s + o.closedConversations, 0),
      avgResponseTime: withResponse.length > 0 ? Math.round(withResponse.reduce((s, o) => s + o.avgResponseTimeMin, 0) / withResponse.length) : 0,
      resolutionRate: (() => { const t = m.reduce((s, o) => s + o.totalConversations, 0); const c = m.reduce((s, o) => s + o.closedConversations, 0); return t > 0 ? Math.round((c / t) * 100) : 0; })(),
      activeOperators: m.filter(o => o.totalConversations > 0 && o.id !== '__unassigned__').length,
    };
  }, [filteredMetrics]);

  // Volume por horário (reativo)
  const activityByHour = useMemo(() => {
    const hourCounts: Record<number, Record<string, number>> = {};
    for (let i = 0; i < 24; i++) hourCounts[i] = {};
    fMsgs.filter((m: any) => m.direction === 'outbound').forEach((m: any) => {
      const hour = new Date(m.sent_at).getHours();
      const opId = convToOpMap[m.conversation_id] || '__unassigned__';
      const opName = opNameMap[opId] || 'Outro';
      hourCounts[hour][opName] = (hourCounts[hour][opName] || 0) + 1;
    });
    return Object.entries(hourCounts).map(([hour, counts]) => ({
      hora: `${hour.padStart(2, '0')}h`,
      ...counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    }));
  }, [fMsgs, convToOpMap, opNameMap]);

  // Tags (reativo)
  const tagData = useMemo(() => {
    const tagCounts: Record<string, { count: number; color: string }> = {};
    rawTags.filter((t: any) => fConvIds.has(t.conversation_id)).forEach((row: any) => {
      if (!row.tag?.name) return;
      if (!tagCounts[row.tag.name]) tagCounts[row.tag.name] = { count: 0, color: row.tag.color || '#94a3b8' };
      tagCounts[row.tag.name].count++;
    });
    return Object.entries(tagCounts)
      .map(([name, { count, color }]) => ({ name, value: count, color }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [rawTags, fConvIds]);

  // Categorias de contatos (reativo)
  const categoryData = useMemo(() => {
    // Pegar contatos únicos das conversas filtradas
    const contactIds = new Set(fConvs.map((c: any) => c.contact?.id).filter(Boolean));
    const relevantContacts = contactIds.size > 0
      ? rawContacts.filter((c: any) => contactIds.has(c.id))
      : (isFiltered ? [] : rawContacts);

    const catCounts: Record<string, number> = {};
    relevantContacts.forEach((c: any) => {
      const cat = (c.situation || 'Sem Categoria').toLowerCase();
      const label = cat === 'lead' ? 'Lead' : cat === 'cliente' ? 'Cliente' : c.situation || 'Sem Categoria';
      catCounts[label] = (catCounts[label] || 0) + 1;
    });
    const total = relevantContacts.length;
    return Object.entries(catCounts).map(([name, value]) => ({
      name, value, percentage: total > 0 ? ((value / total) * 100).toFixed(1) : '0',
    }));
  }, [fConvs, rawContacts, isFiltered]);

  // Atividade diária (reativo)
  const dailyActivity = useMemo(() => {
    const interval = eachDayOfInterval({ start: startDate, end: endDate });
    return interval.map(date => {
      const dateStr = format(date, 'yyyy-MM-dd');
      const count = fConvs.filter((c: any) => format(parseISO(c.created_at), 'yyyy-MM-dd') === dateStr).length;
      return { date: format(date, 'dd/MM', { locale: ptBR }), conversas: count };
    });
  }, [fConvs, startDate, endDate]);

  // Nomes dos operadores ativos para gráficos
  const activeOpNames = useMemo(() => {
    return operatorMetrics.filter(o => o.totalConversations > 0 && o.id !== '__unassigned__').map(o => o.name);
  }, [operatorMetrics]);

  // ── Estilo tooltip ──
  const tooltipStyle = { backgroundColor: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' };

  // Unit name (da unidade selecionada)
  const unitLabel = useMemo(() => {
    if (activeUnitId && userProfile.unitNames?.[activeUnitId]) {
      return userProfile.unitNames[activeUnitId];
    }
    const names = Object.values(userProfile.unitNames || {});
    return names.length > 0 ? names.join(', ') : 'Unidade';
  }, [userProfile.unitNames, activeUnitId]);

  // ══════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50/30">
        <div className="text-center">
          <Activity className="w-12 h-12 text-[#0028e6] animate-pulse mx-auto mb-4" />
          <p className="text-slate-600 font-medium">Carregando dashboard do time...</p>
        </div>
      </div>
    );
  }

  // Dados para gráficos de comparação
  const comparisonData = operatorMetrics
    .filter(o => o.totalConversations > 0)
    .map((o, i) => ({
      name: o.name.split(' ')[0], // primeiro nome
      fullName: o.name,
      ativas: o.activeConversations,
      fechadas: o.closedConversations,
      total: o.totalConversations,
      tempo: o.avgResponseTimeMin,
      taxa: o.resolutionRate,
      color: OPERATOR_PALETTE[i % OPERATOR_PALETTE.length],
    }));

  const teamAvgResponse = comparisonData.length > 0
    ? Math.round(comparisonData.filter(d => d.tempo > 0).reduce((s, d) => s + d.tempo, 0) / (comparisonData.filter(d => d.tempo > 0).length || 1))
    : 0;

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br from-slate-50 to-blue-50/30 p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* ── Header ── */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-slate-900 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#8b5cf6] to-[#0028e6] flex items-center justify-center shadow-lg">
                  <UsersRound className="w-6 h-6 text-white" />
                </div>
                Dashboard do Time
              </h1>
              <p className="text-slate-600 mt-1">{unitLabel}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Filtro de unidade (só aparece se gerente/admin com múltiplas unidades) */}
              {hasMultipleUnits && (
                <Select value={String(activeUnitId)} onValueChange={(v) => { setSelectedUnitId(Number(v)); setSelectedOperator('all'); }}>
                  <SelectTrigger className="h-9 text-xs border-slate-200 bg-white rounded-lg w-[160px] hover:border-[#8b5cf6] transition-colors">
                    <div className="flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <SelectValue placeholder="Unidade" />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {userUnitIds.map(uid => (
                      <SelectItem key={uid} value={String(uid)}>
                        {userProfile.unitNames?.[uid] || `Unidade ${uid}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Filtro de operador */}
              <Select value={selectedOperator} onValueChange={setSelectedOperator}>
                <SelectTrigger className="h-9 text-xs border-slate-200 bg-white rounded-lg w-[180px] hover:border-[#8b5cf6] transition-colors">
                  <div className="flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                    <SelectValue placeholder="Operador" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os operadores</SelectItem>
                  {operators.map(op => (
                    <SelectItem key={op.id} value={op.id}>{op.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Date Range Picker */}
              <Popover open={datePickerOpen} onOpenChange={(open) => {
                setDatePickerOpen(open);
                if (open) setDraftRange(dateRange);
              }}>
                <PopoverTrigger asChild>
                  <button className="h-9 px-3 text-xs font-medium bg-white border border-slate-200 rounded-lg hover:border-[#8b5cf6] transition-colors flex items-center gap-2 text-slate-700">
                    <CalendarDays className="w-3.5 h-3.5 text-slate-400" />
                    {dateRange.from ? (
                      <span>
                        {format(dateRange.from, "dd MMM", { locale: ptBR })}
                        {dateRange.to && ` — ${format(dateRange.to, "dd MMM yyyy", { locale: ptBR })}`}
                      </span>
                    ) : 'Selecionar período'}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <div className="flex">
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
                          className={`w-full text-left px-2 py-1.5 text-xs rounded-md transition-colors ${days === d ? 'bg-[#8b5cf6] text-white font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
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
                          {draftRange.from && draftRange.to
                            ? `${format(draftRange.from, "dd/MM/yyyy")} — ${format(draftRange.to, "dd/MM/yyyy")}`
                            : 'Selecione o intervalo'}
                        </span>
                        <button
                          onClick={applyDateRange}
                          disabled={!draftRange.from || !draftRange.to}
                          className="h-8 px-4 text-xs font-medium bg-[#8b5cf6] text-white rounded-lg hover:bg-[#7c3aed] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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

        {/* ─────────────── 1. VISÃO OPERACIONAL ─────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1 h-5 bg-gradient-to-b from-[#8b5cf6] to-[#0028e6] rounded-full" />
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">Operação no período</h2>
          </div>

        {/* ── KPI Cards ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
          {[
            { title: 'Total Conversas', value: totals.conversations.toString(), icon: <MessageSquare className="w-5 h-5" />, color: COLORS.primary, sub: `${totals.active} ativas` },
            { title: 'Msgs Enviadas', value: totals.sent.toString(), icon: <Send className="w-5 h-5" />, color: COLORS.cyan, sub: `${totals.received} recebidas` },
            { title: 'Msgs Recebidas', value: totals.received.toString(), icon: <Inbox className="w-5 h-5" />, color: COLORS.success, sub: 'inbound' },
            { title: 'Tempo Médio Resp.', value: formatResponseTime(totals.avgResponseTime), icon: <Clock className="w-5 h-5" />, color: COLORS.warning, sub: 'primeira resposta' },
            { title: 'Taxa Resolução', value: `${totals.resolutionRate}%`, icon: <CheckCircle2 className="w-5 h-5" />, color: COLORS.magenta, sub: `${totals.closed} fechadas` },
            { title: 'Operadores Ativos', value: totals.activeOperators.toString(), icon: <Users className="w-5 h-5" />, color: COLORS.purple, sub: `de ${operators.length} no time` },
          ].map((card, i) => (
            <Card key={i} className="border-0 shadow-md hover:shadow-xl transition-all duration-300 overflow-hidden group">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110" style={{ backgroundColor: `${card.color}15` }}>
                    <div style={{ color: card.color }}>{card.icon}</div>
                  </div>
                </div>
                <h3 className="text-2xl font-bold text-slate-900 mb-0.5">{card.value}</h3>
                <p className="text-xs font-medium text-slate-600">{card.title}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">{card.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        </div>

        {/* ─────────────── 2. FUNIL DE CONVERSÃO ─────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1 h-5 bg-gradient-to-b from-[#0028e6] to-[#00e5ff] rounded-full" />
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700 flex items-center gap-1.5">
              <TrendingDown className="w-3.5 h-3.5 text-[#0028e6]" />
              Funil da unidade
            </h2>
          </div>
          <FunnelPanel
            selectedUnit={activeUnitId !== null ? String(activeUnitId) : 'all'}
            dateRange={dateRange}
          />
        </div>

        {/* ─────────────── 3. PERFORMANCE DA EQUIPE ─────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1 h-5 bg-gradient-to-b from-[#d97706] to-[#f59e0b] rounded-full" />
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">Performance da equipe</h2>
          </div>

        {/* ── Tabela Comparativa ── */}
        <Card className="border-0 shadow-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UsersRound className="w-5 h-5 text-[#8b5cf6]" />
              Comparativo por Operador
            </CardTitle>
            <CardDescription>Clique em um operador para filtrar os gráficos</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-3 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Operador</th>
                    <th className="text-center py-3 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Conversas</th>
                    <th className="text-center py-3 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Enviadas</th>
                    <th className="text-center py-3 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Recebidas</th>
                    <th className="text-center py-3 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Tempo Resp.</th>
                    <th className="text-center py-3 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Resolução</th>
                    <th className="text-center py-3 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Ativas</th>
                    <th className="text-center py-3 px-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Fechadas</th>
                  </tr>
                </thead>
                <tbody>
                  {operatorMetrics.filter(o => o.totalConversations > 0 || o.id !== '__unassigned__').map((op, i) => (
                    <tr
                      key={op.id}
                      onClick={() => setSelectedOperator(selectedOperator === op.id ? 'all' : op.id)}
                      className={`border-b border-slate-50 cursor-pointer transition-colors ${
                        selectedOperator === op.id
                          ? 'bg-[#8b5cf6]/10 border-l-2 border-l-[#8b5cf6]'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-3 px-3 font-medium text-slate-800 flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                          style={{ backgroundColor: OPERATOR_PALETTE[i % OPERATOR_PALETTE.length] }}>
                          {op.name.charAt(0)}
                        </div>
                        <span className="truncate max-w-[150px]">{op.name}</span>
                      </td>
                      <td className="py-3 px-2 text-center font-semibold text-slate-900">{op.totalConversations}</td>
                      <td className="py-3 px-2 text-center text-slate-600">{op.messagesSent}</td>
                      <td className="py-3 px-2 text-center text-slate-600">{op.messagesReceived}</td>
                      <td className="py-3 px-2 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          op.avgResponseTimeMin <= 15 ? 'bg-green-100 text-green-700' :
                          op.avgResponseTimeMin <= 60 ? 'bg-yellow-100 text-yellow-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {formatResponseTime(op.avgResponseTimeMin)}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          op.resolutionRate >= 80 ? 'bg-green-100 text-green-700' :
                          op.resolutionRate >= 50 ? 'bg-yellow-100 text-yellow-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {op.resolutionRate}%
                        </span>
                      </td>
                      <td className="py-3 px-2 text-center text-blue-600 font-medium">{op.activeConversations}</td>
                      <td className="py-3 px-2 text-center text-green-600 font-medium">{op.closedConversations}</td>
                    </tr>
                  ))}
                  {operatorMetrics.filter(o => o.totalConversations > 0).length === 0 && (
                    <tr><td colSpan={8} className="py-8 text-center text-slate-400 text-sm">Nenhum dado no período</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* ── Row 1: Conversas por Operador + Tempo de Resposta ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle>Conversas por Operador</CardTitle>
              <CardDescription>Ativas vs fechadas por atendente</CardDescription>
            </CardHeader>
            <CardContent>
              {comparisonData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={comparisonData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} />
                    <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={11} width={80} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend />
                    <Bar dataKey="ativas" stackId="a" fill={COLORS.blue} name="Ativas" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="fechadas" stackId="a" fill={COLORS.success} name="Fechadas" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyState icon={<MessageSquare />} text="Nenhum dado no período" />}
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle>Tempo de Resposta por Operador</CardTitle>
              <CardDescription>Média em minutos (linha = média do time: {formatResponseTime(teamAvgResponse)})</CardDescription>
            </CardHeader>
            <CardContent>
              {comparisonData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={comparisonData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} unit="min" />
                    <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={11} width={80} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${formatResponseTime(v)}`, 'Tempo']} />
                    <ReferenceLine x={teamAvgResponse} stroke={COLORS.danger} strokeDasharray="4 4" label={{ value: 'Média', fill: COLORS.danger, fontSize: 11 }} />
                    <Bar dataKey="tempo" name="Tempo Resp." radius={[0, 6, 6, 0]}>
                      {comparisonData.map((entry, i) => (
                        <Cell key={i} fill={entry.tempo <= 15 ? COLORS.success : entry.tempo <= 60 ? COLORS.warning : COLORS.danger} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyState icon={<Clock />} text="Nenhum dado no período" />}
            </CardContent>
          </Card>
        </div>

        {/* ── Row 2: Volume por Horário + Tags ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle>Volume por Horário</CardTitle>
              <CardDescription>Mensagens enviadas por hora do dia</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={activityByHour}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="hora" stroke="#64748b" fontSize={10} />
                  <YAxis stroke="#64748b" fontSize={12} />
                  <Tooltip contentStyle={tooltipStyle} />
                  {selectedOperator === 'all' ? (
                    activeOpNames.slice(0, 6).map((name, i) => (
                      <Bar key={name} dataKey={name} stackId="a" fill={OPERATOR_PALETTE[i % OPERATOR_PALETTE.length]} />
                    ))
                  ) : (
                    <Bar dataKey="total" fill={COLORS.primary} name="Mensagens" radius={[4, 4, 0, 0]} />
                  )}
                  {selectedOperator === 'all' && <Legend />}
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle>Conversas por Tag</CardTitle>
              <CardDescription>Top 10 tags no período</CardDescription>
            </CardHeader>
            <CardContent>
              {tagData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={tagData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} />
                    <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={11} width={120} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="value" name="Conversas" radius={[0, 6, 6, 0]}>
                      {tagData.map((entry, i) => (
                        <Cell key={i} fill={entry.color || OPERATOR_PALETTE[i % OPERATOR_PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyState icon={<MessageSquare />} text="Nenhuma tag no período" />}
            </CardContent>
          </Card>
        </div>

        {/* ── Row 3: Categorias + Atividade Diária ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle>Contatos por Categoria</CardTitle>
              <CardDescription>Lead vs Cliente no período</CardDescription>
            </CardHeader>
            <CardContent>
              {categoryData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={categoryData} cx="50%" cy="50%" outerRadius={90} innerRadius={40} dataKey="value" paddingAngle={2}
                      label={({ percentage }) => `${percentage}%`} labelLine={false}>
                      {categoryData.map((entry, i) => (
                        <Cell key={i} fill={CATEGORY_COLORS[entry.name] || OPERATOR_PALETTE[i % OPERATOR_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState icon={<Users />} text="Nenhum contato no período" />}
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle>Atividade Diária</CardTitle>
              <CardDescription>Novas conversas ao longo do período</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={dailyActivity}>
                  <defs>
                    <linearGradient id="colorTeam" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.purple} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COLORS.purple} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={12} />
                  <YAxis stroke="#64748b" fontSize={12} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="conversas" stroke={COLORS.purple} strokeWidth={2} fillOpacity={1} fill="url(#colorTeam)" name="Conversas" />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
        </div>

      </div>
    </div>
  );
}
