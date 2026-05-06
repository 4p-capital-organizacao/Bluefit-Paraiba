import { useState, useEffect } from 'react';
import { Lead, LeadStatus, Unit } from '../../types/database';
import { supabase } from '../../lib/supabase';
import { UserProfile } from '../../hooks/useUserProfile';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { LeadHistory } from './LeadHistory';
import { toast } from 'sonner';
import { History, Building2, Info } from 'lucide-react';
import { cn } from '../ui/utils';

interface LeadFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead?: Lead | null;
  onSuccess: () => void;
  userProfile?: UserProfile;
}

const statusOptions: { value: LeadStatus; label: string }[] = [
  { value: 'novo', label: 'Novo' },
  { value: 'contato_feito', label: 'Contato Feito' },
  { value: 'visita_agendada', label: 'Visita Agendada' },
  { value: 'visita_realizada', label: 'Visita Realizada' },
  { value: 'visita_cancelada', label: 'Visita Cancelada' },
  { value: 'matriculado', label: 'Matriculado' },
  { value: 'base_fria', label: 'Base fria' },
  { value: 'perdido', label: 'Perdido' },
];

export function LeadFormDialog({ open, onOpenChange, lead, onSuccess, userProfile }: LeadFormDialogProps) {
  const [loading, setLoading] = useState(false);
  const [units, setUnits] = useState<Unit[]>([]);
  
  const [formData, setFormData] = useState({
    nome_completo: '',
    telefone: '',
    email: '',
    situacao: 'novo' as LeadStatus,
    origem: '',
    campanha: '',
    midia: '',
    pontuacao: null as number | null,
    classificacao: '',
    responsavel: '',
    ja_treina: '',
    objetivo_principal: '',
    mora_ou_trabalha_perto: '',
    quando_quer_comecar: '',
    motivo_cancelamento: '',
    id_unidade: null as number | null,
  });

  useEffect(() => {
    if (open) {
      loadUnits();
      
      if (lead) {
        // Editando lead existente
        setFormData({
          nome_completo: lead.nome_completo || '',
          telefone: lead.telefone || '',
          email: lead.email || '',
          situacao: lead.situacao || 'novo',
          origem: lead.origem || '',
          campanha: lead.campanha || '',
          midia: lead.midia || '',
          pontuacao: lead.pontuacao ?? null,
          classificacao: lead.classificacao || '',
          responsavel: lead.responsavel || '',
          ja_treina: lead.ja_treina || '',
          objetivo_principal: lead.objetivo_principal || '',
          mora_ou_trabalha_perto: lead.mora_ou_trabalha_perto || '',
          quando_quer_comecar: lead.quando_quer_comecar || '',
          motivo_cancelamento: lead.motivo_cancelamento || '',
          id_unidade: lead.id_unidade ?? null,
        });
      } else {
        // Novo lead: auto-atribuir unidade do usuário logado
        setFormData({
          nome_completo: '',
          telefone: '',
          email: '',
          situacao: 'novo',
          origem: '',
          campanha: '',
          midia: '',
          pontuacao: null,
          classificacao: '',
          responsavel: '',
          ja_treina: '',
          objetivo_principal: '',
          mora_ou_trabalha_perto: '',
          quando_quer_comecar: '',
          motivo_cancelamento: '',
          id_unidade: userProfile?.id_unidade ?? null,
        });
      }
    }
  }, [open, lead, userProfile]);

  async function loadUnits() {
    try {
      const { data } = await supabase
        .from('units')
        .select('*')
        .order('name');
      
      if (data) setUnits(data);
    } catch (error) {
      console.error('Erro ao carregar unidades:', error);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      if (!formData.nome_completo.trim()) {
        toast.error('Nome é obrigatório');
        setLoading(false);
        return;
      }

      if (!formData.telefone.trim()) {
        toast.error('Telefone é obrigatório');
        setLoading(false);
        return;
      }

      // Garantir que a unidade seja atribuída
      const finalUnitId = formData.id_unidade ?? userProfile?.id_unidade ?? null;

      const leadData = {
        nome_completo: formData.nome_completo.trim(),
        telefone: formData.telefone.trim(),
        email: formData.email.trim() || null,
        situacao: formData.situacao,
        origem: formData.origem.trim() || null,
        campanha: formData.campanha.trim() || null,
        midia: formData.midia.trim() || null,
        pontuacao: formData.pontuacao ?? null,
        classificacao: formData.classificacao.trim() || null,
        responsavel: formData.responsavel.trim() || null,
        ja_treina: formData.ja_treina.trim() || null,
        objetivo_principal: formData.objetivo_principal.trim() || null,
        mora_ou_trabalha_perto: formData.mora_ou_trabalha_perto.trim() || null,
        quando_quer_comecar: formData.quando_quer_comecar.trim() || null,
        motivo_cancelamento: formData.motivo_cancelamento.trim() || null,
        id_unidade: finalUnitId,
      };

      if (lead) {
        // ── EDIÇÃO de lead existente ──
        const { error } = await supabase
          .from('leads')
          .update(leadData)
          .eq('id', lead.id);

        if (error) throw error;
        toast.success('Lead atualizado com sucesso!');
      } else {
        // ── CRIAÇÃO de lead novo ──
        // INSERT simples na tabela. O onboarding (contact + conversation)
        // é feito ao clicar no botão WhatsApp no Kanban.
        const { data: newLead, error } = await supabase
          .from('leads')
          .insert(leadData)
          .select()
          .single();

        if (error) throw error;

        console.log('✅ [CREATE LEAD] Lead inserido:', newLead.id);
        toast.success('Lead criado com sucesso!', {
          description: 'Clique no botão WhatsApp no card para iniciar o contato.',
          duration: 5000,
        });
      }

      onSuccess();
      onOpenChange(false);
    } catch (error) {
      console.error('Erro ao salvar lead:', error);
      toast.error('Erro ao salvar lead. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  // Verificar se o usuário pode alterar a unidade
  // - isFullAdmin pode ver TODAS as unidades
  // - Usuário multi-unidade pode escolher entre suas unidades
  // - Usuário single-unidade vê readonly
  const isMultiUnit = (userProfile?.unitIds?.length ?? 0) > 1;
  const canChangeUnit = userProfile?.isFullAdmin ?? false;
  const canPickFromOwnUnits = isMultiUnit && !canChangeUnit;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold text-slate-900">
            {lead ? 'Editar Lead' : 'Novo Lead'}
          </DialogTitle>
          <DialogDescription className="text-sm text-slate-500">
            {lead ? 'Atualize as informações do lead' : 'Preencha os campos para criar um novo lead'}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="informacoes">
          <TabsList className={cn("grid", lead ? "grid-cols-2" : "grid-cols-1")}>
            <TabsTrigger value="informacoes">Informações</TabsTrigger>
            {lead && (
              <TabsTrigger value="historico">
                <History className="mr-2 h-4 w-4" />
                Histórico
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="informacoes">
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Informações Básicas */}
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-900">Informações Básicas</h3>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="nome_completo">Nome *</Label>
                    <Input
                      id="nome_completo"
                      value={formData.nome_completo}
                      onChange={(e) => setFormData({ ...formData, nome_completo: e.target.value })}
                      placeholder="Nome completo"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="telefone">Telefone *</Label>
                    <Input
                      id="telefone"
                      value={formData.telefone}
                      onChange={(e) => setFormData({ ...formData, telefone: e.target.value })}
                      placeholder="(00) 00000-0000"
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="email@exemplo.com"
                  />
                </div>
              </div>

              {/* Status e Responsável */}
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-900">Status e Atribuição</h3>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="situacao">Status</Label>
                    <Select
                      value={formData.situacao}
                      onValueChange={(value: LeadStatus) => setFormData({ ...formData, situacao: value })}
                    >
                      <SelectTrigger id="situacao">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {statusOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="responsavel">Responsável</Label>
                    <Input
                      id="responsavel"
                      value={formData.responsavel}
                      onChange={(e) => setFormData({ ...formData, responsavel: e.target.value })}
                      placeholder="Nome do responsável"
                    />
                  </div>
                </div>

                {/* Unidade */}
                <div className="space-y-2">
                  <Label htmlFor="id_unidade" className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-slate-500" />
                    Unidade
                    {!canChangeUnit && !canPickFromOwnUnits && formData.id_unidade && (
                      <span className="text-xs text-slate-400 font-normal flex items-center gap-1">
                        <Info className="w-3 h-3" />
                        Atribuída automaticamente
                      </span>
                    )}
                  </Label>
                  {canChangeUnit ? (
                    <Select
                      value={formData.id_unidade ? formData.id_unidade.toString() : "none"}
                      onValueChange={(value) => setFormData({ ...formData, id_unidade: value === "none" ? null : parseInt(value) })}
                    >
                      <SelectTrigger id="id_unidade">
                        <SelectValue placeholder="Selecionar unidade" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Nenhuma</SelectItem>
                        {units.map((unit) => (
                          <SelectItem key={unit.id} value={unit.id.toString()}>
                            {unit.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : canPickFromOwnUnits ? (
                    <Select
                      value={formData.id_unidade ? formData.id_unidade.toString() : "none"}
                      onValueChange={(value) => setFormData({ ...formData, id_unidade: value === "none" ? null : parseInt(value) })}
                    >
                      <SelectTrigger id="id_unidade">
                        <SelectValue placeholder="Selecionar unidade" />
                      </SelectTrigger>
                      <SelectContent>
                        {(userProfile?.unitIds ?? []).map((uid) => {
                          const unitName = userProfile?.unitNames?.[uid] || `Unidade ${uid}`;
                          return (
                            <SelectItem key={uid} value={uid.toString()}>
                              {unitName}
                              {uid === userProfile?.id_unidade ? ' (principal)' : ''}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex items-center gap-2 h-10 px-3 border border-slate-200 rounded-md bg-slate-50">
                      <Building2 className="w-4 h-4 text-[#0028e6]" />
                      <span className="text-sm text-slate-700">
                        {userProfile?.unitName || (formData.id_unidade ? `Unidade ${formData.id_unidade}` : 'Sem unidade')}
                      </span>
                    </div>
                  )}
                </div>

                {/* Motivo cancelamento (visível apenas para status cancelado/perdido) */}
                {(formData.situacao === 'visita_cancelada' || formData.situacao === 'perdido') && (
                  <div className="space-y-2">
                    <Label htmlFor="motivo_cancelamento">Motivo do Cancelamento</Label>
                    <Input
                      id="motivo_cancelamento"
                      value={formData.motivo_cancelamento}
                      onChange={(e) => setFormData({ ...formData, motivo_cancelamento: e.target.value })}
                      placeholder="Descreva o motivo..."
                    />
                  </div>
                )}
              </div>

              {/* Detalhes do Lead */}
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-900">Detalhes</h3>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="origem">Origem</Label>
                    <Input
                      id="origem"
                      value={formData.origem}
                      onChange={(e) => setFormData({ ...formData, origem: e.target.value })}
                      placeholder="Ex: Instagram, Indicação, Google"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="campanha">Campanha</Label>
                    <Input
                      id="campanha"
                      value={formData.campanha}
                      onChange={(e) => setFormData({ ...formData, campanha: e.target.value })}
                      placeholder="Nome da campanha"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="midia">Mídia</Label>
                    <Input
                      id="midia"
                      value={formData.midia}
                      onChange={(e) => setFormData({ ...formData, midia: e.target.value })}
                      placeholder="Ex: Facebook Ads, Google Ads"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="objetivo_principal">Objetivo Principal</Label>
                    <Input
                      id="objetivo_principal"
                      value={formData.objetivo_principal}
                      onChange={(e) => setFormData({ ...formData, objetivo_principal: e.target.value })}
                      placeholder="Ex: Emagrecimento, Hipertrofia"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="pontuacao">Pontuação</Label>
                    <Input
                      id="pontuacao"
                      type="number"
                      min="0"
                      max="100"
                      value={formData.pontuacao ?? ''}
                      onChange={(e) => setFormData({ ...formData, pontuacao: e.target.value ? parseInt(e.target.value) : null })}
                      placeholder="0 a 100"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="classificacao">Classificação</Label>
                    <Input
                      id="classificacao"
                      value={formData.classificacao}
                      onChange={(e) => setFormData({ ...formData, classificacao: e.target.value })}
                      placeholder="Ex: Quente, Frio, Morno"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="ja_treina">Já treina?</Label>
                    <Input
                      id="ja_treina"
                      value={formData.ja_treina}
                      onChange={(e) => setFormData({ ...formData, ja_treina: e.target.value })}
                      placeholder="Ex: Sim, Não, Em casa"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="quando_quer_comecar">Quando quer começar?</Label>
                    <Input
                      id="quando_quer_comecar"
                      value={formData.quando_quer_comecar}
                      onChange={(e) => setFormData({ ...formData, quando_quer_comecar: e.target.value })}
                      placeholder="Ex: Imediato, Próximo mês"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mora_ou_trabalha_perto">Mora ou trabalha perto?</Label>
                  <Input
                    id="mora_ou_trabalha_perto"
                    value={formData.mora_ou_trabalha_perto}
                    onChange={(e) => setFormData({ ...formData, mora_ou_trabalha_perto: e.target.value })}
                    placeholder="Ex: Sim, mora a 5 min"
                  />
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={loading}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  disabled={loading}
                  className="bg-[#0028e6] hover:bg-[#0020b8]"
                >
                  {loading ? 'Salvando...' : lead ? 'Salvar' : 'Criar Lead'}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          <TabsContent value="historico">
            {lead?.id && <LeadHistory leadId={lead.id} />}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}