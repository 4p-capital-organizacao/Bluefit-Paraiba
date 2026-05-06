/**
 * H1.5 — Snippet Manager (CRUD)
 *
 * Modal para supervisor+/admin gerenciar snippets:
 *  - Lista snippets globais e da unidade do usuário
 *  - Criar / editar / deletar
 *  - Marcar como favorito (apenas admin para globais)
 *
 * Atendentes podem visualizar mas não editar (RLS rejeita).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, Loader2, Plus, Search, Star, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '../lib/supabase';
import { useUserProfile } from '../hooks/useUserProfile';
import { CATEGORY_LABEL, SNIPPET_CATEGORIES } from '../lib/snippets';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import { cn } from './ui/utils';

interface Row {
  id: number;
  unit_id: number | null;
  category: string;
  title: string;
  body: string;
  is_global_favorite: boolean;
  usage_count: number;
}

interface FormState {
  title: string;
  body: string;
  category: string;
  scope: 'global' | 'unit';
  unit_id: number | null;
  is_global_favorite: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const VAR_HINTS = [
  '{{primeiro_nome}}',
  '{{nome_consultor}}',
  '{{unidade}}',
  '{{horario_atendimento}}',
];

export function SnippetManagerDialog({ open, onOpenChange }: Props) {
  const { profile } = useUserProfile();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState<FormState>({
    title: '',
    body: '',
    category: 'geral',
    scope: 'unit',
    unit_id: profile.id_unidade ?? null,
    is_global_favorite: false,
  });
  const [saving, setSaving] = useState(false);

  // Permissões
  const canEditUnit = profile.isLoaded && (profile.id_cargo ?? 0) >= 3; // Supervisor+
  const canEditGlobal = profile.isLoaded && (profile.id_cargo ?? 0) >= 5; // Administrador
  const canEditAny = canEditUnit || canEditGlobal;

  const userUnitOptions = useMemo(() => {
    return profile.unitIds.map((id) => ({ id, name: profile.unitNames[id] || `Unidade ${id}` }));
  }, [profile.unitIds, profile.unitNames]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('quick_replies')
      .select('id, unit_id, category, title, body, is_global_favorite, usage_count')
      .order('is_global_favorite', { ascending: false })
      .order('title', { ascending: true });
    if (error) {
      toast.error('Falha ao carregar snippets', { description: error.message });
    } else {
      setRows((data as Row[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) fetchRows();
  }, [open, fetchRows]);

  function openCreate() {
    setEditing(null);
    setForm({
      title: '',
      body: '',
      category: 'geral',
      scope: canEditGlobal ? 'global' : 'unit',
      unit_id: canEditGlobal ? null : profile.id_unidade ?? userUnitOptions[0]?.id ?? null,
      is_global_favorite: false,
    });
    setFormOpen(true);
  }

  function openEdit(row: Row) {
    setEditing(row);
    setForm({
      title: row.title,
      body: row.body,
      category: row.category,
      scope: row.unit_id === null ? 'global' : 'unit',
      unit_id: row.unit_id,
      is_global_favorite: row.is_global_favorite,
    });
    setFormOpen(true);
  }

  async function handleSave() {
    if (!form.title.trim() || !form.body.trim()) {
      toast.error('Preencha título e mensagem');
      return;
    }
    if (form.scope === 'unit' && !form.unit_id) {
      toast.error('Selecione a unidade');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        body: form.body,
        category: form.category,
        unit_id: form.scope === 'global' ? null : form.unit_id,
        is_global_favorite: form.scope === 'global' ? form.is_global_favorite : false,
      };

      if (editing) {
        const { error } = await supabase.from('quick_replies').update(payload).eq('id', editing.id);
        if (error) throw error;
        toast.success('Snippet atualizado');
      } else {
        const { error } = await supabase.from('quick_replies').insert({
          ...payload,
          created_by: profile.id || null,
        });
        if (error) throw error;
        toast.success('Snippet criado');
      }

      setFormOpen(false);
      await fetchRows();
    } catch (err: any) {
      console.error('[SnippetManager] save failed:', err);
      toast.error('Falha ao salvar', { description: err?.message || 'Verifique permissão.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(row: Row) {
    if (!confirm(`Excluir o snippet "${row.title}"?`)) return;
    const { error } = await supabase.from('quick_replies').delete().eq('id', row.id);
    if (error) {
      toast.error('Falha ao excluir', { description: error.message });
      return;
    }
    toast.success('Snippet excluído');
    await fetchRows();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q),
    );
  }, [rows, search]);

  function canEditRow(row: Row): boolean {
    if (row.unit_id === null) return canEditGlobal;
    if (!canEditUnit) return false;
    if (profile.isFullAdmin) return true;
    return profile.unitIds.includes(row.unit_id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] p-0 flex flex-col">
        <DialogHeader className="p-6 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-[#0023D5]" />
            Snippets de mensagem
          </DialogTitle>
          <DialogDescription>
            Respostas pré-prontas com variáveis. Atendente acessa no chat digitando <code>/</code>.
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar */}
        <div className="px-6 pb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9CA3AF]" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar título, categoria ou mensagem…"
              className="pl-10 h-9"
            />
          </div>
          {canEditAny && (
            <Button onClick={openCreate} size="sm" className="bg-[#0023D5] hover:bg-[#0023D5]/90 h-9">
              <Plus className="w-4 h-4 mr-1.5" />
              Novo
            </Button>
          )}
        </div>

        {/* Lista */}
        <ScrollArea className="flex-1 px-6 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-sm text-[#9CA3AF]">
              {rows.length === 0
                ? 'Nenhum snippet cadastrado ainda.'
                : 'Nenhum snippet bate com a busca.'}
            </div>
          ) : (
            <div className="space-y-1.5">
              {filtered.map((row) => {
                const editable = canEditRow(row);
                return (
                  <div
                    key={row.id}
                    className="group flex items-start gap-3 p-3 rounded-lg border border-[#E5E7EB] hover:border-[#0023D5] hover:bg-[#E6EAFF]/30 transition-all"
                  >
                    <div className="flex-shrink-0 pt-0.5">
                      {row.is_global_favorite ? (
                        <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                      ) : (
                        <Zap className="w-4 h-4 text-[#9CA3AF]" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="text-sm font-semibold text-[#1B1B1B] truncate">{row.title}</span>
                        <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                          {CATEGORY_LABEL[row.category] || row.category}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px]',
                            row.unit_id === null ? 'border-amber-200 text-amber-700' : 'border-[#0023D5]/40 text-[#0023D5]',
                          )}
                        >
                          {row.unit_id === null ? 'Global' : 'Unidade'}
                        </Badge>
                        {row.usage_count > 0 && (
                          <span className="text-[10px] text-[#9CA3AF]">{row.usage_count} usos</span>
                        )}
                      </div>
                      <p className="text-xs text-[#4B5563] leading-snug whitespace-pre-line line-clamp-3">
                        {row.body}
                      </p>
                    </div>
                    {editable && (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <Button
                          onClick={() => openEdit(row)}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                        >
                          <Edit2 className="w-4 h-4 text-[#4B5563]" />
                        </Button>
                        <Button
                          onClick={() => handleDelete(row)}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Form modal interno */}
        {formOpen && (
          <Dialog open={formOpen} onOpenChange={setFormOpen}>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>{editing ? 'Editar snippet' : 'Novo snippet'}</DialogTitle>
                <DialogDescription>
                  Use variáveis: {VAR_HINTS.join(', ')}.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-[#4B5563] mb-1 block">Título</label>
                  <Input
                    value={form.title}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="Ex: Confirmar visita"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-[#4B5563] mb-1 block">Categoria</label>
                    <Select
                      value={form.category}
                      onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}
                    >
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SNIPPET_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-[#4B5563] mb-1 block">Escopo</label>
                    <Select
                      value={form.scope}
                      onValueChange={(v) => setForm((f) => ({ ...f, scope: v as 'global' | 'unit' }))}
                    >
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unit">Unidade</SelectItem>
                        {canEditGlobal && <SelectItem value="global">Global (todas)</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {form.scope === 'unit' && userUnitOptions.length > 1 && (
                  <div>
                    <label className="text-xs font-medium text-[#4B5563] mb-1 block">Unidade</label>
                    <Select
                      value={form.unit_id != null ? String(form.unit_id) : ''}
                      onValueChange={(v) => setForm((f) => ({ ...f, unit_id: Number(v) }))}
                    >
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Selecione…" /></SelectTrigger>
                      <SelectContent>
                        {userUnitOptions.map((u) => (
                          <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div>
                  <label className="text-xs font-medium text-[#4B5563] mb-1 block">Mensagem</label>
                  <Textarea
                    value={form.body}
                    onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                    rows={6}
                    placeholder="Ex: Olá {{primeiro_nome}}! Aqui é {{nome_consultor}} da Bluefit {{unidade}}…"
                  />
                  <p className="text-[10px] text-[#9CA3AF] mt-1">{form.body.length} caracteres</p>
                </div>
                {form.scope === 'global' && canEditGlobal && (
                  <label className="flex items-center gap-2 text-xs text-[#4B5563] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.is_global_favorite}
                      onChange={(e) => setForm((f) => ({ ...f, is_global_favorite: e.target.checked }))}
                    />
                    Favorito global (aparece no topo da lista)
                  </label>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setFormOpen(false)}>Cancelar</Button>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-[#0023D5] hover:bg-[#0023D5]/90"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                  {editing ? 'Salvar' : 'Criar'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}
