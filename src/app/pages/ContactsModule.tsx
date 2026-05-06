import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Search, UserPlus, Phone, MapPin, Edit, Trash2, MessageCircle } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Card } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog';
import { CreateContactDialog } from '@/app/components/CreateContactDialog';
import { EditContactDialog } from '@/app/components/EditContactDialog';
import { DeleteContactDialog } from '@/app/components/DeleteContactDialog';
import { supabase } from '@/app/lib/supabase';
import { toast } from 'sonner';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { useUserProfile } from '@/app/hooks/useUserProfile';
import { useContacts, type Contact } from '@/app/hooks/useContacts';
import { useUnits } from '@/app/hooks/useUnits';
import { useDebouncedValue } from '@/app/hooks/useDebouncedValue';
import { useAuth } from '../contexts/AuthContext';

export function ContactsModule() {
  const { contactId } = useParams<{ contactId?: string }>();
  const navigate = useNavigate();
  const { authUser } = useAuth();
  const accessToken = authUser?.accessToken || '';

  // 🚀 Cache via React Query (substitui useState/useEffect/loadContacts/realtime)
  const { contacts, isLoading: loading, refetch: refetchContacts } = useContacts();
  const { units } = useUnits();

  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearchTerm = useDebouncedValue(searchTerm, 300);
  const [unitFilter, setUnitFilter] = useState<string>('all');
  const [situationFilter, setSituationFilter] = useState<string>('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [startingConversation, setStartingConversation] = useState(false);

  // 🔐 Permissões baseadas no cargo
  const { profile: userProfile } = useUserProfile();
  const canDelete = userProfile.isLoaded && userProfile.isAdmin;
  const canEditUnit = userProfile.isLoaded && userProfile.isAdmin;

  // 🔗 Deep link: abrir edição de contato via URL
  useEffect(() => {
    if (contactId && contacts.length > 0) {
      const contact = contacts.find(c => String(c.id) === String(contactId));
      if (contact) {
        setSelectedContact(contact);
        setShowEditDialog(true);
      } else {
        toast.error('Contato não encontrado');
        navigate('/contacts', { replace: true });
      }
    }
  }, [contactId, contacts, navigate]);

  // Filtro client-side memoizado (search debounced p/ não rodar a cada tecla)
  const filteredContacts = useMemo(() => {
    let result = contacts;

    if (debouncedSearchTerm) {
      const search = debouncedSearchTerm.toLowerCase();
      result = result.filter(contact =>
        contact.display_name?.toLowerCase().includes(search) ||
        contact.first_name?.toLowerCase().includes(search) ||
        contact.last_name?.toLowerCase().includes(search) ||
        contact.phone_number?.includes(search) ||
        contact.wa_id?.includes(search)
      );
    }

    if (unitFilter !== 'all') {
      result = result.filter(contact => String(contact.unit_id) === String(unitFilter));
    }

    if (situationFilter !== 'all') {
      result = result.filter(contact => contact.situation === situationFilter);
    }

    return result;
  }, [contacts, debouncedSearchTerm, unitFilter, situationFilter]);

  function getSituationBadgeColor(situation: string) {
    const colorMap: Record<string, string> = {
      ativo: 'bg-[#10B981] text-white',
      inativo: 'bg-[#9CA3AF] text-white',
      lead: 'bg-[#0023D5] text-white',
      prospecto: 'bg-[#E6EAFF] text-[#0023D5]',
      cliente: 'bg-[#D1FAE5] text-[#065F46]'
    };
    return colorMap[situation] || 'bg-[#9CA3AF] text-white';
  }

  function getSituationLabel(situation: string) {
    const labels: Record<string, string> = {
      ativo: '✅ Ativo',
      inativo: '⏸️ Inativo',
      lead: '🎯 Lead',
      prospecto: '🔍 Prospecto',
      cliente: '💎 Cliente'
    };
    return labels[situation] || situation;
  }

  function formatPhoneDisplay(phone: string): string {
    const numbers = phone.replace(/\D/g, '');
    if (numbers.length === 13) {
      return `+${numbers.slice(0, 2)} (${numbers.slice(2, 4)}) ${numbers.slice(4, 9)}-${numbers.slice(9)}`;
    } else if (numbers.length === 12) {
      return `+${numbers.slice(0, 2)} (${numbers.slice(2, 4)}) ${numbers.slice(4, 8)}-${numbers.slice(8)}`;
    }
    return phone;
  }

  function getUnitName(unitId: string) {
    const unit = units.find(u => String(u.id) === String(unitId));
    return unit?.name || 'N/A';
  }

  function handleEditContact(contact: Contact) {
    setSelectedContact(contact);
    setShowEditDialog(true);
    // Atualizar URL com deep link
    navigate(`/contacts/${contact.id}`, { replace: true });
  }

  function handleCloseEditDialog(open: boolean) {
    setShowEditDialog(open);
    if (!open) {
      // Voltar para /contacts ao fechar
      navigate('/contacts', { replace: true });
    }
  }

  function handleDeleteContact(contact: Contact) {
    setSelectedContact(contact);
    setShowDeleteDialog(true);
  }

  async function handleStartConversation(contact: Contact) {
    setStartingConversation(true);

    try {
      const { data: existingConversations, error: searchError } = await supabase
        .from('conversations')
        .select('*')
        .eq('contact_id', contact.id)
        .limit(1);

      if (searchError) {
        toast.error('Erro ao verificar conversa existente');
        setStartingConversation(false);
        return;
      }

      if (existingConversations && existingConversations.length > 0) {
        toast.success('Redirecionando para a conversa...');
        setStartingConversation(false);
        // Navegar com deep link para a conversa existente
        navigate(`/conversations/${existingConversations[0].id}`);
        return;
      }

      setSelectedContact(contact);
      setShowTemplateDialog(true);
      setStartingConversation(false);

    } catch (error) {
      toast.error('Erro ao verificar conversa');
      setStartingConversation(false);
    }
  }

  async function createConversation() {
    if (!selectedContact) return;

    setStartingConversation(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        toast.error('Você precisa estar logado');
        setStartingConversation(false);
        return;
      }

      const endpoint = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/conversations/create`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${publicAnonKey}`,
          'apikey': publicAnonKey,
        },
        body: JSON.stringify({
          contact_id: selectedContact.id,
          assigned_user_id: session.user.id,
          token: accessToken
        })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        toast.error(data.error || 'Erro ao criar conversa');
        setStartingConversation(false);
        return;
      }

      toast.success('Conversa criada! Redirecionando...');

      setShowTemplateDialog(false);
      setSelectedContact(null);
      setStartingConversation(false);

      // Navegar para a nova conversa
      if (data.conversation?.id) {
        navigate(`/conversations/${data.conversation.id}`);
      } else {
        navigate('/conversations');
      }

    } catch (error) {
      toast.error('Erro ao criar conversa');
      setStartingConversation(false);
    }
  }

  return (
    <div className="h-full flex flex-col bg-[#F9FAFB]">
      {/* Header */}
      <div className="bg-white border-b border-[#E5E7EB] px-4 md:px-6 py-3 md:py-4" style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-0">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold text-[#1B1B1B]">Contatos</h1>
            <p className="text-xs md:text-sm text-[#6B7280] mt-0.5 md:mt-1">
              Gerencie seus contatos do WhatsApp
            </p>
          </div>
          <Button
            onClick={() => setShowCreateDialog(true)}
            className="w-full md:w-auto text-white font-medium rounded-lg transition-all duration-150"
            size="sm"
            style={{ backgroundColor: '#0023D5', boxShadow: '0 2px 4px rgba(0,35,213,0.15)' }}
          >
            <UserPlus className="w-4 h-4 mr-2" />
            Novo Contato
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-col md:flex-row gap-2 md:gap-3 mt-3 md:mt-4">
          <div className="flex-1 relative group">
            <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-[#9CA3AF] w-4 h-4 transition-colors duration-150 group-focus-within:text-[#0023D5]" />
            <Input
              type="text"
              placeholder="Buscar por nome, telefone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 h-9 md:h-10 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
            />
          </div>

          <Select value={unitFilter} onValueChange={setUnitFilter}>
            <SelectTrigger className="w-full md:w-48 h-9 md:h-10 bg-[#F3F3F3] border-[#E5E7EB] rounded-md text-[#1B1B1B] hover:border-[#0023D5] transition-colors duration-150">
              <SelectValue placeholder="Unidade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as unidades</SelectItem>
              {units.map(unit => (
                <SelectItem key={String(unit.id)} value={String(unit.id)}>
                  {unit.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={situationFilter} onValueChange={setSituationFilter}>
            <SelectTrigger className="w-full md:w-48 h-9 md:h-10 bg-[#F3F3F3] border-[#E5E7EB] rounded-md text-[#1B1B1B] hover:border-[#0023D5] transition-colors duration-150">
              <SelectValue placeholder="Situação" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as situações</SelectItem>
              <SelectItem value="ativo">Ativo</SelectItem>
              <SelectItem value="inativo">Inativo</SelectItem>
              <SelectItem value="lead">Lead</SelectItem>
              <SelectItem value="prospecto">Prospecto</SelectItem>
              <SelectItem value="cliente">Cliente</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 md:p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-[#9CA3AF]">Carregando contatos...</div>
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <UserPlus className="w-12 h-12 text-[#9CA3AF] mb-3" />
            <p className="text-[#4B5563] text-lg font-medium">Nenhum contato encontrado</p>
            <p className="text-[#9CA3AF] text-sm text-center px-4">
              {searchTerm || unitFilter !== 'all' || situationFilter !== 'all'
                ? 'Tente ajustar os filtros'
                : 'Clique em "Novo Contato" para criar seu primeiro contato'}
            </p>
          </div>
        ) : (
          <>
            {/* Mobile View - Cards */}
            <div className="md:hidden space-y-3">
              {filteredContacts.map((contact) => {
                const initials = contact.first_name?.[0]?.toUpperCase() || contact.display_name?.[0]?.toUpperCase() || '?';

                const displayPrimaryName = contact.first_name
                  ? contact.last_name
                    ? `${contact.first_name} ${contact.last_name}`
                    : contact.first_name
                  : contact.display_name;

                const showSecondaryName = contact.display_name &&
                  contact.display_name !== displayPrimaryName &&
                  contact.first_name;

                return (
                  <Card key={contact.id} className="p-4 bg-white border-[#E5E7EB] hover:shadow-md transition-all duration-150">
                    <div className="flex items-start gap-3 mb-3">
                      <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-base flex-shrink-0" style={{ backgroundColor: '#0023D5' }}>
                        {initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[#1B1B1B] truncate text-base">
                          {displayPrimaryName}
                        </div>
                        {showSecondaryName && (
                          <div className="text-xs text-[#9CA3AF] truncate">
                            {contact.display_name}
                          </div>
                        )}
                        <Badge className={`${getSituationBadgeColor(contact.situation)} text-xs font-medium mt-1`}>
                          {getSituationLabel(contact.situation)}
                        </Badge>
                      </div>
                    </div>

                    <div className="space-y-2 mb-3">
                      <div className="flex items-center gap-2 text-sm text-[#4B5563]">
                        <Phone className="w-4 h-4 text-[#0023D5] flex-shrink-0" />
                        <span className="font-mono truncate">{formatPhoneDisplay(contact.phone_number)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-[#4B5563]">
                        <MapPin className="w-4 h-4 text-[#0023D5] flex-shrink-0" />
                        <span className="truncate">{getUnitName(contact.unit_id)}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-9 border-[#E5E7EB] text-[#4B5563] hover:bg-[#F3F3F3] hover:text-[#1B1B1B] transition-colors duration-150"
                        onClick={() => handleEditContact(contact)}
                      >
                        <Edit className="w-3.5 h-3.5 md:mr-1" />
                        <span className="hidden sm:inline">Editar</span>
                      </Button>
                      {canDelete && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-[#EF4444] hover:text-[#EF4444] hover:bg-red-50 border-[#E5E7EB] h-9 text-xs transition-colors duration-150"
                          onClick={() => handleDeleteContact(contact)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="text-xs h-9 text-white transition-all duration-150"
                        style={{ backgroundColor: '#0023D5' }}
                        onClick={() => handleStartConversation(contact)}
                        disabled={startingConversation}
                      >
                        <MessageCircle className="w-3.5 h-3.5 md:mr-1" />
                        <span className="hidden sm:inline">Chat</span>
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Desktop View - Table */}
            <div className="hidden md:block bg-white rounded-lg border border-[#E5E7EB] overflow-hidden" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
              <div className="grid grid-cols-[60px_1fr_200px_180px_140px_200px] gap-4 px-6 py-3 bg-[#F9FAFB] border-b border-[#E5E7EB] font-semibold text-sm text-[#4B5563]">
                <div></div>
                <div>Nome</div>
                <div>Telefone</div>
                <div>Unidade</div>
                <div>Situação</div>
                <div className="text-right">Ações</div>
              </div>

              <div className="divide-y divide-[#F3F3F3]">
                {filteredContacts.map((contact) => {
                  const initials = contact.first_name?.[0]?.toUpperCase() || contact.display_name?.[0]?.toUpperCase() || '?';

                  const displayPrimaryName = contact.first_name
                    ? contact.last_name
                      ? `${contact.first_name} ${contact.last_name}`
                      : contact.first_name
                    : contact.display_name;

                  const showSecondaryName = contact.display_name &&
                    contact.display_name !== displayPrimaryName &&
                    contact.first_name;

                  return (
                    <div
                      key={contact.id}
                      className="grid grid-cols-[60px_1fr_200px_180px_140px_200px] gap-4 px-6 py-4 hover:bg-[#F9FAFB] transition-colors duration-150 items-center"
                    >
                      <div className="flex items-center justify-center">
                        <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm" style={{ backgroundColor: '#0023D5' }}>
                          {initials}
                        </div>
                      </div>

                      <div className="min-w-0">
                        <div className="font-semibold text-[#1B1B1B] truncate">
                          {displayPrimaryName}
                        </div>
                        {showSecondaryName && (
                          <div className="text-xs text-[#9CA3AF] truncate">
                            {contact.display_name}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 text-sm text-[#4B5563] font-mono">
                        <Phone className="w-3.5 h-3.5 text-[#0023D5] flex-shrink-0" />
                        <span className="truncate">{formatPhoneDisplay(contact.phone_number)}</span>
                      </div>

                      <div className="flex items-center gap-2 text-sm text-[#4B5563]">
                        <MapPin className="w-3.5 h-3.5 text-[#0023D5] flex-shrink-0" />
                        <span className="truncate">{getUnitName(contact.unit_id)}</span>
                      </div>

                      <div>
                        <Badge className={`${getSituationBadgeColor(contact.situation)} text-xs font-medium`}>
                          {getSituationLabel(contact.situation)}
                        </Badge>
                      </div>

                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-8 px-3 border-[#E5E7EB] text-[#4B5563] hover:bg-[#F3F3F3] hover:text-[#1B1B1B] transition-colors duration-150"
                          onClick={() => handleEditContact(contact)}
                          title="Editar contato"
                        >
                          <Edit className="w-3.5 h-3.5 mr-1" />
                          Editar
                        </Button>
                        {canDelete && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-[#EF4444] hover:text-[#EF4444] hover:bg-red-50 border-[#E5E7EB] h-8 px-3 transition-colors duration-150"
                            onClick={() => handleDeleteContact(contact)}
                            title="Excluir contato"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="text-xs h-8 px-3 text-white transition-all duration-150"
                          style={{ backgroundColor: '#0023D5' }}
                          onClick={() => handleStartConversation(contact)}
                          disabled={startingConversation}
                        >
                          <MessageCircle className="w-3.5 h-3.5 mr-1" />
                          Conversa
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Stats Footer */}
      <div className="bg-white border-t border-[#E5E7EB] px-4 md:px-6 py-2 md:py-3">
        <div className="flex items-center justify-between text-xs md:text-sm">
          <span className="text-[#6B7280]">
            Total: <strong className="text-[#1B1B1B]">{filteredContacts.length}</strong> contato(s)
            {(searchTerm || unitFilter !== 'all' || situationFilter !== 'all') && (
              <span className="text-[#9CA3AF] ml-2 hidden sm:inline">
                (de {contacts.length} no total)
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Create Contact Dialog */}
      <CreateContactDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onSuccess={() => {
          setShowCreateDialog(false);
          refetchContacts();
        }}
        accessToken={accessToken}
      />

      {/* Edit Contact Dialog */}
      <EditContactDialog
        open={showEditDialog}
        onOpenChange={handleCloseEditDialog}
        contact={selectedContact}
        canEditUnit={canEditUnit}
        onSuccess={() => {
          setShowEditDialog(false);
          navigate('/contacts', { replace: true });
          refetchContacts();
        }}
      />

      {/* Delete Contact Dialog */}
      {selectedContact && showDeleteDialog && (
        <DeleteContactDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          contact={selectedContact}
          onSuccess={() => {
            setShowDeleteDialog(false);
            setSelectedContact(null);
            refetchContacts();
          }}
        />
      )}

      {/* Template Dialog */}
      <AlertDialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Primeiro contato com o cliente</AlertDialogTitle>
            <AlertDialogDescription>
              Para iniciar o primeiro contato com <strong>{selectedContact?.display_name}</strong>, você precisa enviar um template aprovado pelo WhatsApp.
              <br /><br />
              Deseja criar a conversa agora? Você será redirecionado para a tela de conversas onde poderá enviar um template.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setShowTemplateDialog(false);
              setSelectedContact(null);
            }}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={createConversation}
              disabled={startingConversation}
              style={{ backgroundColor: '#0023D5' }}
            >
              {startingConversation ? 'Criando...' : 'Criar Conversa'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}