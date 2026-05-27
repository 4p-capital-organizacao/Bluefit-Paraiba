import { useState, useEffect, useRef } from 'react';
import { Send, AlertCircle, FileText, User as UserIcon, Tag as TagIcon, X, XCircle, StickyNote, Image as ImageIcon, Mic, Calendar, Smile, Paperclip, CircleDot, Lock, UserCheck, Building2, Clock, Zap } from 'lucide-react';
import { MessageBubble, normalizeStatus, getStatusIcon } from './MessageBubble';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ConversationWithDetails, Message, MessageStatus, Profile, Tag } from '../types/database';
import { supabase } from '../lib/supabase';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { formatTime, formatDateLabel } from '../lib/dateUtils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { cn } from './ui/utils';
import { TemplateSelector } from './TemplateSelector';
import { toast } from 'sonner';
import { usePresence } from '../hooks/usePresence';
import { PresenceIndicator } from './PresenceIndicator';
import { NotesDialog } from './NotesDialog';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Alert, AlertDescription } from './ui/alert';
import { AudioRecorder } from './AudioRecorder';
import { ScheduleCallbackDialog } from './ScheduleCallbackDialog';
import { ScheduledCallbacksList } from './ScheduledCallbacksList';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import EmojiPicker, { EmojiClickData } from 'emoji-picker-react';
import { useUserProfile } from '../hooks/useUserProfile';
import { SnippetPicker } from './SnippetPicker';
import { SnippetManagerDialog } from './SnippetManagerDialog';

interface ChatViewProps {
  conversation: ConversationWithDetails;
  onConversationUpdate: () => void;
}

// statusIcons, normalizeStatus, getStatusIcon -> extracted to MessageBubble.tsx

