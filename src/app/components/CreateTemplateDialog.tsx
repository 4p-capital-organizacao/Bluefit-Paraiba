/**
 * Criação de template WhatsApp via Meta API.
 * Acesso restrito: gerentes (cargo level >= 4).
 *
 * Backend: POST /make-server-844b77a1/api/whatsapp/templates
 * Schema do payload em supabase/functions/make-server-844b77a1/whatsapp.tsx (createWhatsAppTemplate)
 */

import { useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '../lib/supabase';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { cn } from './ui/utils';

const NAME_RE = /^[a-z][a-z0-9_]{0,511}$/;
const NAME_RE_FRIENDLY = /^[a-z][a-z0-9_]*$/;

interface QuickReplyDraft {
  id: number;
  text: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (template: { id?: string; status?: string; name: string; language: string }) => void;
}

const LANGUAGE_OPTIONS = [
  { code: 'pt_BR', label: 'Português (Brasil)' },
  { code: 'pt_PT', label: 'Português (Portugal)' },
  { code: 'en', label: 'English' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'es', label: 'Español' },
];

const CATEGORY_OPTIONS: Array<{ value: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'; label: string; hint: string }> = [
  { value: 'MARKETING', label: 'Marketing', hint: 'Promoções, novidades, reativação. Custo Meta mais alto.' },
  { value: 'UTILITY', label: 'Utilidade', hint: 'Confirmações, atualizações de pedido/visita. Mais barato.' },
  { value: 'AUTHENTICATION', label: 'Autenticação', hint: 'OTP / códigos de verificação. Uso restrito.' },
];

export function CreateTemplateDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY' | 'AUTHENTICATION'>('UTILITY');
  const [language, setLanguage] = useState('pt_BR');
  const [body, setBody] = useState('');
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState<QuickReplyDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const validation = useMemo(() => {
    if (!name.trim()) return 'Nome é obrigatório.';
    if (!NAME_RE.test(name)) {
      return 'Nome deve ser snake_case minúsculo (ex: confirmar_visita_v1).';
    }
    if (!body.trim()) return 'Mensagem (body) é obrigatória.';
    if (body.length > 1024) return `Mensagem excede 1024 caracteres (atual: ${body.length}).`;
    if (footer.length > 60) return `Rodapé excede 60 caracteres (atual: ${footer.length}).`;
    if (buttons.length > 3) return 'Máximo de 3 botões de resposta rápida.';
    for (const b of buttons) {
      if (!b.text.trim()) return 'Texto dos botões não pode ser vazio.';
      if (b.text.length > 25) return `Texto do botão "${b.text.slice(0, 12)}…" excede 25 caracteres.`;
    }
    return null;
  }, [name, body, footer, buttons]);

  function reset() {
    setName('');
    setCategory('UTILITY');
    setLanguage('pt_BR');
    setBody('');
    setFooter('');
    setButtons([]);
  }

  function addButton() {
    if (buttons.length >= 3) return;
    setButtons((prev) => [...prev, { id: Date.now(), text: '' }]);
  }

  function updateButton(id: number, text: string) {
    setButtons((prev) => prev.map((b) => (b.id === id ? { ...b, text } : b)));
  }

  function removeButton(id: number) {
    setButtons((prev) => prev.filter((b) => b.id !== id));
  }

  async function handleSubmit() {
    if (validation || submitting) return;
    setSubmitting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        toast.error('Sessão expirada. Faça login novamente.');
        setSubmitting(false);
        return;
      }

      const payload = {
        name: name.trim(),
        category,
        language,
        body,
        footer: footer.trim() || null,
        buttons: buttons
          .filter((b) => b.text.trim())
          .map((b) => ({ type: 'QUICK_REPLY', text: b.text.trim() })),
      };

      const url = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/whatsapp/templates`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: publicAnonKey,
          Authorization: `Bearer ${publicAnonKey}`,
          'X-User-Token': accessToken,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result?.success) {
        const errorMsg = result?.error || `Falha ao criar template (HTTP ${response.status}).`;
        toast.error('Não foi possível criar o template', { description: errorMsg, duration: 8000 });
        return;
      }

      toast.success('Template enviado para análise da Meta', {
        description: `${payload.name} • status: ${result.template?.status || 'PENDING'}. Aprovação leva alguns minutos a 24h.`,
        duration: 6000,
      });
      onCreated?.(result.template);
      reset();
      onOpenChange(false);
    } catch (err: any) {
      console.error('[CreateTemplateDialog] erro:', err);
      toast.error('Erro inesperado', { description: err?.message || 'Verifique o console.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0 flex flex-col">
        <DialogHeader className="p-6 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-[#0023D5]/10 flex items-center justify-center text-[#0023D5]">
              <Plus className="w-4 h-4" />
            </span>
            Criar template WhatsApp
          </DialogTitle>
          <DialogDescription>
            Após enviar, a Meta revisa em alguns minutos a 24h. Ao aprovar, fica disponível em "Modelos de mensagens".
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-0 flex-1 min-h-0 overflow-hidden">
          {/* Form */}
          <div className="px-6 pb-2 overflow-y-auto space-y-4">
            {/* Nome + Categoria + Idioma */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Nome do template</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                  placeholder="confirmar_visita_v1"
                  className="h-9 text-sm font-mono"
                />
                <p className="text-[10px] text-[#9CA3AF] mt-1">snake_case minúsculo. Não pode ser renomeado depois.</p>
                {name && !NAME_RE_FRIENDLY.test(name) && (
                  <p className="text-[10px] text-red-600 mt-0.5">Apenas letras minúsculas, números e _ (começa com letra).</p>
                )}
              </div>
              <div>
                <Label className="text-xs">Idioma</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_OPTIONS.map((l) => (
                      <SelectItem key={l.code} value={l.code}>{l.label} ({l.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs">Categoria</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as any)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-[#9CA3AF] mt-1">
                {CATEGORY_OPTIONS.find((c) => c.value === category)?.hint}
                {' '}A Meta pode reclassificar a categoria de ofício.
              </p>
            </div>

            {/* Body */}
            <div>
              <Label className="text-xs">Mensagem</Label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                placeholder={'Ex: Olá! Sua visita na Bluefit está confirmada.\n\nQualquer dúvida estou à disposição.'}
                className="text-sm"
              />
              <p className={cn('text-[10px] mt-1', body.length > 1024 ? 'text-red-600' : 'text-[#9CA3AF]')}>
                {body.length} / 1024 caracteres
              </p>
            </div>

            {/* Footer */}
            <div>
              <Label className="text-xs">Rodapé (opcional)</Label>
              <Input
                value={footer}
                onChange={(e) => setFooter(e.target.value)}
                placeholder="Até logo! Bluefit Paraíba"
                className="h-9 text-sm"
                maxLength={60}
              />
              <p className={cn('text-[10px] mt-1', footer.length > 60 ? 'text-red-600' : 'text-[#9CA3AF]')}>
                {footer.length} / 60 caracteres
              </p>
            </div>

            {/* Quick Reply Buttons */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-xs">Botões de resposta rápida (até 3, opcional)</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addButton}
                  disabled={buttons.length >= 3}
                  className="h-7 text-xs"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar
                </Button>
              </div>
              {buttons.length === 0 && (
                <p className="text-[10px] text-[#9CA3AF]">Nenhum botão. Cliente responde digitando.</p>
              )}
              <div className="space-y-2">
                {buttons.map((b, idx) => (
                  <div key={b.id} className="flex items-center gap-2">
                    <span className="text-[10px] text-[#9CA3AF] w-4">{idx + 1}</span>
                    <Input
                      value={b.text}
                      onChange={(e) => updateButton(b.id, e.target.value)}
                      placeholder="Ex: Podemos sim"
                      className="h-9 text-sm flex-1"
                      maxLength={25}
                    />
                    <span className={cn('text-[10px] w-10 text-right', b.text.length > 25 ? 'text-red-600' : 'text-[#9CA3AF]')}>
                      {b.text.length}/25
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => removeButton(b.id)}
                      className="h-8 w-8 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {validation && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {validation}
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="border-l border-[#F3F3F3] bg-[#E5DDD5]/40 p-4 overflow-y-auto">
            <div className="flex items-center gap-2 mb-3 text-xs text-[#6B7280]">
              <Smartphone className="w-3.5 h-3.5" /> Pré-visualização
            </div>
            <div className="bg-white rounded-2xl rounded-tl-sm shadow-sm p-3 max-w-[260px]">
              {body ? (
                <p className="text-[13px] leading-snug whitespace-pre-line text-[#1B1B1B]">{body}</p>
              ) : (
                <p className="text-[13px] text-[#9CA3AF] italic">A mensagem aparecerá aqui…</p>
              )}
              {footer && (
                <p className="text-[11px] text-[#6B7280] mt-2 leading-tight">{footer}</p>
              )}
            </div>
            {buttons.filter((b) => b.text.trim()).length > 0 && (
              <div className="mt-2 space-y-1.5 max-w-[260px]">
                {buttons.filter((b) => b.text.trim()).map((b) => (
                  <div
                    key={b.id}
                    className="bg-white rounded-lg shadow-sm py-2 px-3 text-center text-[13px] font-medium text-[#0079BA] border border-[#E5E7EB]"
                  >
                    {b.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="p-4 border-t border-[#F3F3F3]">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            onClick={handleSubmit}
            disabled={!!validation || submitting}
            className="bg-[#0023D5] hover:bg-[#0023D5]/90 text-white"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Enviar para análise da Meta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
