/**
 * H1.3 — SLA + Alertas + Auto-close
 *
 * Painel "Atenção" para o Dashboard. Mostra alerts ativos
 * (resolved_at IS NULL) priorizados por severidade.
 *
 * Backend: sql/h1_3_sla_alerts/01_main.sql
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, Check, Loader2, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

import { supabase } from '../lib/supabase';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from './ui/utils';

interface AlertRow {
  id: number;
  type: 'sla_first_contact' | 'sla_followup' | 'sla_visit_followup' | 'conversation_unanswered';
  severity: 'low' | 'medium' | 'high';
  lead_id: string | null;
  conversation_id: number | null;
  unit_id: number | null;
  unit_name: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  lead_nome: string | null;
  lead_situacao: string | null;
  lead_telefone: string | null;
  contact_name: string | null;
  conv_id_for_link: number | null;
}

const TYPE_LABEL: Record<AlertRow['type'], string> = {
  sla_first_contact: 'Primeiro contato',
  sla_followup: 'Follow-up pendente',
  sla_visit_followup: 'Pós-visita sem update',
  conversation_unanswered: 'Conversa sem resposta',
};

const SEVERITY_STYLES: Record<AlertRow['severity'], { dot: string; chip: string; ring: string; label: string }> = {
  high: {
    dot: 'bg-red-500',
    chip: 'bg-red-50 text-red-700 border border-red-200',
    ring: 'ring-1 ring-red-100',
    label: 'Alta',
  },
  medium: {
    dot: 'bg-amber-500',
    chip: 'bg-amber-50 text-amber-700 border border-amber-200',
    ring: 'ring-1 ring-amber-100',
    label: 'Média',
  },
  low: {
    dot: 'bg-slate-400',
    chip: 'bg-slate-50 text-slate-600 border border-slate-200',
    ring: 'ring-1 ring-slate-100',
    label: 'Baixa',
  },
};

interface AlertsAttentionPanelProps {
  selectedUnit: string; // 'all' ou unit_id como string (mesmo padrão do DashboardModule)
}

const POLL_MS = 30_000;
const MAX_VISIBLE = 12;

export function AlertsAttentionPanel({ selectedUnit }: AlertsAttentionPanelProps) {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const fetchAlerts = useCallback(async () => {
    let query = supabase
      .from('alerts_with_context')
      .select('id, type, severity, lead_id, conversation_id, unit_id, unit_name, message, metadata, created_at, lead_nome, lead_situacao, lead_telefone, contact_name, conv_id_for_link')
      .is('resolved_at', null);

    if (selectedUnit !== 'all') {
      query = query.eq('unit_id', Number(selectedUnit));
    }

    // Ordena: severity high primeiro (truque: severity_rank via order client-side)
    const { data, error } = await query.order('created_at', { ascending: true }).limit(100);

    if (error) {
      console.error('[AlertsAttentionPanel] Falha ao carregar alerts:', error);
      setLoading(false);
      return;
    }

    setAlerts((data as AlertRow[]) || []);
    setLoading(false);
  }, [selectedUnit]);

  useEffect(() => {
    setLoading(true);
    fetchAlerts();
    const id = setInterval(fetchAlerts, POLL_MS);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  const sorted = useMemo(() => {
    const rank: Record<AlertRow['severity'], number> = { high: 0, medium: 1, low: 2 };
    return [...alerts].sort((a, b) => {
      const r = rank[a.severity] - rank[b.severity];
      if (r !== 0) return r;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  }, [alerts]);

  const counts = useMemo(() => {
    let high = 0, medium = 0, low = 0;
    for (const a of alerts) {
      if (a.severity === 'high') high++;
      else if (a.severity === 'medium') medium++;
      else low++;
    }
    return { high, medium, low, total: alerts.length };
  }, [alerts]);

  async function handleResolve(alertId: number) {
    if (resolvingId) return;
    setResolvingId(alertId);
    const { error } = await supabase.rpc('resolve_alert', { p_alert_id: alertId });
    if (error) {
      console.error('[AlertsAttentionPanel] resolve_alert falhou:', error);
      toast.error('Falha ao resolver', { description: error.message });
    } else {
      toast.success('Alerta resolvido');
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    }
    setResolvingId(null);
  }

  return (
    <Card className="border-0 shadow-md overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center',
                counts.high > 0 ? 'bg-red-100' : counts.medium > 0 ? 'bg-amber-100' : 'bg-slate-100'
              )}>
                <Megaphone className={cn(
                  'w-4 h-4',
                  counts.high > 0 ? 'text-red-600' : counts.medium > 0 ? 'text-amber-600' : 'text-slate-600'
                )} />
              </div>
              Atenção
              {counts.total > 0 && (
                <Badge className="ml-1 bg-slate-100 text-slate-700 hover:bg-slate-200 border-0">{counts.total}</Badge>
              )}
            </CardTitle>
            <CardDescription>Leads em violação de SLA precisam de ação</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {counts.high > 0 && (
              <span className={cn('px-2 py-1 rounded-md font-semibold', SEVERITY_STYLES.high.chip)}>
                {counts.high} alta
              </span>
            )}
            {counts.medium > 0 && (
              <span className={cn('px-2 py-1 rounded-md font-semibold', SEVERITY_STYLES.medium.chip)}>
                {counts.medium} média
              </span>
            )}
            {counts.low > 0 && (
              <span className={cn('px-2 py-1 rounded-md font-semibold', SEVERITY_STYLES.low.chip)}>
                {counts.low} baixa
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center mb-3">
              <Check className="w-6 h-6 text-emerald-600" />
            </div>
            <p className="text-sm font-medium text-slate-700">Tudo em dia</p>
            <p className="text-xs text-slate-500 mt-1">Nenhum lead em violação de SLA agora.</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {sorted.slice(0, MAX_VISIBLE).map((a) => {
              const sev = SEVERITY_STYLES[a.severity];
              const name = a.lead_nome || a.contact_name || a.lead_telefone || `Lead ${a.lead_id?.slice(0, 8) ?? a.id}`;
              const when = formatDistanceToNow(new Date(a.created_at), { addSuffix: true, locale: ptBR });
              const conversationLink = a.conv_id_for_link ? `/conversations/${a.conv_id_for_link}` : null;

              return (
                <div
                  key={a.id}
                  className={cn(
                    'flex items-start gap-3 px-3 py-2.5 rounded-lg bg-white border border-slate-100 hover:border-slate-200 transition-colors',
                    sev.ring
                  )}
                >
                  <div className={cn('w-2 h-2 rounded-full mt-2 flex-shrink-0', sev.dot)} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-900 truncate max-w-[220px]">{name}</span>
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', sev.chip)}>
                        {TYPE_LABEL[a.type]}
                      </span>
                      {a.unit_name && (
                        <span className="text-[10px] text-slate-500">· {a.unit_name}</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5 truncate">
                      {a.message || 'SLA violado'} · <span className="text-slate-400">{when}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {conversationLink && (
                      <Link
                        to={conversationLink}
                        className="inline-flex items-center gap-1 text-xs text-[#0028e6] hover:text-[#001AAA] font-medium px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                      >
                        Abrir <ArrowRight className="w-3 h-3" />
                      </Link>
                    )}
                    <Button
                      onClick={() => handleResolve(a.id)}
                      disabled={resolvingId === a.id}
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-slate-600 hover:text-emerald-700 hover:bg-emerald-50"
                    >
                      {resolvingId === a.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <>
                          <Check className="w-3 h-3 mr-1" /> Resolver
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
            {sorted.length > MAX_VISIBLE && (
              <div className="flex items-center justify-center pt-2">
                <span className="text-xs text-slate-500 inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  +{sorted.length - MAX_VISIBLE} alertas adicionais (resolva ou ajuste filtro de unidade)
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
