/**
 * H1.4 — Funil de Conversão no Dashboard
 *
 * Visualiza onde leads "vazam" no pipeline:
 *  - Funil com taxa de conversão entre stages
 *  - Tempo médio em cada stage (p50, p95) via lead_history
 *  - Top motivos de perda
 *  - Ranking de consultores por taxa de matrícula (campo responsavel)
 *  - Export CSV
 *
 * Reusa selectedUnit + dateRange do DashboardModule.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, TrendingDown, Users } from 'lucide-react';
import { differenceInHours } from 'date-fns';
import type { DateRange } from 'react-day-picker';

import { supabase } from '../lib/supabase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { cn } from './ui/utils';

const STAGE_ORDER = ['novo', 'contato_feito', 'visita_agendada', 'visita_realizada', 'matriculado'] as const;
const SIDE_STAGES = ['visita_cancelada', 'base_fria', 'perdido'] as const;
type StageKey = (typeof STAGE_ORDER)[number] | (typeof SIDE_STAGES)[number];

const STAGE_LABEL: Record<string, string> = {
  novo: 'Novo',
  contato_feito: 'Contato feito',
  visita_agendada: 'Visita agendada',
  visita_realizada: 'Visita realizada',
  matriculado: 'Matriculado',
  visita_cancelada: 'Visita cancelada',
  base_fria: 'Base fria',
  perdido: 'Perdido',
};

const STAGE_COLOR: Record<string, string> = {
  novo: '#3b82f6',
  contato_feito: '#0028e6',
  visita_agendada: '#8b5cf6',
  visita_realizada: '#d97706',
  matriculado: '#10b981',
  visita_cancelada: '#94a3b8',
  base_fria: '#64748b',
  perdido: '#ef4444',
};

interface FunnelPanelProps {
  selectedUnit: string;
  dateRange: DateRange;
}

interface LeadRow {
  id: string;
  situacao: string | null;
  motivo_cancelamento: string | null;
  responsavel: string | null;
  id_unidade: number | null;
  created_at: string;
}

interface HistoryRow {
  lead_id: string;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

interface StageStats {
  key: string;
  label: string;
  count: number;
  pctOfTop: number;
  conversionFromPrev: number | null;
  avgHours: number | null;
  p50Hours: number | null;
  p95Hours: number | null;
  color: string;
}

interface AgentRanking {
  responsavel: string;
  total: number;
  matriculados: number;
  perdidos: number;
  conversionRate: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

async function fetchAll<T>(
  table: string,
  select: string,
  filters?: (q: any) => any,
): Promise<T[]> {
  const PAGE = 1000;
  let all: T[] = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select);
    if (filters) q = filters(q);
    q = q.range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error || !data || data.length === 0) break;
    all = all.concat(data as T[]);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export function FunnelPanel({ selectedUnit, dateRange }: FunnelPanelProps) {
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const startISO = useMemo(() => (dateRange.from ?? new Date()).toISOString(), [dateRange.from]);
  const endISO = useMemo(() => {
    const d = dateRange.to ? new Date(dateRange.to) : new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }, [dateRange.to]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const unitId = selectedUnit !== 'all' ? Number(selectedUnit) : null;

    const [leadsData, historyData] = await Promise.all([
      fetchAll<LeadRow>(
        'leads',
        'id, situacao, motivo_cancelamento, responsavel, id_unidade, created_at',
        (q: any) => {
          let qq = q.gte('created_at', startISO).lte('created_at', endISO);
          if (unitId !== null) qq = qq.eq('id_unidade', unitId);
          return qq;
        },
      ),
      fetchAll<HistoryRow>(
        'lead_history',
        'lead_id, field_changed, old_value, new_value, changed_at',
        (q: any) => q.eq('field_changed', 'situacao').gte('changed_at', startISO).lte('changed_at', endISO),
      ),
    ]);

    setLeads(leadsData);
    setHistory(historyData);
    setLoading(false);
  }, [selectedUnit, startISO, endISO]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const { stages, sideStages, totalLeads, motivos, ranking, conversionMatricula } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of leads) {
      const s = l.situacao || 'novo';
      counts[s] = (counts[s] || 0) + 1;
    }

    // Tempo em cada stage: para cada lead, agrupar transições e calcular intervalos
    const byLead: Record<string, HistoryRow[]> = {};
    for (const h of history) {
      if (!byLead[h.lead_id]) byLead[h.lead_id] = [];
      byLead[h.lead_id].push(h);
    }
    for (const id in byLead) {
      byLead[id].sort((a, b) => a.changed_at.localeCompare(b.changed_at));
    }

    // Para cada stage, lista de durações (em horas) que leads passaram nele antes de sair
    const stageDurations: Record<string, number[]> = {};
    for (const id in byLead) {
      const events = byLead[id];
      for (let i = 0; i < events.length - 1; i++) {
        const stage = events[i].new_value || '';
        const dur = differenceInHours(new Date(events[i + 1].changed_at), new Date(events[i].changed_at));
        if (dur >= 0 && stage) {
          if (!stageDurations[stage]) stageDurations[stage] = [];
          stageDurations[stage].push(dur);
        }
      }
    }

    const topCount = counts[STAGE_ORDER[0]] || Math.max(...STAGE_ORDER.map((s) => counts[s] || 0), 1);

    const stagesArr: StageStats[] = STAGE_ORDER.map((key, idx) => {
      const count = counts[key] || 0;
      const prevCount = idx > 0 ? counts[STAGE_ORDER[idx - 1]] || 0 : 0;
      const conversionFromPrev = idx === 0 ? null : prevCount > 0 ? (count / prevCount) * 100 : 0;
      const durs = (stageDurations[key] || []).slice().sort((a, b) => a - b);
      const avg = durs.length > 0 ? durs.reduce((s, v) => s + v, 0) / durs.length : null;
      const p50 = durs.length > 0 ? quantile(durs, 0.5) : null;
      const p95 = durs.length > 0 ? quantile(durs, 0.95) : null;
      return {
        key,
        label: STAGE_LABEL[key],
        count,
        pctOfTop: topCount > 0 ? (count / topCount) * 100 : 0,
        conversionFromPrev,
        avgHours: avg,
        p50Hours: p50,
        p95Hours: p95,
        color: STAGE_COLOR[key],
      };
    });

    const sideArr = SIDE_STAGES.map((key) => ({
      key,
      label: STAGE_LABEL[key],
      count: counts[key] || 0,
      color: STAGE_COLOR[key],
    }));

    // Motivos de perda
    const motivosMap: Record<string, number> = {};
    for (const l of leads) {
      if ((l.situacao === 'perdido' || l.situacao === 'visita_cancelada' || l.situacao === 'base_fria') && l.motivo_cancelamento) {
        const m = l.motivo_cancelamento.trim();
        motivosMap[m] = (motivosMap[m] || 0) + 1;
      }
    }
    const motivosArr = Object.entries(motivosMap)
      .map(([motivo, count]) => ({ motivo, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    // Ranking consultor (responsavel)
    const responsibleMap: Record<string, AgentRanking> = {};
    for (const l of leads) {
      const r = (l.responsavel || '').trim() || '(sem responsável)';
      if (!responsibleMap[r]) {
        responsibleMap[r] = { responsavel: r, total: 0, matriculados: 0, perdidos: 0, conversionRate: 0 };
      }
      responsibleMap[r].total++;
      if (l.situacao === 'matriculado') responsibleMap[r].matriculados++;
      if (l.situacao === 'perdido' || l.situacao === 'visita_cancelada' || l.situacao === 'base_fria') responsibleMap[r].perdidos++;
    }
    const rankingArr = Object.values(responsibleMap)
      .map((r) => ({ ...r, conversionRate: r.total > 0 ? (r.matriculados / r.total) * 100 : 0 }))
      .filter((r) => r.total >= 5)
      .sort((a, b) => b.conversionRate - a.conversionRate)
      .slice(0, 10);

    const totalLeadsCount = leads.length;
    const matriculados = counts['matriculado'] || 0;
    const conv = totalLeadsCount > 0 ? (matriculados / totalLeadsCount) * 100 : 0;

    return {
      stages: stagesArr,
      sideStages: sideArr,
      totalLeads: totalLeadsCount,
      motivos: motivosArr,
      ranking: rankingArr,
      conversionMatricula: conv,
    };
  }, [leads, history]);

  function exportCSV() {
    const lines: string[] = [];
    lines.push('# Funil de Conversao');
    lines.push('Stage,Total,% topo,% conversao para cá,Tempo médio (h),p50 (h),p95 (h)');
    for (const s of stages) {
      lines.push(
        [
          s.label,
          s.count,
          s.pctOfTop.toFixed(1),
          s.conversionFromPrev != null ? s.conversionFromPrev.toFixed(1) : '',
          s.avgHours != null ? s.avgHours.toFixed(1) : '',
          s.p50Hours != null ? s.p50Hours.toFixed(1) : '',
          s.p95Hours != null ? s.p95Hours.toFixed(1) : '',
        ].join(','),
      );
    }
    lines.push('');
    lines.push('# Stages laterais');
    lines.push('Stage,Total');
    for (const s of sideStages) lines.push(`${s.label},${s.count}`);
    lines.push('');
    lines.push('# Top motivos de perda');
    lines.push('Motivo,Quantidade');
    for (const m of motivos) lines.push(`"${m.motivo.replace(/"/g, '""')}",${m.count}`);
    lines.push('');
    lines.push('# Ranking consultores (>=5 leads)');
    lines.push('Responsável,Total,Matriculados,Perdidos,Conversão %');
    for (const r of ranking) {
      lines.push(`"${r.responsavel.replace(/"/g, '""')}",${r.total},${r.matriculados},${r.perdidos},${r.conversionRate.toFixed(1)}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `funil_${selectedUnit}_${(dateRange.from ?? new Date()).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="border-0 shadow-md overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#0028e6]/10 to-[#00e5ff]/10 flex items-center justify-center">
                <TrendingDown className="w-4 h-4 text-[#0028e6]" />
              </div>
              Funil de Conversão
            </CardTitle>
            <CardDescription>
              {totalLeads} leads no período · taxa lead → matrícula:{' '}
              <strong className={cn(conversionMatricula >= 4 ? 'text-emerald-600' : 'text-amber-600')}>
                {conversionMatricula.toFixed(1)}%
              </strong>
            </CardDescription>
          </div>
          <Button onClick={exportCSV} variant="outline" size="sm" className="h-8 text-xs">
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Exportar CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : totalLeads === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-slate-500">Nenhum lead no período/unidade selecionados.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Funil principal */}
            <div className="space-y-2">
              {stages.map((s, idx) => (
                <div key={s.key}>
                  {idx > 0 && s.conversionFromPrev != null && (
                    <div className="flex items-center justify-end pr-2 mb-1">
                      <span
                        className={cn(
                          'text-[11px] font-semibold px-2 py-0.5 rounded',
                          s.conversionFromPrev >= 50
                            ? 'bg-emerald-50 text-emerald-700'
                            : s.conversionFromPrev >= 20
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-red-50 text-red-700',
                        )}
                      >
                        ↓ {s.conversionFromPrev.toFixed(1)}%
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <div className="w-32 flex-shrink-0">
                      <p className="text-[13px] font-medium text-slate-800">{s.label}</p>
                      <p className="text-[11px] text-slate-500">
                        {s.p50Hours != null ? `mediana ${s.p50Hours.toFixed(0)}h` : 'sem dados de tempo'}
                      </p>
                    </div>
                    <div className="flex-1 relative h-9 bg-slate-50 rounded-md overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 rounded-md transition-all duration-500 flex items-center px-3"
                        style={{ width: `${Math.max(s.pctOfTop, 4)}%`, backgroundColor: s.color }}
                      >
                        <span className="text-[12px] font-semibold text-white whitespace-nowrap">
                          {s.count}
                        </span>
                      </div>
                    </div>
                    <div className="w-12 flex-shrink-0 text-right">
                      <span className="text-[12px] font-semibold text-slate-700">{s.pctOfTop.toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Stages laterais (cancelamentos / perdas) */}
            {(sideStages[0].count > 0 || sideStages[1].count > 0) && (
              <div className="flex items-center gap-3 pt-4 border-t border-slate-100">
                <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Vazamentos</span>
                {sideStages.map((s) => (
                  <span
                    key={s.key}
                    className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md"
                    style={{ backgroundColor: `${s.color}15`, color: s.color }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}: <strong>{s.count}</strong>
                  </span>
                ))}
              </div>
            )}

            {/* Motivos de perda + Ranking lado a lado */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
              {/* Top motivos de perda */}
              <div>
                <h4 className="text-sm font-semibold text-slate-800 mb-2 flex items-center gap-1.5">
                  <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                  Top motivos de perda
                </h4>
                {motivos.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">
                    Nenhum motivo registrado em leads perdidos/cancelados no período.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {motivos.map((m) => {
                      const totalMotivos = motivos.reduce((s, x) => s + x.count, 0);
                      const pct = (m.count / totalMotivos) * 100;
                      return (
                        <div key={m.motivo} className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-slate-700 truncate">{m.motivo}</p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full bg-red-400 rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs font-semibold text-slate-600 w-6 text-right">{m.count}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Ranking consultores */}
              <div>
                <h4 className="text-sm font-semibold text-slate-800 mb-2 flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-[#0028e6]" />
                  Ranking de consultores (≥5 leads)
                </h4>
                {ranking.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">Sem responsáveis com volume suficiente no período.</p>
                ) : (
                  <div className="space-y-1.5">
                    {ranking.map((r, idx) => (
                      <div key={r.responsavel} className="flex items-center gap-2 text-xs">
                        <span className="w-5 text-slate-400 font-mono text-right">{idx + 1}</span>
                        <span className="flex-1 min-w-0 truncate text-slate-700">{r.responsavel}</span>
                        <span className="text-slate-400 w-12 text-right">{r.total} leads</span>
                        <span
                          className={cn(
                            'font-semibold w-12 text-right',
                            r.conversionRate >= 4 ? 'text-emerald-600' : 'text-slate-600',
                          )}
                        >
                          {r.conversionRate.toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
