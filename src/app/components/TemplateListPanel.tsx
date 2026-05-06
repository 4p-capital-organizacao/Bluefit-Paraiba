/**
 * Lista de templates WhatsApp já cadastrados na Meta com status.
 *
 * Reusa GET /make-server-844b77a1/api/whatsapp/templates (já existente).
 * Mostra: nome, categoria, idioma, status (APPROVED/PENDING/REJECTED), preview do body.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, XCircle, RefreshCw, Search, FileText, Loader2, Copy, Smartphone, Check, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { fetchAvailableTemplates } from '../lib/whatsapp';
import { supabase } from '../lib/supabase';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { useModulePermissions } from '../hooks/useModulePermissions';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { cn } from './ui/utils';
import type { WhatsAppTemplate } from '../types/database';

const STATUS_META: Record<string, { label: string; icon: any; cls: string }> = {
  APPROVED: { label: 'Aprovado', icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  PENDING: { label: 'Em análise', icon: Clock, cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  IN_APPEAL: { label: 'Em recurso', icon: Clock, cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  REJECTED: { label: 'Rejeitado', icon: XCircle, cls: 'bg-red-50 text-red-700 border-red-200' },
  DISABLED: { label: 'Desabilitado', icon: XCircle, cls: 'bg-slate-50 text-slate-600 border-slate-200' },
  PAUSED: { label: 'Pausado', icon: Clock, cls: 'bg-slate-50 text-slate-600 border-slate-200' },
};

const CATEGORY_LABEL: Record<string, string> = {
  marketing: 'Marketing',
  utility: 'Utilidade',
  authentication: 'Autenticação',
  MARKETING: 'Marketing',
  UTILITY: 'Utilidade',
  AUTHENTICATION: 'Autenticação',
};

const CATEGORY_CLS: Record<string, string> = {
  marketing: 'bg-purple-100 text-purple-700 border-purple-200',
  utility: 'bg-blue-100 text-blue-700 border-blue-200',
  authentication: 'bg-green-100 text-green-700 border-green-200',
  MARKETING: 'bg-purple-100 text-purple-700 border-purple-200',
  UTILITY: 'bg-blue-100 text-blue-700 border-blue-200',
  AUTHENTICATION: 'bg-green-100 text-green-700 border-green-200',
};

interface TemplateRow extends WhatsAppTemplate {
  status?: string;
}

export function TemplateListPanel() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateRow | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { canAccess } = useModulePermissions();
  const canDeleteTemplate = canAccess('templates');

  function copyToClipboard(text: string, fieldKey: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(fieldKey);
      setTimeout(() => setCopiedField((c) => (c === fieldKey ? null : c)), 1500);
    });
  }

  async function handleDelete(template: TemplateRow) {
    if (deleting) return;
    const confirmMsg =
      `Excluir o template "${template.template_name}"?\n\n` +
      `Isso remove TODAS as versões/idiomas desse template na Meta.\n` +
      `Templates excluídos não podem ser recuperados — você precisaria criar de novo do zero.\n\n` +
      `Confirma?`;
    if (!window.confirm(confirmMsg)) return;

    setDeleting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        toast.error('Sessão expirada. Faça login novamente.');
        return;
      }

      const url = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/whatsapp/templates/${encodeURIComponent(template.template_name)}`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          apikey: publicAnonKey,
          Authorization: `Bearer ${publicAnonKey}`,
          'X-User-Token': accessToken,
        },
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.success) {
        toast.error('Não foi possível excluir', {
          description: result?.error || `HTTP ${response.status}`,
          duration: 8000,
        });
        return;
      }

      toast.success('Template excluído', {
        description: `${template.template_name} removido da Meta.`,
      });
      setSelectedTemplate(null);
      await load(true);
    } catch (err: any) {
      console.error('[TemplateListPanel] delete failed:', err);
      toast.error('Erro inesperado', { description: err?.message });
    } finally {
      setDeleting(false);
    }
  }

  const load = useCallback(async (showToast = false) => {
    if (showToast) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await fetchAvailableTemplates({ includeAllStatuses: true });
      setTemplates(data as TemplateRow[]);
      if (showToast) toast.success('Lista atualizada');
    } catch (e: any) {
      console.error('[TemplateListPanel] load error:', e);
      toast.error('Falha ao carregar templates', { description: e?.message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let result = templates;
    if (statusFilter !== 'all') {
      result = result.filter((t) => (t.status || 'APPROVED').toUpperCase() === statusFilter);
    }
    if (categoryFilter !== 'all') {
      result = result.filter((t) => (t.category || '').toUpperCase() === categoryFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (t) =>
          t.template_name.toLowerCase().includes(q) ||
          (t.language || '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [templates, search, statusFilter, categoryFilter]);

  const counts = useMemo(() => {
    let total = templates.length;
    let approved = 0, pending = 0, rejected = 0;
    for (const t of templates) {
      const s = (t.status || 'APPROVED').toUpperCase();
      if (s === 'APPROVED') approved++;
      else if (s === 'PENDING' || s === 'IN_APPEAL') pending++;
      else if (s === 'REJECTED') rejected++;
    }
    return { total, approved, pending, rejected };
  }, [templates]);

  return (
    <div className="space-y-4">
      {/* Toolbar de stats + filtros */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border border-[#E5E7EB] p-3">
          <p className="text-[11px] text-[#6B7280] uppercase font-semibold">Total</p>
          <p className="text-2xl font-bold text-[#1B1B1B] mt-0.5">{counts.total}</p>
        </div>
        <div className="bg-white rounded-lg border border-emerald-200 p-3">
          <p className="text-[11px] text-emerald-700 uppercase font-semibold">Aprovados</p>
          <p className="text-2xl font-bold text-emerald-700 mt-0.5">{counts.approved}</p>
        </div>
        <div className="bg-white rounded-lg border border-amber-200 p-3">
          <p className="text-[11px] text-amber-700 uppercase font-semibold">Em análise</p>
          <p className="text-2xl font-bold text-amber-700 mt-0.5">{counts.pending}</p>
        </div>
        <div className="bg-white rounded-lg border border-red-200 p-3">
          <p className="text-[11px] text-red-700 uppercase font-semibold">Rejeitados</p>
          <p className="text-2xl font-bold text-red-700 mt-0.5">{counts.rejected}</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9CA3AF]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou idioma…"
            className="pl-10 h-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-full md:w-[180px] text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="APPROVED">Aprovado</SelectItem>
            <SelectItem value="PENDING">Em análise</SelectItem>
            <SelectItem value="REJECTED">Rejeitado</SelectItem>
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="h-9 w-full md:w-[180px] text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as categorias</SelectItem>
            <SelectItem value="MARKETING">Marketing</SelectItem>
            <SelectItem value="UTILITY">Utilidade</SelectItem>
            <SelectItem value="AUTHENTICATION">Autenticação</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => load(true)} disabled={refreshing} className="h-9">
          {refreshing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Atualizar
        </Button>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center bg-white rounded-xl border border-[#E5E7EB]">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
            <FileText className="w-6 h-6 text-slate-400" />
          </div>
          <p className="text-sm font-medium text-slate-700">
            {templates.length === 0 ? 'Nenhum template cadastrado' : 'Nenhum template bate com o filtro'}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {templates.length === 0 ? 'Use a aba "Criar template" para começar.' : 'Limpe filtros ou tente outro termo.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((t) => {
            const status = (t.status || 'APPROVED').toUpperCase();
            const sm = STATUS_META[status] || STATUS_META.APPROVED;
            const SIcon = sm.icon;
            const bodyComp = (t.components || []).find((c: any) => c.type === 'BODY');
            const footerComp = (t.components || []).find((c: any) => c.type === 'FOOTER');
            const buttonsComp = (t.components || []).find((c: any) => c.type === 'BUTTONS');
            const buttons = (buttonsComp?.buttons || []).filter((b: any) => b.type === 'QUICK_REPLY');
            return (
              <button
                key={`${t.template_name}-${t.language}`}
                type="button"
                onClick={() => setSelectedTemplate(t)}
                className="bg-white rounded-xl border border-[#E5E7EB] p-4 flex flex-col gap-2 text-left hover:border-[#0023D5] hover:shadow-md transition-all duration-150 cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#0023D5]/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-[#1B1B1B] truncate">{t.template_name}</p>
                    <p className="text-[10px] text-[#9CA3AF] uppercase font-medium">{t.language}</p>
                  </div>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-semibold border whitespace-nowrap',
                      sm.cls,
                    )}
                  >
                    <SIcon className="w-3 h-3" />
                    {sm.label}
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    'self-start text-[10px] uppercase font-bold',
                    CATEGORY_CLS[t.category] || 'bg-slate-100 text-slate-600 border-slate-200',
                  )}
                >
                  {CATEGORY_LABEL[t.category] || t.category}
                </Badge>
                {bodyComp?.text && (
                  <p className="text-[12px] text-[#4B5563] leading-snug whitespace-pre-line line-clamp-4 mt-1">
                    {bodyComp.text}
                  </p>
                )}
                {footerComp?.text && (
                  <p className="text-[10px] text-[#9CA3AF] italic">{footerComp.text}</p>
                )}
                {buttons.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 pt-2 border-t border-[#F3F3F3]">
                    {buttons.map((b: any, i: number) => (
                      <span
                        key={i}
                        className="text-[10px] text-[#0079BA] border border-[#E5E7EB] bg-slate-50 rounded px-1.5 py-0.5"
                      >
                        {b.text}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Dialog de preview do template */}
      <Dialog open={!!selectedTemplate} onOpenChange={(o) => { if (!o) setSelectedTemplate(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] p-0 flex flex-col">
          {selectedTemplate && (() => {
            const t = selectedTemplate;
            const status = (t.status || 'APPROVED').toUpperCase();
            const sm = STATUS_META[status] || STATUS_META.APPROVED;
            const SIcon = sm.icon;
            const bodyComp = (t.components || []).find((c: any) => c.type === 'BODY');
            const footerComp = (t.components || []).find((c: any) => c.type === 'FOOTER');
            const headerComp = (t.components || []).find((c: any) => c.type === 'HEADER');
            const buttonsComp = (t.components || []).find((c: any) => c.type === 'BUTTONS');
            const buttons = (buttonsComp?.buttons || []);

            return (
              <>
                <DialogHeader className="p-6 pb-3">
                  <DialogTitle className="flex items-center gap-2 flex-wrap">
                    <FileText className="w-5 h-5 text-[#0023D5]" />
                    <span className="font-mono text-base">{t.template_name}</span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-semibold border whitespace-nowrap',
                        sm.cls,
                      )}
                    >
                      <SIcon className="w-3 h-3" />
                      {sm.label}
                    </span>
                  </DialogTitle>
                  <DialogDescription className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px] uppercase font-bold',
                        CATEGORY_CLS[t.category] || 'bg-slate-100 text-slate-600 border-slate-200',
                      )}
                    >
                      {CATEGORY_LABEL[t.category] || t.category}
                    </Badge>
                    <span className="text-[11px] text-[#9CA3AF] uppercase font-medium">
                      Idioma: {t.language}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(t.template_name, 'name')}
                      className="h-7 text-xs ml-auto"
                    >
                      {copiedField === 'name' ? (
                        <><Check className="w-3 h-3 mr-1" /> Nome copiado</>
                      ) : (
                        <><Copy className="w-3 h-3 mr-1" /> Copiar nome</>
                      )}
                    </Button>
                  </DialogDescription>
                </DialogHeader>

                <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-0 flex-1 min-h-0 overflow-hidden">
                  {/* Conteúdo bruto (texto completo) */}
                  <div className="px-6 pb-6 overflow-y-auto space-y-4">
                    {headerComp?.text && (
                      <section>
                        <p className="text-[10px] uppercase tracking-wide text-[#9CA3AF] font-semibold mb-1">Cabeçalho</p>
                        <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-sm text-[#1B1B1B] whitespace-pre-line">
                          {headerComp.text}
                        </div>
                      </section>
                    )}

                    <section>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-[10px] uppercase tracking-wide text-[#9CA3AF] font-semibold">Mensagem (body)</p>
                        {bodyComp?.text && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => copyToClipboard(bodyComp.text || '', 'body')}
                            className="h-6 text-[10px]"
                          >
                            {copiedField === 'body' ? (
                              <><Check className="w-3 h-3 mr-1" /> Copiado</>
                            ) : (
                              <><Copy className="w-3 h-3 mr-1" /> Copiar</>
                            )}
                          </Button>
                        )}
                      </div>
                      <div className="bg-white border border-[#E5E7EB] rounded-md p-3 text-sm text-[#1B1B1B] whitespace-pre-line leading-relaxed min-h-[80px]">
                        {bodyComp?.text || <span className="text-[#9CA3AF] italic">Sem mensagem</span>}
                      </div>
                    </section>

                    {footerComp?.text && (
                      <section>
                        <p className="text-[10px] uppercase tracking-wide text-[#9CA3AF] font-semibold mb-1">Rodapé</p>
                        <div className="bg-white border border-[#E5E7EB] rounded-md p-3 text-sm text-[#6B7280] italic">
                          {footerComp.text}
                        </div>
                      </section>
                    )}

                    {buttons.length > 0 && (
                      <section>
                        <p className="text-[10px] uppercase tracking-wide text-[#9CA3AF] font-semibold mb-1">
                          Botões ({buttons.length})
                        </p>
                        <ul className="space-y-1.5">
                          {buttons.map((b: any, i: number) => (
                            <li
                              key={i}
                              className="flex items-center gap-2 bg-white border border-[#E5E7EB] rounded-md p-2 text-sm"
                            >
                              <span className="text-[10px] font-bold text-slate-400 w-4">{i + 1}</span>
                              <span className="text-[#1B1B1B] flex-1">{b.text}</span>
                              <Badge variant="outline" className="text-[9px] uppercase">
                                {b.type === 'QUICK_REPLY' ? 'Resposta rápida' : b.type}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                    {/* Zona perigosa — Excluir template (apenas para quem tem permissão) */}
                    {canDeleteTemplate && (
                      <section className="mt-2 pt-3 border-t border-red-100">
                        <p className="text-[10px] uppercase tracking-wide text-red-600 font-semibold mb-1.5">
                          Zona perigosa
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDelete(t)}
                          disabled={deleting}
                          className="border-red-200 text-red-700 hover:bg-red-50 hover:border-red-300 hover:text-red-800 h-8 text-xs"
                        >
                          {deleting ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                          )}
                          Excluir template
                        </Button>
                        <p className="text-[10px] text-[#9CA3AF] mt-1.5 leading-snug">
                          Remove o template da Meta (todas as línguas). Não pode ser desfeito —
                          você teria que criar de novo. Útil para templates de promoção
                          temporários que ficaram obsoletos.
                        </p>
                      </section>
                    )}
                  </div>

                  {/* Pré-visualização estilo WhatsApp */}
                  <div className="border-l border-[#F3F3F3] bg-[#E5DDD5]/40 p-4 overflow-y-auto">
                    <div className="flex items-center gap-2 mb-3 text-xs text-[#6B7280]">
                      <Smartphone className="w-3.5 h-3.5" /> Pré-visualização
                    </div>
                    <div className="bg-white rounded-2xl rounded-tl-sm shadow-sm p-3 max-w-[260px]">
                      {headerComp?.text && (
                        <p className="text-[13px] font-bold text-[#1B1B1B] mb-1.5">{headerComp.text}</p>
                      )}
                      {bodyComp?.text ? (
                        <p className="text-[13px] leading-snug whitespace-pre-line text-[#1B1B1B]">{bodyComp.text}</p>
                      ) : (
                        <p className="text-[13px] text-[#9CA3AF] italic">Sem mensagem</p>
                      )}
                      {footerComp?.text && (
                        <p className="text-[11px] text-[#6B7280] mt-2 leading-tight">{footerComp.text}</p>
                      )}
                    </div>
                    {buttons.length > 0 && (
                      <div className="mt-2 space-y-1.5 max-w-[260px]">
                        {buttons.map((b: any, i: number) => (
                          <div
                            key={i}
                            className="bg-white rounded-lg shadow-sm py-2 px-3 text-center text-[13px] font-medium text-[#0079BA] border border-[#E5E7EB]"
                          >
                            {b.text}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