export function ChatView({ conversation, onConversationUpdate }: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [isWithinWindow, setIsWithinWindow] = useState(true);
  const [hoursRemaining, setHoursRemaining] = useState<number | null>(null);
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [showNotesDialog, setShowNotesDialog] = useState(false);  // ✅ Estado para modal de anotações
  const [showScheduleCallback, setShowScheduleCallback] = useState(false); // 📅 Estado para modal de agendamento
  const [callbacksRefreshTrigger, setCallbacksRefreshTrigger] = useState(0); // 🔄 Trigger para atualizar lista de agendamentos
  const [availableAttendants, setAvailableAttendants] = useState<Profile[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [currentAssignedUser, setCurrentAssignedUser] = useState<Profile | null>(conversation.assigned_user || null);
  const [uploadingFile, setUploadingFile] = useState(false); // Estado para upload de arquivo
  const [selectedFile, setSelectedFile] = useState<File | null>(null); // Arquivo selecionado
  const [filePreview, setFilePreview] = useState<string | null>(null); // Preview do arquivo
  const [isRecordingAudio, setIsRecordingAudio] = useState(false); // 🎤 Estado para gravação de áudio
  const [showSnippetManager, setShowSnippetManager] = useState(false); // H1.5: gerenciar snippets
  const [showEmojiPicker, setShowEmojiPicker] = useState(false); // 😊 Estado para emoji picker
  const [showCloseConfirm, setShowCloseConfirm] = useState(false); // 🔒 Confirmação de fechamento
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); // Ref para input de arquivo
  const imageInputRef = useRef<HTMLInputElement>(null); // Ref para input de imagem
  const emojiPickerRef = useRef<HTMLDivElement>(null); // Ref para emoji picker
  
  // 🟢 Hook de presença em tempo real
  const { getUserStatus, getUserMode, onlineUsers } = usePresence();
  
  // 👤 Perfil do usuário logado (para controle de permissões)
  const { profile: userProfile, loading: profileLoading } = useUserProfile();
  const canAssign = userProfile.isLoaded && userProfile.isAdmin;
  
  // Versão do estado de presença para forçar re-render do Select
  const [presenceVersion, setPresenceVersion] = useState(0);

  // Atualizar versão quando onlineUsers mudar
  useEffect(() => {
    setPresenceVersion(v => v + 1);
  }, [onlineUsers]);

  useEffect(() => {
    // AbortController para cancelar requests stale ao trocar conversa
    const abortController = new AbortController();
    
    loadMessages(abortController.signal);
    checkWindow();
    loadAvailableAttendants();
    loadAvailableTags();
    setShowCloseConfirm(false);

    // 🔥 REALTIME: Escuta mudanças em mensagens desta conversa
    const channel = supabase
      .channel(`messages-${conversation.id}`)
      .on('postgres_changes',
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'messages',
          filter: `conversation_id=eq.${conversation.id}`
        },
        (payload) => {
          const newMessage = payload.new as Message;
          newMessage.status = normalizeStatus(newMessage.status);
          
          setMessages(prev => {
            // Evitar duplicatas
            if (prev.some(m => m.id === newMessage.id)) {
              return prev;
            }
            
            // Remover mensagem temporria otimista se for outbound
            if (newMessage.direction === 'outbound') {
              const filteredPrev = prev.filter(m => 
                !m.id.startsWith('temp-') || m.body !== newMessage.body
              );
              return [...filteredPrev, newMessage];
            }
            
            return [...prev, newMessage];
          });
          
          scrollToBottom();
          
          // Verificar janela novamente quando receber nova mensagem inbound
          if (newMessage.direction === 'inbound') {
            checkWindow();
          }
        }
      )
      .on('postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversation.id}`
        },
        (payload) => {
          const updatedMessage = payload.new as Message;
          // Normalizar status para garantir compatibilidade
          updatedMessage.status = normalizeStatus(updatedMessage.status);
          
          // Atualizar mensagem no estado
          setMessages(prev => 
            prev.map(m => m.id === updatedMessage.id ? { ...m, ...updatedMessage } : m)
          );
        }
      )
      .subscribe();

    // Polling fallback para status (5 min) - Realtime é o mecanismo primário
    const statusPollInterval = setInterval(async () => {
      try {
        const { data: freshMessages, error } = await supabase
          .from('messages')
          .select('id, status')
          .eq('conversation_id', conversation.id)
          .eq('direction', 'outbound')
          .in('status', ['sent', 'Sent', 'delivered', 'Delivered', 'deliver', 'Deliver', 'read', 'Read'])
          .order('sent_at', { ascending: false })
          .limit(10);

        if (error || !freshMessages) return;

        setMessages(prev => {
          let changed = false;
          const updated = prev.map(m => {
            const fresh = freshMessages.find(f => f.id === m.id);
            if (fresh) {
              const normalizedFreshStatus = normalizeStatus(fresh.status);
              if (m.status !== normalizedFreshStatus) {
                changed = true;
                return { ...m, status: normalizedFreshStatus };
              }
            }
            return m;
          });
          return changed ? updated : prev;
        });
      } catch {
        // Silencioso
      }
    }, 300000); // 5 min fallback (Realtime é primário)

    return () => {
      abortController.abort();
      supabase.removeChannel(channel);
      clearInterval(statusPollInterval);
    };
  }, [conversation.id]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 😊 Fechar emoji picker ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setShowEmojiPicker(false);
      }
    }
    
    if (showEmojiPicker) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showEmojiPicker]);

  async function loadMessages(signal?: AbortSignal) {
    if (!conversation?.id) {
      return;
    }



    try {
      // 🔄 Tentar via endpoint do servidor primeiro
      const endpoint = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/conversations/${conversation.id}/messages`;
      
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${publicAnonKey}`,
          'apikey': publicAnonKey,
        },
        signal,
      });

      const result = await response.json();
      
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Erro no endpoint');
      }
      // Normalizar status de todas as mensagens carregadas
      const normalized = (result.messages || []).map((m: Message) => ({
        ...m,
        status: normalizeStatus(m.status)
      }));
      setMessages(normalized);
      return;

    } catch (error: any) {
      // Se o request foi cancelado (troca de conversa), não tentar fallback
      if (error?.name === 'AbortError') {
        return;
      }
    }

    // 🛡️ FALLBACK: Buscar mensagens diretamente via Supabase client
    try {
      const { data: messages, error: dbError } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversation.id)
        .order('sent_at', { ascending: true });

      if (dbError) {
        return;
      }
      const normalized = (messages || []).map((m: Message) => ({
        ...m,
        status: normalizeStatus(m.status)
      }));
      setMessages(normalized);

    } catch (fallbackError) {
      // All message loading methods failed
    }
  }

  async function checkWindow() {
    const { data } = await supabase
      .from('messages')
      .select('sent_at')
      .eq('conversation_id', conversation.id)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      const lastInbound = new Date(data.sent_at);
      const now = new Date();
      const hoursDiff = (now.getTime() - lastInbound.getTime()) / (1000 * 60 * 60);

      setIsWithinWindow(hoursDiff < 24);
      setHoursRemaining(hoursDiff < 24 ? 24 - hoursDiff : null);
    } else {
      // 🔒 SEM MENSAGEM INBOUND = NÃO PODE ENVIAR MENSAGENS DE TEXTO
      // (Apenas templates podem ser enviados)
      setIsWithinWindow(false);
      setHoursRemaining(null);
    }
  }

  async function loadAvailableAttendants() {
    try {

      let query = supabase
        .from('profiles')
        .select(`
          *,
          cargo:cargos!profiles_id_cargo_fkey(id, papeis)
        `)
        .eq('ativo', true);

      // 🏢 Filtrar apenas atendentes da mesma unidade da conversa
      if (conversation.unit_id) {
        query = query.eq('id_unidade', conversation.unit_id);
      }

      const { data, error } = await query.order('nome');

      if (error) {
        return;
      }

      if (data) {
        setAvailableAttendants(data);
      } else {
        setAvailableAttendants([]);
      }
    } catch (error) {
      // Failed to load attendants
    }
  }

  async function loadAvailableTags() {
    const { data } = await supabase
      .from('tags')
      .select('*')
      .order('name');

    if (data) setAvailableTags(data);
  }

  function scrollToBottom() {
    setTimeout(() => {
      if (messagesEndRef.current) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
  }

  async function sendWhatsAppMessage(params: {
    conversationId: string;
    contactPhone: string;
    message: string;
  }): Promise<{ success: boolean; error?: string; messageId?: string }> {
    try {

      // Buscar token da sessão
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Sessão não encontrada');
      }

      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/whatsapp/send-message`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${publicAnonKey}`,
            'X-User-Token': session.access_token
          },
          body: JSON.stringify({
            to: params.contactPhone,
            message: params.message,
            conversationId: params.conversationId
          })
        }
      );

      const result = await response.json();

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Erro ao enviar mensagem'
        };
      }

      return {
        success: true,
        messageId: result.messageId
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      };
    }
  }

  // 😊 Handler para seleção de emoji
  function handleEmojiClick(emojiData: EmojiClickData) {
    setMessageText(prev => prev + emojiData.emoji);
    setShowEmojiPicker(false);
  }

  async function handleSendMessage() {
    if (!messageText.trim() || sending) return;

    setSending(true);

    try {
      const phoneNumber = conversation.contact?.phone_number || conversation.contact?.wa_id;

      if (!phoneNumber) {
        throw new Error('Telefone do contato não encontrado');
      }
      
      // 🚀 MENSAGEM OTIMISTA: Adicionar imediatamente no chat
      const optimisticMessage: Message = {
        id: `temp-${Date.now()}`,
        conversation_id: conversation.id,
        direction: 'outbound',
        type: 'text',
        body: messageText,
        status: 'sending',
        sent_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      
      setMessages(prev => [...prev, optimisticMessage]);
      const textToSend = messageText;
      setMessageText(''); // Limpar campo imediatamente
      
      // ✅ Enviar para backend (não esperar, processar em background)
      sendWhatsAppMessage({
        conversationId: conversation.id,
        contactPhone: phoneNumber,
        message: textToSend
      }).then(result => {
        if (!result.success) {
          // ❌ Se falhar, remover mensagem otimista e mostrar erro
          setMessages(prev => prev.filter(m => m.id !== optimisticMessage.id));
          alert(result.error || 'Erro ao enviar mensagem');
        }
        // ✅ Se sucesso, o Realtime já vai trazer a mensagem real do banco
      }).catch(error => {
        setMessages(prev => prev.filter(m => m.id !== optimisticMessage.id));
        alert('Erro ao enviar mensagem. Tente novamente.');
      });

      // 🔓 Liberar interface imediatamente (não esperar o backend)
      setSending(false);
      onConversationUpdate();
      
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Erro ao enviar mensagem. Tente novamente.');
      setSending(false);
    }
  }

  // 📎 Função para selecionar arquivo (imagem, documento ou áudio)
  function handleFileSelect(type: 'image' | 'document' | 'audio') {
    if (type === 'image') {
      imageInputRef.current?.click();
    } else if (type === 'audio') {
      // 🎤 Abrir gravador de áudio ao invés de file picker
      setIsRecordingAudio(true);
    } else {
      fileInputRef.current?.click();
    }
  }

  // 📤 Função para enviar arquivo (imagem, documento ou áudio)
  async function handleFileSend(file: File, type: 'image' | 'document' | 'audio') {
    if (!file || uploadingFile) return;

    setUploadingFile(true);
    setSelectedFile(file);

    try {
      const phoneNumber = conversation.contact?.phone_number || conversation.contact?.wa_id;

      if (!phoneNumber) {
        throw new Error('Telefone do contato não encontrado');
      }

      // Buscar token da sessão
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Sessão não encontrada');
      }

      // Criar FormData para enviar arquivo
      const formData = new FormData();
      formData.append('file', file);
      formData.append('to', phoneNumber);
      formData.append('conversationId', conversation.id);
      formData.append('type', type);
      formData.append('caption', messageText || ''); // Legenda opcional


      // Endpoint para envio de arquivos
      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/whatsapp/send-media`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${publicAnonKey}`,
            'X-User-Token': session.access_token
          },
          body: formData
        }
      );

      const result = await response.json();

      if (!result.success) {
        
        // Mostrar erro detalhado para o usuário
        const errorMessage = result.error || 'Erro ao enviar arquivo';
        const detailsMessage = result.details?.error?.message || '';
        const fullError = detailsMessage ? `${errorMessage}: ${detailsMessage}` : errorMessage;
        
        toast.error(fullError);
        return;
      }

      const typeLabel = type === 'image' ? 'Imagem' : type === 'audio' ? 'Áudio' : 'Documento';
      toast.success(`${typeLabel} enviado com sucesso!`);
      
      // Limpar estado
      setMessageText('');
      setSelectedFile(null);
      setFilePreview(null);
      
      // Atualizar conversa
      onConversationUpdate();

    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erro ao enviar arquivo');
    } finally {
      setUploadingFile(false);
    }
  }

  // 📷 Quando selecionar imagem
  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validar tipo de arquivo
    if (!file.type.startsWith('image/')) {
      toast.error('Por favor, selecione apenas arquivos de imagem');
      return;
    }

    // Validar tamanho (máximo 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error('A imagem deve ter no máximo 5MB');
      return;
    }

    // Criar preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setFilePreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    handleFileSend(file, 'image');
  }

  // 📄 Quando selecionar documento
  function handleDocumentChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validar tamanho (máximo 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.error('O documento deve ter no máximo 10MB');
      return;
    }

    handleFileSend(file, 'document');
  }

  // 🎤 Quando completar gravação de áudio
  async function handleAudioRecordingComplete(audioBlob: Blob) {

    // Fechar modal de gravação
    setIsRecordingAudio(false);

    // Validar tamanho (máximo 16MB conforme limite WhatsApp)
    if (audioBlob.size > 16 * 1024 * 1024) {
      toast.error('O áudio deve ter no máximo 16MB');
      return;
    }

    // Determinar extensão correta baseada no tipo MIME
    let extension = 'ogg';
    if (audioBlob.type.includes('webm')) {
      extension = 'webm';
    } else if (audioBlob.type.includes('ogg')) {
      extension = 'ogg';
    } else if (audioBlob.type.includes('mp4') || audioBlob.type.includes('m4a')) {
      extension = 'm4a';
    }

    // Converter Blob para File
    const audioFile = new File([audioBlob], `gravacao-${Date.now()}.${extension}`, {
      type: audioBlob.type
    });

    // Enviar arquivo
    handleFileSend(audioFile, 'audio');
  }

  async function handleAssign(userId: string) {
    try {

      // Se selecionar "unassigned", não fazer nada por enquanto
      if (userId === 'unassigned' || !userId) {
        toast.info('Desatribuição de conversas ainda não está disponível');
        return;
      }

      // Buscar token da sessão
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Você precisa estar logado para atribuir conversas');
        return;
      }

      const accessToken = session.access_token;
      
      // Chamar endpoint do backend
      const endpoint = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/conversations/${conversation.id}/assign`;
      
      
      // Mostrar feedback de loading
      toast.loading('Atribuindo conversa...', { id: 'assign-conversation' });
      
      const requestBody = {
        assigned_user_id: userId,
        reason: 'Atribuição manual via interface'
      };
      
      
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${publicAnonKey}`,
          'apikey': publicAnonKey,
          'X-User-Token': accessToken
        },
        body: JSON.stringify(requestBody)
      });


      const result = await response.json();
      
      
      if (!response.ok || !result.success) {
        toast.error(result.error || 'Erro ao atribuir conversa', { id: 'assign-conversation' });
        return;
      }


      // Buscar nome do atendente para mostrar no toast
      const attendant = availableAttendants.find(a => a.id === userId);
      const attendantName = [attendant?.nome, attendant?.sobrenome].filter(Boolean).join(' ') || attendant?.email || 'atendente';
      
      toast.success(`Conversa atribuída para ${attendantName}`, { id: 'assign-conversation' });

      // Atualizar lista de conversas
      onConversationUpdate();

      // Atualizar o usuário atribuído atualmente
      setCurrentAssignedUser(attendant || null);
    } catch (error) {
      toast.error('Erro ao atribuir conversa. Tente novamente.', { id: 'assign-conversation' });
    }
  }

  async function handleUnassign() {
    try {
      // Buscar token da sessão
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Você precisa estar logado para atribuir conversas');
        return;
      }

      const accessToken = session.access_token;
      
      // Chamar endpoint do backend
      const endpoint = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/conversations/${conversation.id}/assign`;
      
      
      // Mostrar feedback de loading
      toast.loading('Atribuindo conversa...', { id: 'assign-conversation' });
      
      const requestBody = {
        assigned_user_id: null,
        reason: 'Desatribuição manual via interface'
      };
      
      
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${publicAnonKey}`,
          'apikey': publicAnonKey,
          'X-User-Token': accessToken
        },
        body: JSON.stringify(requestBody)
      });


      const result = await response.json();
      
      
      if (!response.ok || !result.success) {
        toast.error(result.error || 'Erro ao atribuir conversa', { id: 'assign-conversation' });
        return;
      }


      // Buscar nome do atendente para mostrar no toast
      const attendant = availableAttendants.find(a => a.id === conversation.assigned_user_id);
      const attendantName = [attendant?.nome, attendant?.sobrenome].filter(Boolean).join(' ') || attendant?.email || 'atendente';
      
      toast.success(`Conversa atribuída para ${attendantName}`, { id: 'assign-conversation' });

      // Atualizar lista de conversas
      onConversationUpdate();

      // Atualizar o usuário atribuído atualmente
      setCurrentAssignedUser(attendant || null);
    } catch (error) {
      toast.error('Erro ao atribuir conversa. Tente novamente.', { id: 'assign-conversation' });
    }
  }

  async function handleCloseConversation() {
    try {
      setShowCloseConfirm(false);
      
      // Obter usuário logado
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        toast.error('Você precisa estar logado para fechar conversas');
        return;
      }

      const { error: updateError } = await supabase
        .from('conversations')
        .update({ 
          status: 'closed',
          closed_at: new Date().toISOString()
        })
        .eq('id', conversation.id);

      if (updateError) {
        toast.error('Erro ao fechar conversa: ' + updateError.message);
        return;
      }

      const { error: eventError } = await supabase
        .from('conversation_events')
        .insert({
          conversation_id: conversation.id,
          event_type: 'status_changed',
          actor_user_id: user.id,
          metadata: { new_status: 'closed', old_status: conversation.status }
        });

      if (eventError) {
        // Não bloquear a operação, apenas logar
      } else {
      }

      toast.success('Conversa fechada com sucesso');
      onConversationUpdate();
    } catch (error) {
      toast.error('Erro ao fechar conversa');
    }
  }

  async function handleAddTag(tagId: string) {
    try {
      // Obter usuário logado
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        toast.error('Você precisa estar logado para adicionar tags');
        return;
      }

      // Remover todas as tags existentes da conversa
      const { error: deleteError } = await supabase
        .from('conversation_tags')
        .delete()
        .eq('conversation_id', conversation.id);

      if (deleteError) {
        toast.error('Erro ao atualizar tag: ' + deleteError.message);
        return;
      }

      // Inserir a nova tag
      const { error: tagError } = await supabase
        .from('conversation_tags')
        .insert({
          conversation_id: conversation.id,
          tag_id: tagId
        });

      if (tagError) {
        toast.error('Erro ao adicionar tag: ' + tagError.message);
        return;
      }

      const { error: eventError } = await supabase
        .from('conversation_events')
        .insert({
          conversation_id: conversation.id,
          event_type: 'tagged',
          actor_user_id: user.id,
          metadata: { tag_id: tagId }
        });

      if (eventError) {
      } else {
      }

      toast.success('Tag atualizada com sucesso');
      onConversationUpdate();
    } catch (error) {
      toast.error('Erro ao atualizar tag');
    }
  }

  async function handleAddContactTag(tagId: string) {
    try {
      // Obter usuário logado
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        toast.error('Você precisa estar logado para adicionar tags ao contato');
        return;
      }

      // Verificar se a tag já existe no contato (maybeSingle retorna null sem erro)
      const { data: existingTag } = await supabase
        .from('contact_tags')
        .select('id')
        .eq('contact_id', conversation.contact_id)
        .eq('tag_id', tagId)
        .maybeSingle();

      if (existingTag) {
        toast.info('Esta tag já está atribuída ao contato');
        return;
      }

      const { error: tagError } = await supabase
        .from('contact_tags')
        .upsert(
          {
            contact_id: conversation.contact_id,
            tag_id: tagId,
            user_id: user.id
          },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
        );

      if (tagError) {
        toast.error('Erro ao adicionar tag ao contato: ' + tagError.message);
        return;
      }

      toast.success('Tag de ativação adicionada com sucesso');
      onConversationUpdate();
    } catch (error) {
      toast.error('Erro ao adicionar tag ao contato');
    }
  }

  // conversation.contact pode vir null quando o contato está em outra unidade
  // e o RLS bloqueia o JOIN — não pode quebrar a tela inteira por causa disso.
  const contactName = conversation.contact?.first_name && conversation.contact?.last_name
    ? `${conversation.contact.first_name} ${conversation.contact.last_name}`
    : conversation.contact?.display_name
      || conversation.contact?.phone_number
      || conversation.contact_name
      || 'Contato indisponível';

  const avatarInitial = conversation.contact?.first_name?.[0]?.toUpperCase() ||
                        conversation.contact?.phone_number?.[0] ||
                        conversation.contact_name?.[0]?.toUpperCase() || '?';

  // AudioPlayer, DocumentCard, renderMessageContent -> extracted to MessageBubble.tsx

  return (
    <div className="w-full h-full flex flex-col bg-white overflow-hidden">
      {/* Header */}
      <div className="w-full border-b border-[#E5E7EB] bg-white" style={{ flexShrink: 0, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
        {/* Row 1: Avatar + Nome + Ações rápidas */}
        <div className="flex items-center gap-3 px-4 md:px-5 py-3">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 shadow-sm" style={{ backgroundColor: '#0023D5' }}>
            {avatarInitial}
          </div>
          
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-[#1B1B1B] truncate leading-tight">
              {contactName}
            </h2>
            <p className="text-[12px] text-[#6B7280] truncate leading-tight mt-0.5">{conversation.contact?.phone_number}</p>
          </div>

          {/* Action buttons - Lado direito */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* Anotações — ação primária do atendente */}
            <button
              onClick={() => setShowNotesDialog(true)}
              className="group flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[#E5E7EB] bg-white text-[#4B5563] hover:border-[#0023D5] hover:bg-[#E6EAFF] hover:text-[#0023D5] active:scale-[0.97] transition-all duration-150"
            >
              <StickyNote className="w-3.5 h-3.5 group-hover:text-[#0023D5] transition-colors" />
              <span className="text-xs font-medium hidden sm:inline">Notas</span>
            </button>

            {/* Agendar Retorno — ação primária do atendente */}
            <button
              onClick={() => setShowScheduleCallback(true)}
              className="group flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[#E5E7EB] bg-white text-[#4B5563] hover:border-[#0023D5] hover:bg-[#E6EAFF] hover:text-[#0023D5] active:scale-[0.97] transition-all duration-150"
            >
              <Calendar className="w-3.5 h-3.5 group-hover:text-[#0023D5] transition-colors" />
              <span className="text-xs font-medium hidden sm:inline">Agendar</span>
            </button>

            {/* Encerrar conversa */}
            {conversation.status !== 'closed' && (
              <div className="relative">
                <button
                  onClick={() => setShowCloseConfirm(!showCloseConfirm)}
                  className={cn(
                    "group flex items-center gap-1.5 h-8 px-3 rounded-lg border transition-all duration-150 active:scale-[0.97]",
                    showCloseConfirm
                      ? "border-[#DC2626] bg-red-100 text-[#DC2626]"
                      : "border-[#FCA5A5] bg-red-50 text-[#EF4444] hover:border-[#DC2626] hover:bg-red-100 hover:text-[#DC2626]"
                  )}
                >
                  <XCircle className="w-3.5 h-3.5 transition-colors" />
                  <span className="text-xs font-medium hidden sm:inline">Encerrar</span>
                </button>

                {/* Popover de confirmação */}
                {showCloseConfirm && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowCloseConfirm(false)} />
                    <div
                      className="absolute right-0 top-full mt-2 z-50 bg-white rounded-xl border border-[#E5E7EB] shadow-xl w-72"
                      style={{ animation: 'fadeSlideIn 150ms ease-out' }}
                    >
                      {/* Barra vermelha decorativa no topo */}
                      <div className="h-1 w-full bg-gradient-to-r from-[#EF4444] to-[#F87171] rounded-t-xl" />

                      <div className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                            <XCircle className="w-5 h-5 text-[#EF4444]" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] font-semibold text-[#1B1B1B]">Encerrar conversa?</p>
                            <p className="text-[12px] text-[#6B7280] mt-1 leading-relaxed">
                              A conversa com <span className="font-medium text-[#4B5563]">{contactName}</span> será marcada como encerrada.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-4">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowCloseConfirm(false)}
                            className="flex-1 h-9 text-[13px] font-medium text-[#4B5563] hover:bg-[#F3F3F3] rounded-lg"
                          >
                            Cancelar
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleCloseConversation}
                            className="flex-1 h-9 text-[13px] font-medium bg-[#EF4444] hover:bg-[#DC2626] text-white rounded-lg shadow-sm"
                          >
                            <XCircle className="w-3.5 h-3.5 mr-1.5" />
                            Encerrar
                          </Button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Row 2: Metadata pills — agrupados e espaçados */}
        <div className="flex items-center gap-2 px-4 md:px-5 pb-3 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {/* ─── Grupo 1: Responsável ─── */}
          {canAssign ? (
            <Select
              value={conversation.assigned_user_id || 'unassigned'}
              onValueChange={(value) => {
                if (value === 'unassigned') {
                  handleUnassign();
                } else {
                  handleAssign(value);
                }
              }}
              key={`assign-${conversation.id}-${presenceVersion}`}
            >
              <SelectTrigger className="w-auto h-7 px-2.5 gap-1.5 bg-[#F9FAFB] border-[#E5E7EB] hover:border-[#0023D5] hover:bg-white rounded-lg flex-shrink-0 transition-all duration-150 shadow-none focus:ring-1 focus:ring-[#0023D5]/20">
                <SelectValue>
                  {currentAssignedUser ? (
                    <div className="flex items-center gap-1.5">
                      <PresenceIndicator status={getUserStatus(currentAssignedUser.id)} size="sm" />
                      <span className="text-xs font-medium text-[#1B1B1B] whitespace-nowrap">
                        {currentAssignedUser.nome || currentAssignedUser.email}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <UserCheck className="w-3.5 h-3.5 text-[#9CA3AF]" />
                      <span className="text-xs text-[#9CA3AF] whitespace-nowrap">Atribuir</span>
                    </div>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="min-w-[200px]">
                <div className="px-2 py-1.5 mb-1">
                  <p className="text-[10px] font-semibold text-[#9CA3AF] uppercase tracking-wider">
                    Responsável {conversation.unit?.name ? `(${conversation.unit.name})` : ''}
                  </p>
                </div>
                <SelectItem value="unassigned">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-[#F3F3F3] flex items-center justify-center">
                      <X className="w-3 h-3 text-[#9CA3AF]" />
                    </div>
                    <span className="text-[13px] text-[#6B7280]">Não atribuído</span>
                  </div>
                </SelectItem>
                {availableAttendants.length === 0 && (
                  <SelectItem value="no-attendants" disabled>
                    <span className="text-[13px] text-[#9CA3AF] italic">Nenhum atendente nesta unidade</span>
                  </SelectItem>
                )}
                {availableAttendants.map(attendant => {
                  const nomeCompleto = [attendant.nome, attendant.sobrenome].filter(Boolean).join(' ') || attendant.email || 'Sem nome';
                  const presenceStatus = getUserStatus(attendant.id);
                  const initials = (attendant.nome?.[0] || '') + (attendant.sobrenome?.[0] || '');
                  
                  return (
                    <SelectItem key={attendant.id} value={attendant.id}>
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <div className="w-5 h-5 rounded-full bg-[#E6EAFF] flex items-center justify-center">
                            <span className="text-[9px] font-bold text-[#0023D5]">{initials.toUpperCase() || '??'}</span>
                          </div>
                          <PresenceIndicator status={presenceStatus} size="sm" className="absolute -bottom-0.5 -right-0.5" />
                        </div>
                        <span className="text-[13px] font-medium text-[#1B1B1B]">{nomeCompleto}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          ) : (
            /* Badge read-only para atendentes normais */
            <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-[#F9FAFB] border border-[#E5E7EB] flex-shrink-0">
              {currentAssignedUser ? (
                <>
                  <PresenceIndicator status={getUserStatus(currentAssignedUser.id)} size="sm" />
                  <span className="text-xs font-medium text-[#4B5563] whitespace-nowrap">
                    {currentAssignedUser.nome || currentAssignedUser.email}
                  </span>
                </>
              ) : (
                <>
                  <UserIcon className="w-3.5 h-3.5 text-[#9CA3AF]" />
                  <span className="text-xs text-[#9CA3AF] whitespace-nowrap">Sem responsável</span>
                </>
              )}
            </div>
          )}

          {/* Separador visual */}
          <div className="w-px h-4 bg-[#E5E7EB] flex-shrink-0" />

          {/* ─── Grupo 2: Tag da conversa ─── */}
          <Select 
            value={conversation.tags && conversation.tags.length > 0 ? conversation.tags[conversation.tags.length - 1].id : 'no-tag'}
            onValueChange={handleAddTag}
          >
            <SelectTrigger className="w-auto h-7 px-2.5 gap-1.5 bg-[#F9FAFB] border-[#E5E7EB] hover:border-[#0023D5] hover:bg-white rounded-lg flex-shrink-0 transition-all duration-150 shadow-none focus:ring-1 focus:ring-[#0023D5]/20">
              <SelectValue>
                {conversation.tags && conversation.tags.length > 0 ? (() => {
                  const lastTag = conversation.tags![conversation.tags!.length - 1];
                  return (
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-white" style={{ backgroundColor: lastTag.color || '#0023D5' }} />
                      <span className="text-xs font-medium text-[#1B1B1B] whitespace-nowrap">{lastTag.name}</span>
                    </div>
                  );
                })() : (
                  <div className="flex items-center gap-1.5">
                    <TagIcon className="w-3.5 h-3.5 text-[#9CA3AF] flex-shrink-0" />
                    <span className="text-xs text-[#9CA3AF] whitespace-nowrap">Tag</span>
                  </div>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-[180px]">
              <div className="px-2 py-1.5 mb-1">
                <p className="text-[10px] font-semibold text-[#9CA3AF] uppercase tracking-wider">Tag da conversa</p>
              </div>
              {availableTags.map(tag => (
                <SelectItem key={tag.id} value={tag.id}>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full flex-shrink-0 border border-white shadow-sm" style={{ backgroundColor: tag.color || '#0023D5' }} />
                    <span className="text-[13px] font-medium">{tag.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* ─── Grupo 3: Unidade ─── */}
          {conversation.unit_id && (
            <>
              <div className="w-px h-4 bg-[#E5E7EB] flex-shrink-0" />
              <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg flex-shrink-0 bg-[#E6EAFF]/60 border border-[#E6EAFF]">
                <Building2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#0023D5' }} />
                <span className="text-xs font-medium whitespace-nowrap" style={{ color: '#0023D5' }}>
                  {conversation.unit?.name || 'Sem unidade'}
                </span>
              </div>
            </>
          )}

          {/* Separador visual */}
          <div className="w-px h-4 bg-[#E5E7EB] flex-shrink-0" />

          {/* ─── Grupo 4: Status da conversa (badge estático) ─── */}
          {conversation.status === 'closed' ? (
            <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-[#F3F4F6] border border-[#E5E7EB] flex-shrink-0">
              <Lock className="w-3.5 h-3.5 text-[#6B7280]" />
              <span className="text-xs font-medium text-[#6B7280] whitespace-nowrap">Encerrada</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-[#D1FAE5]/60 border border-[#A7F3D0] flex-shrink-0">
              <CircleDot className="w-3.5 h-3.5 text-[#10B981]" />
              <span className="text-xs font-medium text-[#065F46] whitespace-nowrap">Aberta</span>
            </div>
          )}
        </div>
      </div>

      {/* 📅 Lista de Agendamentos Ativos */}
      <div className="w-full" style={{ flexShrink: 0 }}>
        <ScheduledCallbacksList 
          conversationId={conversation.id} 
          refreshTrigger={callbacksRefreshTrigger}
        />
      </div>

      {/* Banner: conversa não atribuída a mim */}
      {userProfile.isLoaded && conversation.assigned_user_id !== userProfile.id && (
        <div className="w-full px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-3" style={{ flexShrink: 0 }}>
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <p className="text-xs text-amber-800">
              {conversation.assigned_user_id
                ? <><strong>Conversa atribuída a {currentAssignedUser?.nome || 'outro atendente'}</strong> — atribua a você para continuar o atendimento.</>
                : <><strong>Conversa sem atendente atribuído</strong> — atribua a você para iniciar o atendimento.</>
              }
            </p>
          </div>
          <button
            onClick={() => handleAssign(userProfile.id!)}
            className="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-[#0023D5] text-white rounded-lg hover:bg-[#001AAA] transition-colors"
          >
            Atribuir a mim
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 bg-[#F9FAFB] relative w-full" style={{ minHeight: 0, overflow: 'auto' }}>
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%230023D5' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
        }}></div>
        
        <div className="w-full h-full px-4 sm:px-6 py-4 sm:py-6 overflow-y-auto overflow-x-hidden">
          <div className="space-y-4 relative z-10 w-full max-w-full">
            {messages.map((message, index) => {
              const msgDate = new Date(message.sent_at).toDateString();
              const prevDate = index > 0 ? new Date(messages[index - 1].sent_at).toDateString() : null;
              const showDateSeparator = msgDate !== prevDate;

              return (
                <div key={message.id}>
                  {showDateSeparator && (
                    <div className="flex items-center justify-center my-4">
                      <span className="px-3 py-1 text-[11px] font-medium text-[#4B5563] bg-white rounded-lg shadow-sm border border-[#E5E7EB]">
                        {formatDateLabel(message.sent_at)}
                      </span>
                    </div>
                  )}
                  <MessageBubble message={message} />
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {/* Composer */}
      {(() => {
        const isNotAssignedToMe = userProfile.isLoaded && conversation.assigned_user_id !== userProfile.id;

        if (isNotAssignedToMe) {
          // Composer bloqueado — atendente precisa atribuir a conversa
          return (
            <div className="w-full border-t border-[#E5E7EB] bg-slate-50 overflow-hidden" style={{ flexShrink: 0 }}>
              <div className="flex items-center justify-center gap-3 px-6 py-5">
                <Lock className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <p className="text-sm text-slate-500">Atribua esta conversa a você para enviar mensagens</p>
                <button
                  onClick={() => handleAssign(userProfile.id!)}
                  className="flex-shrink-0 px-4 py-2 text-xs font-medium bg-[#0023D5] text-white rounded-lg hover:bg-[#001AAA] transition-colors"
                >
                  Atribuir a mim
                </button>
              </div>
            </div>
          );
        }

        return (
          // Sem overflow-hidden aqui: o SnippetPicker é absolute bottom-full
          // e precisa "escapar" pra cima do composer pra mostrar o cabeçalho.
          <div className="w-full border-t border-[#E5E7EB] bg-white" style={{ flexShrink: 0 }}>
            {!isWithinWindow && (
              <div className="mx-4 mt-3 px-4 py-3 rounded-lg border-l-[3px]" style={{ backgroundColor: '#FEF3C7', borderLeftColor: '#F59E0B' }}>
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" style={{ color: '#92400E' }} />
                  <p className="text-xs" style={{ color: '#92400E' }}>
                    <strong>Fora da janela de 24h.</strong> Envie um template aprovado.
                  </p>
                </div>
              </div>
            )}

            {isWithinWindow && hoursRemaining !== null && hoursRemaining < 2 && (
              <div className="mx-4 mt-3 px-4 py-3 rounded-lg border-l-[3px]" style={{ backgroundColor: '#FEF3C7', borderLeftColor: '#F59E0B' }}>
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 flex-shrink-0" style={{ color: '#92400E' }} />
                  <p className="text-xs" style={{ color: '#92400E' }}>
                    Janela expira em {Math.floor(hoursRemaining * 60)} minutos.
                  </p>
                </div>
              </div>
            )}

            {/* Barra de Ferramentas / Action Buttons */}
            <div className="w-full px-4 md:px-6 pt-3 pb-2 border-b border-[#F3F3F3]">
              <TooltipProvider delayDuration={200}>
                <div className="flex items-center gap-1 w-full overflow-x-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                  {/* Botão Emoji */}
                  <div className="relative" ref={emojiPickerRef}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 md:h-9 md:w-9 text-[#9CA3AF] hover:text-[#0023D5] hover:bg-[#E6EAFF] transition-all duration-150"
                        >
                          <Smile className="w-4 h-4 md:w-5 md:h-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="bg-[#1B1B1B] text-white border-[#1B1B1B] px-3 py-1.5 text-xs font-medium shadow-lg">
                        Emojis
                      </TooltipContent>
                    </Tooltip>

                    {/* Emoji Picker Popup */}
                    {showEmojiPicker && (
                      <div className="absolute bottom-full left-0 mb-2 z-50 shadow-xl rounded-lg">
                        <EmojiPicker
                          onEmojiClick={handleEmojiClick}
                          width={280}
                          height={350}
                          searchPlaceHolder="Buscar emoji..."
                          previewConfig={{ showPreview: false }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Botão Enviar Template */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => setShowTemplateSelector(true)}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 md:h-9 md:w-9 text-[#9CA3AF] hover:text-[#0023D5] hover:bg-[#E6EAFF] transition-all duration-150"
                      >
                        <FileText className="w-4 h-4 md:w-5 md:h-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="bg-[#1B1B1B] text-white border-[#1B1B1B] px-3 py-1.5 text-xs font-medium shadow-lg">
                      Modelos de mensagens
                    </TooltipContent>
                  </Tooltip>

                  {/* H1.5: Botão Snippets — abre manager (ou dica do "/" no composer) */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => setShowSnippetManager(true)}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 md:h-9 md:w-9 text-[#9CA3AF] hover:text-[#0023D5] hover:bg-[#E6EAFF] transition-all duration-150"
                      >
                        <Zap className="w-4 h-4 md:w-5 md:h-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="bg-[#1B1B1B] text-white border-[#1B1B1B] px-3 py-1.5 text-xs font-medium shadow-lg">
                      Snippets (digite "/" no campo)
                    </TooltipContent>
                  </Tooltip>

                  {/* Botão Enviar Imagem */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => handleFileSelect('image')}
                        variant="ghost"
                        size="icon"
                        disabled={uploadingFile}
                        className="h-8 w-8 md:h-9 md:w-9 text-[#9CA3AF] hover:text-[#0023D5] hover:bg-[#E6EAFF] transition-all duration-150 disabled:opacity-40"
                      >
                        <ImageIcon className="w-4 h-4 md:w-5 md:h-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="bg-[#1B1B1B] text-white border-[#1B1B1B] px-3 py-1.5 text-xs font-medium shadow-lg">
                      Enviar imagem
                    </TooltipContent>
                  </Tooltip>

                  {/* Botão Enviar Arquivo */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => handleFileSelect('document')}
                        variant="ghost"
                        size="icon"
                        disabled={uploadingFile}
                        className="h-8 w-8 md:h-9 md:w-9 text-[#9CA3AF] hover:text-[#0023D5] hover:bg-[#E6EAFF] transition-all duration-150 disabled:opacity-40"
                      >
                        <Paperclip className="w-4 h-4 md:w-5 md:h-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="bg-[#1B1B1B] text-white border-[#1B1B1B] px-3 py-1.5 text-xs font-medium shadow-lg">
                      Enviar arquivo
                    </TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            </div>

            {/* Campo de Mensagem */}
            <div className="w-full px-4 md:px-6 pb-4 pt-3 relative">
              {/* H1.5: Snippet Picker (slash-command) */}
              <SnippetPicker
                messageText={messageText}
                onPick={(finalBody) => setMessageText(finalBody)}
                contact={conversation.contact ? { display_name: conversation.contact.display_name, first_name: conversation.contact.first_name } : null}
                consultor={{ nome: userProfile.nome, sobrenome: userProfile.sobrenome }}
                unitName={userProfile.unitName}
              />
              <div className="flex gap-2 w-full items-end">
                <Textarea
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder={isWithinWindow ? "Digite sua mensagem... (use \"/\" para snippets)" : "Janela de 24h expirada"}
                  disabled={!isWithinWindow || sending}
                  className="resize-none bg-[#F3F3F3] border-[#E5E7EB] focus:border-[#0023D5] focus:ring-[#0023D5]/10 text-[14px] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-3xl flex-1 min-w-0 px-4 py-2.5"
                  rows={2}
                  onKeyDown={(e) => {
                    // SnippetPicker intercepta Enter/Tab/setas quando aberto (capture: true)
                    if (e.key === 'Enter' && !e.shiftKey && !messageText.startsWith('/')) {
                      e.preventDefault();
                      handleSendMessage();
                    } else if (e.key === 'Escape' && messageText.startsWith('/')) {
                      e.preventDefault();
                      setMessageText('');
                    }
                  }}
                />
                <Button
                  onClick={handleSendMessage}
                  disabled={!messageText.trim() || !isWithinWindow || sending}
                  size="icon"
                  className="rounded-full w-10 h-10 flex-shrink-0 disabled:opacity-50 transition-all duration-150"
                  style={{
                    backgroundColor: '#0023D5',
                    boxShadow: '0 2px 4px rgba(0,35,213,0.2)',
                  }}
                >
                  <Send className="w-4 h-4 md:w-5 md:h-5 text-white" />
                </Button>
              </div>
            </div>
          </div>
        );
      })()}

      {showTemplateSelector && (
        <TemplateSelector
          conversation={conversation}
          onClose={() => setShowTemplateSelector(false)}
          onTemplateSent={() => {
            setShowTemplateSelector(false);
            loadMessages();
            onConversationUpdate();
          }}
        />
      )}

      {/* H1.5: Manager de snippets (CRUD) */}
      <SnippetManagerDialog open={showSnippetManager} onOpenChange={setShowSnippetManager} />

      {showNotesDialog && (
        <NotesDialog
          open={showNotesDialog}
          onOpenChange={setShowNotesDialog}
          contactId={conversation.contact_id}
          contactName={contactName}
        />
      )}

      {/* 📅 Modal de Agendamento de Retorno */}
      {showScheduleCallback && (
        <ScheduleCallbackDialog
          conversationId={conversation.id}
          open={showScheduleCallback}
          onOpenChange={setShowScheduleCallback}
          onSuccess={() => {
            // Atualizar lista de agendamentos
            setCallbacksRefreshTrigger(prev => prev + 1);
          }}
        />
      )}

      {/* Inputs ocultos para seleção de arquivos */}
      <input
        type="file"
        ref={imageInputRef}
        accept="image/*"
        className="hidden"
        onChange={handleImageChange}
      />
      <input
        type="file"
        ref={fileInputRef}
        accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        className="hidden"
        onChange={handleDocumentChange}
      />

      {/* 🎤 Modal de gravação de áudio */}
      {isRecordingAudio && (
        <AudioRecorder
          onRecordingComplete={handleAudioRecordingComplete}
          onCancel={() => setIsRecordingAudio(false)}
        />
      )}
    </div>
  );
}