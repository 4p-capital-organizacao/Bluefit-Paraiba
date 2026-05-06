/**
 * Painel de configuração de automação por unidade.
 * Acessível via ConfigModule → tab "Automação".
 *
 * Quem vê: Gerente+ (cargo >= 4) — RLS já filtra unit_automation_settings
 * pra mostrar só unidades acessíveis.
 *
 * Configurações por unidade:
 *  - followup_enabled (toggle ON/OFF — default OFF)
 *  - daily_cap (limite diário de envios)
 *  - threshold_hours (lead em "contato_feito" há ≥X horas)
 *  - resend_after_days (1 reenvio após N dias; null = nunca)
 *  - template_name + language (qual template usar)
 *
 * Mostra também: enviados hoje, status do template (APPROVED?), última edição.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, Loader2, Save, Zap, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '../lib/supabase';
import { fetchAvailableTemplates } from '../lib/whatsapp';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { cn } from './ui/utils';
import type { WhatsAppTemplate } from '../types/database';

interface UnitOverview {
  unit_id: number;
  unit_name: string;
  followup_enabled: boolean;
  daily_cap: number;
  threshold_hours: number;
  resend_after_days: number | null;
  template_name: string;
  template_language: string;
  sent_today: number;
  settings_updated_at: string | null;
  // H2.2
  max_followup_envios?: number;
  move_to_base_fria_enabled?: boolean;
  move_to_base_fria_after_days?: number;
}

interface DraftSettings {
  followup_enabled: boolean;
  daily_cap: number;
  threshold_hours: number;
  resend_after_days: number | null;
  template_name: string;
  template_language: string;
  // H2.2
  max_followup_envios: number;
  move_to_base_fria_enabled: boolean;
  move_to_base_fria_after_days: number;
}

export function AutomationPanel() {
  const [units, setUnits] = useState<UnitOverview[]>([]);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [drafts, setDrafts] = useState<Record<number, DraftSettings>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [overviewRes, templatesData] = await Promise.all([
      supabase.from('unit_automation_overview').select('*'),
      fetchAvailableTemplates({ includeAllStatuses: true }),
    ]);
    if (overviewRes.error) {
      toast.error('Falha ao carregar configurações', { description: overviewRes.error.message });
      setLoading(false);
      return;
    }
    const ov = (overviewRes.data as UnitOverview[]) || [];
    setUnits(ov);
    setTemplates(templatesData);
    const initial: Record<number, DraftSettings> = {};
    for (const r of ov) {
      initial[r.unit_id] = {
        followup_enabled: r.followup_enabled,
        daily_cap: r.daily_cap,
        threshold_hours: r.threshold_hours,
        resend_after_days: r.resend_after_days,
        template_name: r.template_name,
        template_language: r.template_language,
        max_followup_envios: r.max_followup_envios ?? 2,
        move_to_base_fria_enabled: r.move_to_base_fria_enabled ?? true,
        move_to_base_fria_after_days: r.move_to_base_fria_after_days ?? 7,
      };
    }
    setDrafts(initial);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function update(unitId: number, patch: Partial<DraftSettings>) {
    setDrafts((prev) => ({ ...prev, [unitId]: { ...prev[unitId], ...patch } }));
  }

  function isDirty(unitId: number): boolean {
    const cur = units.find((u) => u.unit_id === unitId);
    const draft = drafts[unitId];
    if (!cur || !draft) return false;
    return (
      draft.followup_enabled !== cur.followup_enabled ||
      draft.daily_cap !== cur.daily_cap ||
      draft.threshold_hours !== cur.threshold_hours ||
      draft.resend_after_days !== cur.resend_after_days ||
      draft.template_name !== cur.template_name ||
      draft.template_language !== cur.template_language ||
      draft.max_followup_envios !== (cur.max_followup_envios ?? 2) ||
      draft.move_to_base_fria_enabled !== (cur.move_to_base_fria_enabled ?? true) ||
      draft.move_to_base_fria_after_days !== (cur.move_to_base_fria_after_days ?? 7)
    );
  }

  async function save(unitId: number) {
    if (saving) return;
    const draft = drafts[unitId];
    if (!draft) return;

    // Validações
    if (draft.daily_cap < 1 || draft.daily_cap > 1000) {
      toast.error('Cap diário fora do permitido (1-1000)');
      return;
    }
    if (draft.threshold_hours < 1 || draft.threshold_hours > 720) {
      toast.error('Threshold fora do permitido (1-720h)');
      return;
    }
    if (draft.followup_enabled) {
      // valida template aprovado
      const tpl = templates.find(
        (t) => t.template_name === draft.template_name && t.language === draft.template_language,
      );
      if (!tpl) {
        toast.error('Template não encontrado na Meta', {
          description: `Verifique se "${draft.template_name}" (${draft.template_language}) existe na lista de templates.`,
        });
        return;
      }
      const status = (tpl.status || 'APPROVED').toUpperCase();
      if (status !== 'APPROVED') {
        toast.error('Template não está APROVADO', {
          description: `Status atual: ${status}. Ative apenas quando aprovado pela Meta.`,
        });
        return;
      }
    }

    setSaving(unitId);
    const { error } = await supabase
      .from('unit_automation_settings')
      .upsert(
        {
          unit_id: unitId,
          ...draft,
        },
        { onConflict: 'unit_id' },
      );
    if (error) {
      toast.error('Falha ao salvar', { description: error.message });
    } else {
      toast.success('Configuração salva');
      await load();
    }
    setSaving(null);
  }

  const approvedTemplates = useMemo(
    () => templates.filter((t) => (t.status || 'APPROVED').toUpperCase() === 'APPROVED'),
    [templates],
  );

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-start gap-2">
        <Zap className="w-4 h-4 text-blue-700 mt-0.5 flex-shrink-0" />
        <div className="text-xs text-blue-900 leading-snug">
          Configura o follow-up automático por unidade. Quando ativo, o sistema envia o template
          escolhido para leads em <strong>contato_feito</strong> parados há ≥ <em>threshold</em>,
          respeitando o cap diário e a janela de seg-sex 9h-18h. Resposta do cliente cai
          normalmente no chat.
        </div>
      </div>

      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="h-8">
          {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Atualizar
        </Button>
      </div>

      {loading && units.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      ) : units.length === 0 ? (
        <p className="text-sm text-slate-500 italic py-12 text-center">
          Você não tem permissão de gerente em nenhuma unidade.
        </p>
      ) : (
        <div className="space-y-3">
          {units.map((u) => {
            const draft = drafts[u.unit_id];
            if (!draft) return null;
            const dirty = isDirty(u.unit_id);
            const tpl = templates.find(
              (t) => t.template_name === draft.template_name && t.language === draft.template_language,
            );
            const tplStatus = (tpl?.status || 'APPROVED').toUpperCase();
            const tplOk = !!tpl && tplStatus === 'APPROVED';
            return (
              <div
                key={u.unit_id}
                className={cn(
                  'bg-white border rounded-xl p-4 space-y-3 transition-colors',
                  draft.followup_enabled
                    ? 'border-emerald-300 ring-1 ring-emerald-100'
                    : 'border-[#E5E7EB]',
                )}
              >
                {/* Header da unidade */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-bold text-[#1B1B1B]">{u.unit_name}</p>
                    <p className="text-[11px] text-[#9CA3AF]">
                      {draft.followup_enabled ? (
                        <span className="text-emerald-700 font-semibold">● Ativo</span>
                      ) : (
                        <span>○ Inativo</span>
                      )}
                      {' · '}
                      Enviados hoje: <strong>{u.sent_today}</strong> / {draft.daily_cap}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Label className="text-xs cursor-pointer flex items-center gap-2">
                      Follow-up automático
                      <Switch
                        checked={draft.followup_enabled}
                        onCheckedChange={(v) => update(u.unit_id, { followup_enabled: v })}
                      />
                    </Label>
                  </div>
                </div>

                {/* Settings */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-[11px] text-[#6B7280]">Threshold (horas)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={720}
                      value={draft.threshold_hours}
                      onChange={(e) => update(u.unit_id, { threshold_hours: Number(e.target.value) })}
                      className="h-9 text-sm"
                    />
                    <p className="text-[10px] text-[#9CA3AF] mt-0.5">Tempo mínimo em "contato_feito"</p>
                  </div>
                  <div>
                    <Label className="text-[11px] text-[#6B7280]">Cap diário</Label>
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      value={draft.daily_cap}
                      onChange={(e) => update(u.unit_id, { daily_cap: Number(e.target.value) })}
                      className="h-9 text-sm"
                    />
                    <p className="text-[10px] text-[#9CA3AF] mt-0.5">Máximo de envios/dia</p>
                  </div>
                  <div>
                    <Label className="text-[11px] text-[#6B7280]">Reenvio após (dias)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={90}
                      value={draft.resend_after_days ?? 0}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        update(u.unit_id, { resend_after_days: v > 0 ? v : null });
                      }}
                      className="h-9 text-sm"
                      placeholder="0 = sem reenvio"
                    />
                    <p className="text-[10px] text-[#9CA3AF] mt-0.5">0 = não reenvia</p>
                  </div>
                  <div>
                    <Label className="text-[11px] text-[#6B7280]">Máx. envios por lead</Label>
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={draft.max_followup_envios}
                      onChange={(e) => update(u.unit_id, { max_followup_envios: Number(e.target.value) })}
                      className="h-9 text-sm"
                    />
                    <p className="text-[10px] text-[#9CA3AF] mt-0.5">2 envios = padrão</p>
                  </div>
                  <div>
                    <Label className="text-[11px] text-[#6B7280]">Template</Label>
                    <Select
                      value={`${draft.template_name}|${draft.template_language}`}
                      onValueChange={(v) => {
                        const [n, l] = v.split('|');
                        update(u.unit_id, { template_name: n, template_language: l });
                      }}
                    >
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {approvedTemplates.length === 0 && (
                          <SelectItem value={`${draft.template_name}|${draft.template_language}`}>
                            {draft.template_name} ({draft.template_language})
                          </SelectItem>
                        )}
                        {approvedTemplates.map((t) => (
                          <SelectItem
                            key={`${t.template_name}|${t.language}`}
                            value={`${t.template_name}|${t.language}`}
                          >
                            {t.template_name} ({t.language})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-[#9CA3AF] mt-0.5 truncate">
                      {tplOk ? (
                        <span className="text-emerald-700">
                          <CheckCircle2 className="w-2.5 h-2.5 inline" /> Template aprovado
                        </span>
                      ) : tpl ? (
                        <span className="text-amber-700">
                          <Clock className="w-2.5 h-2.5 inline" /> Status: {tplStatus}
                        </span>
                      ) : (
                        <span className="text-red-700">
                          <AlertTriangle className="w-2.5 h-2.5 inline" /> Template não encontrado
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Base fria — H2.2 */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex-1">
                    <Label className="text-xs font-semibold text-slate-700 cursor-pointer flex items-center gap-2">
                      Mover para "Base fria" após {draft.max_followup_envios} envios sem resposta
                      <Switch
                        checked={draft.move_to_base_fria_enabled}
                        onCheckedChange={(v) => update(u.unit_id, { move_to_base_fria_enabled: v })}
                      />
                    </Label>
                    <p className="text-[10px] text-slate-500 mt-1">
                      Lead vai pra base_fria depois de N dias do último template sem inbound do cliente.
                      Cliente respondendo, lead volta automaticamente para "contato_feito".
                    </p>
                  </div>
                  <div>
                    <Label className="text-[11px] text-slate-500">Após (dias)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={draft.move_to_base_fria_after_days}
                      onChange={(e) => update(u.unit_id, { move_to_base_fria_after_days: Number(e.target.value) })}
                      disabled={!draft.move_to_base_fria_enabled}
                      className="h-9 text-sm w-20"
                    />
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between pt-2 border-t border-[#F3F3F3]">
                  <div className="text-[10px] text-[#9CA3AF]">
                    {u.settings_updated_at
                      ? `Atualizado ${new Date(u.settings_updated_at).toLocaleString('pt-BR')}`
                      : 'Nunca configurado'}
                  </div>
                  <Button
                    onClick={() => save(u.unit_id)}
                    disabled={!dirty || saving === u.unit_id}
                    size="sm"
                    className="bg-[#0023D5] hover:bg-[#0023D5]/90 text-white disabled:opacity-50"
                  >
                    {saving === u.unit_id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <><Save className="w-4 h-4 mr-1.5" /> Salvar</>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
