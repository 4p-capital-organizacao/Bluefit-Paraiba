import { useState, useEffect, useMemo } from 'react';
import { FileText, Send, X, Info, Search, Settings2, Eye, CheckCircle2, ChevronLeft, Zap, Link as LinkIcon, Lock, Clock, Snowflake, Archive } from 'lucide-react';
import { ConversationWithDetails, WhatsAppTemplate } from '../types/database';
import { fetchAvailableTemplates, sendWhatsAppTemplate, getTemplateThrottleStatus, moveConversationToBaseFria, TemplateThrottleStatus } from '../lib/whatsapp';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from './ui/drawer';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { toast } from 'sonner';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { supabase } from '../lib/supabase';

interface TemplateSelectorProps {
  conversation: ConversationWithDetails;
  onClose: () => void;
  onTemplateSent: () => void;
}

const categoryLabels: Record<string, string> = {
  marketing: 'Marketing',
  utility: 'Utilidade',
  authentication: 'Autenticação'
};

const categoryColors: Record<string, string> = {
  marketing: 'bg-purple-100 text-purple-700 border-purple-200',
  utility: 'bg-blue-100 text-blue-700 border-blue-200',
  authentication: 'bg-green-100 text-green-700 border-green-200'
};

export function TemplateSelector({ conversation, onClose, onTemplateSent }: TemplateSelectorProps) {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<WhatsAppTemplate | null>(null);
  const [bodyVariables, setBodyVariables] = useState<string[]>([]);
  const [headerVariables, setHeaderVariables] = useState<string[]>([]);
  const [buttonVariables, setButtonVariables] = useState<string[]>([]);
  const [headerMediaUrl, setHeaderMediaUrl] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'config'>('list');
  const [throttle, setThrottle] = useState<TemplateThrottleStatus | null>(null);
  const [actioning, setActioning] = useState(false);

  useEffect(() => {
    loadTemplates();
    refreshThrottle();
  }, []);

  async function refreshThrottle() {
    try {
      const status = await getTemplateThrottleStatus(conversation.id);
      setThrottle(status);
    } catch {
      setThrottle(null);
    }
  }

  // Fecha a conversa (mesma regra do ChatView): tira da esteira do operador.
  async function handleCloseConversation() {
    setActioning(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error('Você precisa estar logado para fechar conversas');
        return;
      }
      const { error } = await supabase
        .from('conversations')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .eq('id', conversation.id);
      if (error) {
        toast.error('Erro ao fechar conversa: ' + error.message);
        return;
      }
      await supabase.from('conversation_events').insert({
        conversation_id: conversation.id,
        event_type: 'status_changed',
        actor_user_id: user.id,
        metadata: { new_status: 'closed', old_status: conversation.status },
      });
      toast.success('Conversa fechada');
      onTemplateSent();
      onClose();
    } catch {
      toast.error('Erro ao fechar conversa');
    } finally {
      setActioning(false);
    }
  }

  async function handleMoveToBaseFria() {
    setActioning(true);
    try {
      const result = await moveConversationToBaseFria(conversation.id);
      if (!result.success) {
        toast.error('Erro ao mover para Base Fria', { description: result.error });
        return;
      }
      toast.success('Lead movido para a Base Fria');
      onTemplateSent();
      onClose();
    } finally {
      setActioning(false);
    }
  }

  async function loadTemplates() {
    setLoading(true);
    try {
      const data = await fetchAvailableTemplates();
      
      if (data.length === 0) {
        
        try {
          const configCheck = await fetch(
            `https://${window.location.hostname.includes('localhost') ? 'manvezhphopngpnaiyjv' : window.location.hostname.split('.')[0]}.supabase.co/functions/v1/make-server-844b77a1/api/whatsapp/config-check`,
            {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                'apikey': publicAnonKey,
                'Authorization': `Bearer ${publicAnonKey}`
              }
            }
          );
          
          if (configCheck.ok) {
            const configData = await configCheck.json();
            
            if (configData.criticalError && configData.criticalError.type === 'INVALID_PHONE_NUMBER_ID') {
              toast.error(
                configData.criticalError.message,
                { 
                  description: configData.criticalError.solution,
                  duration: 15000 
                }
              );
            } else if (!configData.success) {
              const missingVars = configData.missingVars || [];
              toast.error(
                `Configuração incompleta: ${missingVars.join(', ')} não configurado(s). ` +
                `Por favor, configure as variáveis de ambiente no Supabase.`,
                { duration: 8000 }
              );
            } else {
              toast.error('Nenhum template encontrado na conta WhatsApp Business. Crie templates no Meta Business Manager.');
            }
          } else {
            const errorText = await configCheck.text();
            toast.error('Nenhum template encontrado');
          }
        } catch (diagError) {
          toast.error('Nenhum template encontrado. Verifique se as credenciais da Meta estão configuradas corretamente.');
        }
      }
      
      setTemplates(data);
    } catch (error) {
      toast.error('Erro ao carregar templates. Verifique a configuração do WhatsApp nas variáveis de ambiente.');
    } finally {
      setLoading(false);
    }
  }

  const filteredTemplates = useMemo(() => {
    return templates.filter(t => 
      t.template_name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [templates, searchTerm]);

  const VARIABLE_REGEX = /\{\{(.*?)\}\}/g;

  const templateInfo = useMemo(() => {
    if (!selectedTemplate) return null;

    const bodyComponent = selectedTemplate.components?.find((c: any) => c.type === 'BODY');
    const headerComponent = selectedTemplate.components?.find((c: any) => c.type === 'HEADER');
    const footerComponent = selectedTemplate.components?.find((c: any) => c.type === 'FOOTER');
    const buttonsComponent = selectedTemplate.components?.find((c: any) => c.type === 'BUTTONS');

    const bodyText = bodyComponent?.text || '';
    const headerText = headerComponent?.text || '';
    
    const bodyMatches = [...bodyText.matchAll(VARIABLE_REGEX)];
    const bodyMatchNames = bodyMatches.map(m => m[1].trim());
    const bodyVarCount = bodyMatchNames.length;

    const headerMatches = [...headerText.matchAll(VARIABLE_REGEX)];
    const headerMatchNames = headerMatches.map(m => m[1].trim());
    const headerVarCount = headerMatchNames.length;

    let buttons: any[] = [];
    let buttonVarCount = 0;
    
    if (buttonsComponent && buttonsComponent.buttons) {
      buttons = buttonsComponent.buttons.map((btn: any, index: number) => {
        if (btn.type === 'URL' && btn.url && btn.url.includes('{{1}}')) {
          buttonVarCount++;
          return { ...btn, needsVariable: true, varIndex: index };
        }
        return { ...btn, needsVariable: false };
      });
    }

    return {
      bodyText,
      headerText,
      footerText: footerComponent?.text || '',
      bodyVarCount,
      bodyMatchNames,
      headerVarCount,
      headerMatchNames,
      headerFormat: headerComponent?.format || 'TEXT',
      buttons,
      buttonVarCount
    };
  }, [selectedTemplate]);

  function handleSelectTemplate(template: WhatsAppTemplate) {
    setSelectedTemplate(template);
    setMobileView('config');
    
    const bodyComponent = template.components?.find((c: any) => c.type === 'BODY');
    const headerComponent = template.components?.find((c: any) => c.type === 'HEADER');
    const buttonsComponent = template.components?.find((c: any) => c.type === 'BUTTONS');
    
    const bodyText = bodyComponent?.text || '';
    const headerText = headerComponent?.text || '';

    const bodyMatches = [...bodyText.matchAll(VARIABLE_REGEX)];
    const headerMatches = [...headerText.matchAll(VARIABLE_REGEX)];
    
    setBodyVariables(Array(bodyMatches.length).fill(''));
    setHeaderVariables(Array(headerMatches.length).fill(''));
    
    let buttonVars = 0;
    if (buttonsComponent && buttonsComponent.buttons) {
      buttonsComponent.buttons.forEach((btn: any) => {
        if (btn.type === 'URL' && btn.url && btn.url.includes('{{1}}')) {
          buttonVars++;
        }
      });
    }
    setButtonVariables(Array(buttonVars).fill(''));
  }

  async function handleSendTemplate() {
    if (!selectedTemplate || !templateInfo) return;

    // 🚦 Trava: barra no cliente (o backend também barra como fonte da verdade)
    if (throttle && !throttle.allowed) {
      toast.error('Envio de template travado para este cliente', {
        description: throttle.hardBlocked
          ? `Já foram enviados ${throttle.streak} templates sem resposta. Aguarde o cliente responder.`
          : `O ${throttle.streak + 1}º template só libera em ${formatCountdown(throttle.nextAllowedAt)}.`,
        duration: 7000,
      });
      return;
    }

    const needsHeaderVars = templateInfo.headerVarCount > 0 && templateInfo.headerFormat === 'TEXT';
    const needsBodyVars = templateInfo.bodyVarCount > 0;
    const needsButtonVars = templateInfo.buttonVarCount > 0;
    const needsHeaderMedia = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(templateInfo.headerFormat);
    
    if (needsBodyVars && bodyVariables.some(v => !v || v.trim() === '')) {
      toast.error('Por favor, preencha todas as variáveis do corpo');
      return;
    }
    
    if (needsHeaderVars && headerVariables.some(v => !v || v.trim() === '')) {
      toast.error('Por favor, preencha todas as variáveis do cabeçalho');
      return;
    }

    if (needsButtonVars && buttonVariables.some(v => !v || v.trim() === '')) {
      toast.error('Por favor, preencha as variáveis dos botões (URL dinâmica)');
      return;
    }

    if (needsHeaderMedia && !headerMediaUrl.trim()) {
      toast.error(`Por favor, forneça a URL da ${templateInfo.headerFormat.toLowerCase()}`, {
        description: 'Templates com mídia no cabeçalho exigem uma URL pública acessível.',
        duration: 6000
      });
      return;
    }

    setSending(true);

    let components: any[] = [];

    try {
      const headerComponent = selectedTemplate.components?.find((c: any) => c.type === 'HEADER');

      if (headerComponent && templateInfo.headerFormat === 'TEXT' && headerVariables.length > 0) {
        const validHeaderParams = headerVariables
          .map(v => v?.trim())
          .filter(v => v && v.length > 0);
        
        if (validHeaderParams.length === templateInfo.headerVarCount) {
          components.push({
            type: 'header',
            parameters: validHeaderParams.map((v) => ({
              type: 'text',
              text: v
            }))
          });
        }
      }

      if (headerComponent && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(templateInfo.headerFormat) && headerMediaUrl.trim()) {
        const mediaType = templateInfo.headerFormat.toLowerCase();
        components.push({
          type: 'header',
          parameters: [{
            type: mediaType,
            [mediaType]: {
              link: headerMediaUrl.trim()
            }
          }]
        });
      }

      if (bodyVariables.length > 0) {
        const validBodyParams = bodyVariables
          .map(v => v?.trim())
          .filter(v => v && v.length > 0);
        
        if (validBodyParams.length === templateInfo.bodyVarCount) {
          components.push({
            type: 'body',
            parameters: validBodyParams.map((v, idx) => {
              const varName = templateInfo.bodyMatchNames[idx];
              const isPositional = /^\d+$/.test(varName);
              
              if (isPositional) {
                return { type: 'text', text: v };
              } else {
                return { type: 'text', text: v, parameter_name: varName };
              }
            })
          });
        }
      }

      if (templateInfo.buttonVarCount > 0) {
        let varIndex = 0;
        templateInfo.buttons.forEach((btn: any, index: number) => {
          if (btn.needsVariable) {
            const val = buttonVariables[varIndex]?.trim();
            if (val && val.length > 0) {
              components.push({
                type: 'button',
                sub_type: 'url',
                index: String(index),
                parameters: [{ type: 'text', text: val }]
              });
            }
            varIndex++;
          }
        });
      }

      const phoneNumber = conversation.contact.phone_number || conversation.contact.wa_id || '';
      const componentsToSend = (components.length > 0) ? components : undefined;
      
      const result = await sendWhatsAppTemplate(
        conversation.id,
        phoneNumber,
        selectedTemplate.template_name,
        selectedTemplate.language,
        componentsToSend
      );

      if (!result.success) {
        throw new Error(result.error || 'Erro ao enviar template');
      }

      toast.success('Template enviado com sucesso!');
      onTemplateSent();
      onClose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Falha no envio';
      
      toast.error(`Erro ao enviar: ${errorMessage}`, {
        description: 'Verifique se todos os campos foram preenchidos corretamente.',
        duration: 8000
      });
    } finally {
      setSending(false);
    }
  }

  const getPreviewText = () => {
    if (!templateInfo) return '';
    let currentIndex = 0;
    return templateInfo.bodyText.replace(VARIABLE_REGEX, (match) => {
      const val = bodyVariables[currentIndex];
      currentIndex++;
      return val || match;
    });
  };

  function formatCountdown(target: Date | null): string {
    if (!target) return 'em breve';
    const ms = target.getTime() - Date.now();
    if (ms <= 0) return 'agora';
    const totalMin = Math.ceil(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h >= 1) return `${h}h${m > 0 ? ` ${m}min` : ''}`;
    return `${m}min`;
  }

  const isBlocked = !!throttle && !throttle.allowed;
  const isHardBlocked = !!throttle?.hardBlocked;

  const throttleBanner = isBlocked ? (
    <div className={`rounded-lg border p-2.5 flex gap-2 ${isHardBlocked ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
      {isHardBlocked
        ? <Lock className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
        : <Clock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />}
      <div className="min-w-0">
        <p className={`text-[11px] font-bold ${isHardBlocked ? 'text-red-900' : 'text-amber-900'}`}>
          {isHardBlocked
            ? `Trava: ${throttle!.streak} templates enviados sem resposta`
            : `Aguardando intervalo do ${throttle!.streak + 1}º template`}
        </p>
        <p className={`text-[10px] mt-0.5 ${isHardBlocked ? 'text-red-700' : 'text-amber-700'}`}>
          {isHardBlocked
            ? 'Aguarde o cliente responder antes de enviar outro template. Se não houver resposta, feche a conversa ou mova o lead para a Base Fria.'
            : `O próximo template só pode ser enviado em ${formatCountdown(throttle!.nextAllowedAt)} (regra de ${throttle!.requiredHours}h). Qualquer resposta do cliente libera na hora.`}
        </p>
      </div>
    </div>
  ) : null;

  const hasVariables = templateInfo && (
    templateInfo.headerVarCount > 0 ||
    templateInfo.bodyVarCount > 0 ||
    templateInfo.buttonVarCount > 0 ||
    templateInfo.headerFormat !== 'TEXT'
  );

  return (
    <Drawer open onOpenChange={(open) => { if (!open) onClose(); }} direction="right">
      <DrawerContent className="inset-y-0 right-0 left-auto w-full sm:w-[520px] md:w-[600px] lg:w-[820px] sm:max-w-[90vw] rounded-none sm:rounded-l-2xl border-l flex flex-col h-full max-h-screen">
        {/* Header */}
        <DrawerHeader className="px-4 py-3 bg-gradient-to-br from-blue-600 to-blue-700 border-b border-blue-500/20 shrink-0 gap-0">
          <div className="flex items-center gap-2.5">
            {selectedTemplate && mobileView === 'config' && (
              <Button 
                variant="ghost" 
                size="icon" 
                className="md:hidden -ml-1 text-white hover:bg-white/10 h-7 w-7"
                onClick={() => setMobileView('list')}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
            )}
            <div className="p-1.5 bg-white/10 backdrop-blur-sm rounded-lg text-white">
              <FileText className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <DrawerTitle className="text-sm font-bold text-white truncate">
                {selectedTemplate && mobileView === 'config' ? 'Configurar & Enviar' : 'Selecionar Template'}
              </DrawerTitle>
              <DrawerDescription className="text-xs text-blue-100 font-medium truncate leading-tight mt-0.5">
                {conversation.contact?.first_name || conversation.contact?.display_name || 'Contato'} &bull; {conversation.contact?.phone_number}
              </DrawerDescription>
            </div>
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/10 rounded-full h-7 w-7" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </DrawerHeader>

        {/* Body: split layout */}
        <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden bg-slate-50">
          {/* Left: Template List */}
          <div className={`
            ${mobileView === 'config' ? 'hidden md:flex' : 'flex'}
            flex-col border-r border-slate-200 bg-white w-full md:w-[260px] lg:w-[300px] shrink-0 min-h-0 h-full overflow-hidden
          `}>
            {/* Search */}
            <div className="p-3 bg-white border-b border-slate-200 shrink-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input 
                  placeholder="Buscar templates..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 pr-3 bg-slate-50 border-slate-200 h-8 text-xs focus-visible:ring-1 focus-visible:ring-blue-500 rounded-lg"
                />
              </div>
              
              {!loading && (
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">
                    {filteredTemplates.length} templates
                  </span>
                  {searchTerm && (
                    <button 
                      onClick={() => setSearchTerm('')}
                      className="text-blue-600 hover:text-blue-700 font-semibold"
                    >
                      Limpar
                    </button>
                  )}
                </div>
              )}
            </div>
            
            {/* List */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="p-2 space-y-1">
                {loading ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-600 border-t-transparent mb-3"></div>
                    <p className="text-xs font-semibold text-slate-500">Carregando...</p>
                  </div>
                ) : filteredTemplates.length === 0 ? (
                  <div className="text-center py-12 px-4">
                    <div className="bg-slate-100 p-3 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-3">
                      <Search className="w-5 h-5 text-slate-300" />
                    </div>
                    <p className="text-slate-700 font-bold text-xs">Nenhum template</p>
                  </div>
                ) : (
                  filteredTemplates.map((template) => {
                    const isSelected = selectedTemplate?.template_name === template.template_name;
                    const bodyComponent = template.components?.find((c: any) => c.type === 'BODY');
                    const bodyMatches = (bodyComponent?.text || '').match(VARIABLE_REGEX) || [];
                    const templateHasVars = bodyMatches.length > 0;
                    
                    return (
                      <button
                        key={`${template.template_name}-${template.language}`}
                        onClick={() => handleSelectTemplate(template)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-150 ${
                          isSelected
                            ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500/20'
                            : 'border-transparent bg-white hover:border-blue-200 hover:bg-slate-50'
                        }`}
                      >
                        <h4 className={`font-semibold text-xs truncate ${isSelected ? 'text-blue-700' : 'text-slate-800'}`}>
                          {template.template_name}
                        </h4>
                        <div className="flex items-center gap-1.5 mt-1">
                          <Badge 
                            variant="outline" 
                            className={`text-[9px] h-4 px-1.5 font-bold uppercase leading-none ${categoryColors[template.category] || 'bg-slate-100 text-slate-600 border-slate-200'}`}
                          >
                            {categoryLabels[template.category] || template.category}
                          </Badge>
                          <span className="text-[9px] text-slate-400 font-medium uppercase">{template.language}</span>
                          {templateHasVars && (
                            <span className="flex items-center gap-0.5 text-[9px] text-amber-600 font-semibold ml-auto">
                              <Zap className="w-2.5 h-2.5" />
                              Vars
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Right: Preview & Config */}
          <div className={`
            ${mobileView === 'list' ? 'hidden md:flex' : 'flex'}
            flex-col flex-1 bg-slate-50 min-h-0 overflow-hidden w-full
          `}>
            {selectedTemplate && templateInfo ? (
              <>
                {/* Preview area - scrollable, takes remaining space */}
                <div className="flex-1 min-h-0 overflow-y-auto p-3 md:p-4">
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="p-0.5 bg-green-100 text-green-700 rounded">
                      <Eye className="w-3 h-3" />
                    </div>
                    <h3 className="text-xs font-bold text-slate-900">Preview</h3>
                  </div>
                  
                  {/* WhatsApp Bubble - no internal scroll */}
                  <div className="relative bg-[#E5DDD5] p-2 rounded-lg shadow-sm w-full max-w-[280px] mx-auto">
                    <div className="absolute inset-0 opacity-[0.04] rounded-lg" style={{ 
                      backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")',
                      backgroundSize: '300px'
                    }}></div>
                    
                    <div className="relative bg-white rounded shadow-sm overflow-hidden border border-black/5">
                      {templateInfo.headerFormat === 'IMAGE' && headerMediaUrl && (
                        <div className="w-full h-20 bg-slate-100 flex items-center justify-center overflow-hidden">
                          <img src={headerMediaUrl} alt="Header" className="w-full h-full object-cover" />
                        </div>
                      )}
                      
                      {templateInfo.headerText && (
                        <div className="px-2 py-1 bg-slate-50/50 border-b border-slate-100">
                          <p className="font-bold text-slate-900 text-[10px] leading-snug">
                            {(() => {
                              let currentIndex = 0;
                              return templateInfo.headerText.replace(VARIABLE_REGEX, (match) => {
                                const val = headerVariables[currentIndex];
                                currentIndex++;
                                return val || match;
                              });
                            })()}
                          </p>
                        </div>
                      )}
                      
                      <div className="p-2 space-y-1">
                        <p className="text-slate-800 text-[10px] whitespace-pre-wrap leading-relaxed">
                          {getPreviewText()}
                        </p>
                        
                        {templateInfo.footerText && (
                          <p className="text-slate-500 text-[9px] pt-1 border-t border-slate-100">
                            {templateInfo.footerText}
                          </p>
                        )}
                        
                        <div className="flex justify-end items-center gap-0.5 pt-0.5">
                          <span className="text-[8px] text-slate-400">12:00</span>
                          <CheckCircle2 className="w-2.5 h-2.5 text-blue-500" />
                        </div>
                      </div>

                      {templateInfo.buttons.length > 0 && (
                        <div className="bg-slate-50 border-t border-slate-100">
                          {templateInfo.buttons.map((btn: any, i: number) => (
                            <div key={i} className="flex items-center justify-center p-1.5 border-b border-slate-100 last:border-0 text-blue-500 text-[10px] font-semibold">
                              {btn.type === 'URL' && <LinkIcon className="w-2.5 h-2.5 mr-0.5" />}
                              {btn.text}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* No Variables Info - inside scroll area since it's just info */}
                  {templateInfo.headerVarCount === 0 && templateInfo.bodyVarCount === 0 && templateInfo.buttonVarCount === 0 && templateInfo.headerFormat === 'TEXT' && (
                    <div className="bg-blue-50/50 rounded-lg border border-blue-100 p-2.5 flex gap-2 mt-3 max-w-[280px] mx-auto">
                      <Info className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[11px] font-semibold text-blue-900">Pronto para Envio</p>
                        <p className="text-[10px] text-blue-700 mt-0.5">
                          Este template não requer preenchimento de variáveis.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Fixed Variables Section - pinned above footer */}
                {hasVariables && (
                  <div className="shrink-0 px-3 md:px-4 py-2 bg-white border-t border-slate-200 overflow-y-auto max-h-[40%]">
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="p-0.5 bg-blue-100 text-blue-700 rounded">
                        <Settings2 className="w-3 h-3" />
                      </div>
                      <h3 className="text-xs font-bold text-slate-900">Preencher Variáveis</h3>
                    </div>

                    <div className="space-y-2">
                      {/* Header Media URL */}
                      {templateInfo.headerFormat !== 'TEXT' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(templateInfo.headerFormat) && (
                        <div className="bg-slate-50 rounded-lg border border-slate-200 p-2.5 space-y-1.5">
                          <Label className="text-[10px] font-bold text-slate-500 uppercase">Mídia ({templateInfo.headerFormat})</Label>
                          <Input
                            value={headerMediaUrl}
                            onChange={(e) => setHeaderMediaUrl(e.target.value)}
                            placeholder="https://..."
                            className="bg-white h-7 text-[11px]"
                          />
                        </div>
                      )}

                      {/* Header Variables */}
                      {templateInfo.headerVarCount > 0 && templateInfo.headerFormat === 'TEXT' && (
                        <div className="bg-slate-50 rounded-lg border border-slate-200 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-[10px] font-bold text-slate-500 uppercase">Cabeçalho</Label>
                            <Badge variant="secondary" className="text-[8px] h-3.5 px-1">{templateInfo.headerMatchNames.join(', ')}</Badge>
                          </div>
                          {headerVariables.map((val, i) => (
                            <div key={`h-v-${i}`} className="space-y-0.5">
                              <Label className="text-[10px] font-medium text-slate-600">
                                {templateInfo.headerMatchNames[i] || `Variável ${i + 1}`}
                              </Label>
                              <Input
                                value={val}
                                onChange={(e) => {
                                  const next = [...headerVariables];
                                  next[i] = e.target.value;
                                  setHeaderVariables(next);
                                }}
                                placeholder={`Valor para ${templateInfo.headerMatchNames[i] || `{{${i+1}}}`}`}
                                className="bg-white h-7 text-[11px]"
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Body Variables */}
                      {templateInfo.bodyVarCount > 0 && (
                        <div className="bg-slate-50 rounded-lg border border-slate-200 p-2.5 space-y-1.5">
                          <Label className="text-[10px] font-bold text-slate-500 uppercase">Corpo da Mensagem</Label>
                          {bodyVariables.map((val, i) => (
                            <div key={`b-v-${i}`} className="space-y-0.5">
                              <Label className="text-[10px] font-medium text-slate-600">
                                {templateInfo.bodyMatchNames[i] || `Variável ${i + 1}`}
                              </Label>
                              <Input
                                value={val}
                                onChange={(e) => {
                                  const next = [...bodyVariables];
                                  next[i] = e.target.value;
                                  setBodyVariables(next);
                                }}
                                placeholder={`Valor para ${templateInfo.bodyMatchNames[i] || `{{${i+1}}}`}`}
                                className="bg-white h-7 text-[11px]"
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Button Variables */}
                      {templateInfo.buttonVarCount > 0 && (
                        <div className="bg-slate-50 rounded-lg border border-slate-200 p-2.5 space-y-1.5">
                          <Label className="text-[10px] font-bold text-slate-500 uppercase">Botões (Link Dinâmico)</Label>
                          {templateInfo.buttons.filter((b: any) => b.needsVariable).map((btn: any, i: number) => (
                            <div key={`btn-v-${i}`} className="space-y-0.5">
                              <Label className="text-[10px] font-medium text-slate-600">
                                {btn.text} (Final do Link)
                              </Label>
                              <div className="flex items-center gap-1.5">
                                <div className="bg-slate-100 px-1.5 py-1 rounded text-[9px] text-slate-500 font-mono truncate max-w-[100px]">
                                  {btn.url.split('{{')[0]}
                                </div>
                                <Input
                                  value={buttonVariables[i]}
                                  onChange={(e) => {
                                    const next = [...buttonVariables];
                                    next[i] = e.target.value;
                                    setButtonVariables(next);
                                  }}
                                  placeholder="ex: 12345"
                                  className="bg-white h-7 text-[11px] flex-1"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Fixed Footer */}
                <div className="shrink-0 px-3 py-2 bg-white border-t border-slate-200 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] z-20 space-y-2">
                  {throttleBanner}

                  {isHardBlocked ? (
                    /* Trava dura: oferece tirar o lead da esteira do operador */
                    <div className="flex items-center justify-end gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        onClick={onClose}
                        className="h-8 px-3 text-[11px] font-medium rounded-lg"
                      >
                        Cancelar
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleCloseConversation}
                        disabled={actioning}
                        className="h-8 px-3 text-[11px] font-semibold rounded-lg border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-60"
                      >
                        <Archive className="w-3 h-3" />
                        <span>Fechar conversa</span>
                      </Button>
                      <Button
                        onClick={handleMoveToBaseFria}
                        disabled={actioning}
                        className="bg-sky-600 hover:bg-sky-700 text-white font-bold h-8 px-4 rounded-lg shadow-sm flex items-center gap-1.5 text-[11px] disabled:opacity-60"
                      >
                        <Snowflake className="w-3 h-3" />
                        <span>Mover p/ Base Fria</span>
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={onClose}
                        className="h-8 px-3 text-[11px] font-medium rounded-lg"
                      >
                        Cancelar
                      </Button>
                      <Button
                        onClick={handleSendTemplate}
                        disabled={sending || isBlocked}
                        title={isBlocked ? 'Envio travado para este cliente' : undefined}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold h-8 px-4 rounded-lg shadow-sm transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5 text-[11px]"
                      >
                        {sending ? (
                          <>
                            <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                            <span>Enviando...</span>
                          </>
                        ) : isBlocked ? (
                          <>
                            <Lock className="w-3 h-3" />
                            <span>Travado ({formatCountdown(throttle!.nextAllowedAt)})</span>
                          </>
                        ) : (
                          <>
                            <Send className="w-3 h-3" />
                            <span>Enviar Template</span>
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-50/50">
                {throttleBanner && (
                  <div className="w-full max-w-[320px] mb-4 text-left">{throttleBanner}</div>
                )}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 mb-4">
                  <FileText className="w-10 h-10 text-slate-300" />
                </div>
                <h3 className="text-sm font-bold text-slate-800 mb-1">Selecione um Template</h3>
                <p className="text-xs text-slate-500 max-w-[280px]">
                  Escolha um template na lista à esquerda para visualizar e configurar o envio.
                </p>
              </div>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}