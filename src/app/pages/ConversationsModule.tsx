import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ConversationWithDetails } from '@/app/types/database';
import { ConversationListV2 } from '@/app/components/ConversationListV2'; // 🚀 Nova versão com React Query
import { ChatView } from '@/app/components/ChatView';
import { CreateContactDialog } from '@/app/components/CreateContactDialog';
import { AssignmentQueueWidget } from '@/app/components/AssignmentQueueWidget';
import { MessageSquare, UserPlus, ArrowLeft } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { toast } from 'sonner';
import { supabase } from '@/app/lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export function ConversationsModule() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const { authUser } = useAuth();
  const accessToken = authUser?.accessToken || '';

  const [selectedConversation, setSelectedConversation] = useState<ConversationWithDetails | null>(null);
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [listRefreshTrigger, setListRefreshTrigger] = useState(0);

  // Deep link: carregar conversa a partir do URL param
  useEffect(() => {
    if (conversationId && (!selectedConversation || selectedConversation.id !== conversationId)) {
      loadConversationById(conversationId);
    } else if (!conversationId) {
      setSelectedConversation(null);
    }
  }, [conversationId]);

  async function loadConversationById(id: string) {
    try {
      console.log('🔗 Deep link: carregando conversa', id);

      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select(`
          *,
          contact:contacts(*),
          assigned_user:profiles(*),
          unit:units(*)
        `)
        .eq('id', id)
        .single();

      if (convError || !convData) {
        console.error('❌ Conversa não encontrada:', convError);
        toast.error('Conversa não encontrada');
        navigate('/conversations', { replace: true });
        return;
      }

      // Carregar tags
      const { data: tagsData } = await supabase
        .from('conversation_tags')
        .select('tag:tags(*)')
        .eq('conversation_id', id);

      const tags = tagsData?.map((ct: any) => ct.tag).filter(Boolean) || [];

      // Carregar mensagens pendentes (inbound consecutivas desde última outbound)
      const { data: recentMessages } = await supabase
        .from('messages')
        .select('direction')
        .eq('conversation_id', id)
        .order('sent_at', { ascending: false })
        .limit(20);

      let pendingCount = 0;
      if (recentMessages) {
        for (const msg of recentMessages) {
          if (msg.direction === 'inbound') pendingCount++;
          else if (msg.direction === 'outbound') break;
        }
      }

      const conversation: ConversationWithDetails = {
        ...convData,
        tags,
        pending_messages_count: pendingCount,
      };

      setSelectedConversation(conversation);
      console.log('✅ Deep link: conversa carregada:', conversation.contact_name);
    } catch (error) {
      console.error('❌ Erro ao carregar conversa por deep link:', error);
      navigate('/conversations', { replace: true });
    }
  }

  function handleSelectConversation(conversation: ConversationWithDetails) {
    // Navegar para URL com ID (deep link)
    navigate(`/conversations/${conversation.id}`);
    setSelectedConversation(conversation);
  }

  function handleBackToList() {
    navigate('/conversations');
    setSelectedConversation(null);
  }

  async function handleConversationUpdate() {
    // Forçar refresh na ConversationList
    setListRefreshTrigger(prev => prev + 1);

    // Recarregar a conversa selecionada com dados atualizados
    if (!selectedConversation) return;

    try {
      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select(`
          *,
          contact:contacts(*),
          assigned_user:profiles(*),
          unit:units(*)
        `)
        .eq('id', selectedConversation.id)
        .single();

      if (convError || !convData) {
        console.error('❌ Erro ao recarregar conversa:', convError);
        return;
      }

      const { data: tagsData } = await supabase
        .from('conversation_tags')
        .select('tag:tags(*)')
        .eq('conversation_id', selectedConversation.id);

      const tags = tagsData?.map((ct: any) => ct.tag).filter(Boolean) || [];

      // Carregar mensagens pendentes (inbound consecutivas desde última outbound)
      const { data: recentMessages } = await supabase
        .from('messages')
        .select('direction')
        .eq('conversation_id', selectedConversation.id)
        .order('sent_at', { ascending: false })
        .limit(20);

      let pendingCount = 0;
      if (recentMessages) {
        for (const msg of recentMessages) {
          if (msg.direction === 'inbound') pendingCount++;
          else if (msg.direction === 'outbound') break;
        }
      }

      const updatedConversation: ConversationWithDetails = {
        ...convData,
        tags,
        pending_messages_count: pendingCount,
      };

      console.log('🔄 Conversa selecionada recarregada com', tags.length, 'tags');
      setSelectedConversation(updatedConversation);
    } catch (error) {
      console.error('❌ Erro ao recarregar conversa selecionada:', error);
    }
  }

  function handleContactCreated() {
    console.log('Contato criado com sucesso!');
    toast.success('Contato criado com sucesso!', {
      description: 'O novo contato foi adicionado ao sistema.',
      duration: 4000,
    });
  }

  return (
    <div className="w-full h-full flex overflow-hidden">
      {/* Sidebar - Lista de Conversas */}
      <div className={`
        w-full md:w-[340px] bg-white border-r border-[#E5E7EB] flex flex-col flex-shrink-0 overflow-hidden min-h-0
        ${selectedConversation ? 'hidden md:flex' : 'flex'}
      `}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#E5E7EB] bg-[#0023D5] flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Conversas</h2>
              <p className="text-xs text-white/70">WhatsApp Business</p>
            </div>
            <Button
              onClick={() => setCreateContactOpen(true)}
              size="sm"
              className="bg-white/10 hover:bg-white/20 text-white border border-white/20 text-xs h-8 rounded-lg transition-all duration-150"
            >
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              <span className="hidden sm:inline">Novo</span>
              <span className="sm:hidden">+</span>
            </Button>
          </div>
        </div>
        
        {/* H1.2: Pegar próxima conversa da fila da unidade */}
        <AssignmentQueueWidget
          onClaimed={handleSelectConversation}
          onAfterClaim={() => setListRefreshTrigger(prev => prev + 1)}
        />

        <ConversationListV2
          onSelectConversation={handleSelectConversation}
          selectedConversationId={selectedConversation?.id}
          refreshTrigger={listRefreshTrigger}
        />
      </div>

      {/* Main Chat Area */}
      <div className={`
        flex-1 bg-[#F9FAFB]
        ${selectedConversation ? 'flex' : 'hidden md:flex'}
      `}>
        {selectedConversation ? (
          <div className="w-full h-full flex flex-col">
            {/* Mobile Back Button */}
            <div className="md:hidden bg-white border-b border-[#E5E7EB] p-3 flex items-center gap-3 flex-shrink-0 w-full">
              <button
                onClick={handleBackToList}
                className="p-2 hover:bg-[#F3F3F3] rounded-lg transition-colors duration-150 flex-shrink-0"
              >
                <ArrowLeft className="w-5 h-5 text-[#4B5563]" />
              </button>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-[#1B1B1B] truncate text-[15px]">
                  {selectedConversation.contact_name}
                </h3>
              </div>
            </div>

            {/* ChatView */}
            <div className="flex-1 overflow-hidden">
              <ChatView 
                conversation={selectedConversation} 
                onConversationUpdate={handleConversationUpdate}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center max-w-md">
              <div className="relative mb-6">
                <div className="relative bg-[#0023D5] p-6 rounded-2xl inline-block" style={{ boxShadow: '0 8px 32px rgba(0,35,213,0.2)' }}>
                  <MessageSquare className="w-12 h-12 md:w-16 md:h-16 text-white" strokeWidth={1.5} />
                </div>
              </div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#1B1B1B] mb-3">Módulo de Conversas</h2>
              <p className="text-sm md:text-base text-[#6B7280] leading-relaxed">
                Selecione uma conversa da lista ao lado para iniciar o atendimento profissional
              </p>
              <div className="mt-8 flex items-center justify-center gap-2 text-sm text-[#9CA3AF]">
                <div className="w-2 h-2 bg-[#10B981] rounded-full animate-pulse"></div>
                <span>Sistema online e pronto</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Dialog de Criar Contato */}
      <CreateContactDialog
        open={createContactOpen}
        onOpenChange={setCreateContactOpen}
        onSuccess={handleContactCreated}
        accessToken={accessToken}
      />
    </div>
  );
}