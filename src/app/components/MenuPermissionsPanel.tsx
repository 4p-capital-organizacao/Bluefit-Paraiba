/**
 * Painel de configuração de permissões de menu (Administrador apenas).
 *
 * Lista entradas de menu_item_permissions e permite editar required_cargo_levels
 * via checkboxes (Atendente, Supervisor, Gerente, Administrador).
 *
 * RLS já restringe UPDATE a admin. Atendente vê o painel só leitura, mas a UI
 * está em uma tab que só aparece para admin (ConfigModule guard).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Save, ShieldCheck, Lock } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '../lib/supabase';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { clearModulePermissionsCache } from '../hooks/useModulePermissions';

interface PermissionRow {
  id: number;
  module_key: string;
  required_cargo_levels: number[];
  description: string | null;
}

interface CargoOption {
  level: number;
  label: string;
  desc: string;
}

const CARGO_OPTIONS: CargoOption[] = [
  { level: 2, label: 'Atendente', desc: 'Cargo 2' },
  { level: 3, label: 'Supervisor', desc: 'Cargo 3' },
  { level: 4, label: 'Gerente', desc: 'Cargo 4' },
  { level: 5, label: 'Administrador', desc: 'Cargo 5' },
];

const MODULE_LABELS: Record<string, string> = {
  templates: 'Templates WhatsApp',
};

export function MenuPermissionsPanel() {
  const [rows, setRows] = useState<PermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, number[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('menu_item_permissions')
      .select('id, module_key, required_cargo_levels, description')
      .order('module_key');
    if (error) {
      toast.error('Falha ao carregar permissões', { description: error.message });
    } else {
      setRows((data as PermissionRow[]) || []);
      const initial: Record<number, number[]> = {};
      for (const r of data as PermissionRow[]) {
        initial[r.id] = [...r.required_cargo_levels];
      }
      setDrafts(initial);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleLevel(id: number, level: number) {
    setDrafts((prev) => {
      const current = prev[id] || [];
      const next = current.includes(level)
        ? current.filter((l) => l !== level)
        : [...current, level].sort();
      return { ...prev, [id]: next };
    });
  }

  function isDirty(row: PermissionRow): boolean {
    const draft = drafts[row.id] || [];
    const original = row.required_cargo_levels;
    if (draft.length !== original.length) return true;
    return draft.some((l) => !original.includes(l));
  }

  async function save(row: PermissionRow) {
    if (saving) return;
    const newLevels = drafts[row.id] || [];
    if (newLevels.length === 0) {
      toast.error('Selecione pelo menos um cargo. Para desabilitar o módulo, peça ao dev pra remover o item.');
      return;
    }
    setSaving(row.id);
    const { error } = await supabase
      .from('menu_item_permissions')
      .update({ required_cargo_levels: newLevels })
      .eq('id', row.id);
    if (error) {
      toast.error('Falha ao salvar', { description: error.message });
    } else {
      toast.success(`Permissões de "${MODULE_LABELS[row.module_key] || row.module_key}" atualizadas`);
      clearModulePermissionsCache();
      await load();
    }
    setSaving(null);
  }

  const sortedRows = useMemo(() => rows, [rows]);

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-blue-700 mt-0.5 flex-shrink-0" />
        <div className="text-xs text-blue-900 leading-snug">
          Define quais cargos veem cada item de menu. A mudança aplica imediatamente para
          quem fizer login depois — usuários já logados precisam recarregar a página.
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      ) : sortedRows.length === 0 ? (
        <p className="text-sm text-slate-500 italic">Nenhum módulo configurável.</p>
      ) : (
        <div className="space-y-3">
          {sortedRows.map((row) => {
            const dirty = isDirty(row);
            const draft = drafts[row.id] || [];
            return (
              <div
                key={row.id}
                className="bg-white border border-[#E5E7EB] rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-4"
              >
                <div className="md:w-[280px]">
                  <p className="text-sm font-bold text-[#1B1B1B]">
                    {MODULE_LABELS[row.module_key] || row.module_key}
                  </p>
                  {row.description && (
                    <p className="text-xs text-[#6B7280] mt-0.5">{row.description}</p>
                  )}
                  <code className="text-[10px] text-[#9CA3AF] uppercase">{row.module_key}</code>
                </div>

                <div className="flex-1 flex flex-wrap gap-2">
                  {CARGO_OPTIONS.map((c) => {
                    const checked = draft.includes(c.level);
                    return (
                      <label
                        key={c.level}
                        className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-xs transition-colors ${
                          checked
                            ? 'border-[#0023D5] bg-[#E6EAFF] text-[#0023D5]'
                            : 'border-[#E5E7EB] bg-white hover:border-slate-300'
                        }`}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleLevel(row.id, c.level)}
                        />
                        <span className="font-medium">{c.label}</span>
                      </label>
                    );
                  })}
                </div>

                <Button
                  onClick={() => save(row)}
                  disabled={!dirty || saving === row.id}
                  size="sm"
                  className="bg-[#0023D5] hover:bg-[#0023D5]/90 text-white disabled:opacity-50"
                >
                  {saving === row.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : dirty ? (
                    <><Save className="w-4 h-4 mr-1.5" /> Salvar</>
                  ) : (
                    <><Lock className="w-4 h-4 mr-1.5" /> Salvo</>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
