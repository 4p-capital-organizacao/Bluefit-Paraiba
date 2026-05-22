// Tipos do banco de dados baseados na estrutura descrita

export type ConversationStatus = 'open' | 'pending' | 'waiting_customer' | 'closed';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageType = 'text' | 'template' | 'image' | 'document' | 'audio' | 'video';

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'sending';

export interface Contact {
  id: string;
  wa_id: string;
  phone_number: string;
  display_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  unit_id?: string | null;
  situation?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  contact_id: string;
  unit_id: string | null;
  status: ConversationStatus;
  assigned_user_id: string | null;
  assigned_at: string | null;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  type: MessageType;
  body: string | null;
  media_url: string | null;
  provider_message_id: string | null;
  sent_at: string;
  status: MessageStatus;
  created_at: string;
}

export interface MessageStatusEvent {
  id: string;
  message_id: string;
  status: MessageStatus;
  timestamp: string;
  created_at: string;
}

export interface Profile {
  id: string;
  email: string | null;
  nome: string | null;
  sobrenome: string | null;
  cpf: string | null;
  telefone: string | null;
  id_cargo: number; // Cargo do usuário (numérico)
  id_unidade: number | null; // Unidade do usuário
  ativo: boolean;
  created_at: string;
  updated_at: string;
}

export interface Unit {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnitMembership {
  id: string;
  unit_id: string;
  user_id: string;
  created_at: string;
}

export interface ConversationAssignment {
  id: string;
  conversation_id: string;
  user_id: string;
  assigned_at: string;
  unassigned_at: string | null;
}

export interface ConversationEvent {
  id: string;
  conversation_id: string;
  event_type: 'created' | 'assigned' | 'status_changed' | 'note_added' | 'tagged' | 'untagged';
  actor_user_id: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export interface ContactTag {
  id: string;
  contact_id: string;
  tag_id: string;
  user_id: string | null;
  created_at: string;
}

export interface ConversationTag {
  id: string;
  conversation_id: string;
  tag_id: string;
  created_at: string;
}

// Tipos combinados para queries
export interface ConversationWithDetails extends Conversation {
  // Pode ser null: se o contato está em outra unidade, o RLS bloqueia o JOIN.
  contact: Contact | null;
  contact_name?: string; // 🔥 Nome do contato (para exibição rápida)
  assigned_user?: Profile | null;
  unit?: Unit | null;
  tags?: Tag[];
  pending_messages_count?: number; // 🔥 Contador de mensagens pendentes do cliente
  last_message_type?: string; // 🔥 Tipo da última mensagem (para ícones)
}

export interface MessageWithDetails extends Message {
  status_events?: MessageStatusEvent[];
}

// Template do WhatsApp (mockado)
export interface WhatsAppTemplate {
  template_name: string;
  language: string;
  category: string;
  status?: string; // APPROVED | PENDING | REJECTED | IN_APPEAL | DISABLED | PAUSED
  components?: Array<{
    type: string;
    format?: string;
    text?: string;
    buttons?: Array<{ type: string; text: string }>;
    parameters?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
}

// 🎯 CRM - Leads
export type LeadStatus =
  | 'novo'
  | 'contato_feito'
  | 'visita_agendada'
  | 'visita_realizada'
  | 'visita_cancelada'
  | 'matriculado'
  | 'base_fria'
  | 'perdido';

export interface Lead {
  id: string;
  created_at: string;
  data_cadastro?: string | null;
  nome_completo: string;
  telefone: string;
  email?: string | null;
  ja_treina?: string | null;
  objetivo_principal?: string | null;
  mora_ou_trabalha_perto?: string | null;
  quando_quer_comecar?: string | null;
  pontuacao?: number | null;
  classificacao?: string | null;
  situacao: LeadStatus;
  origem?: string | null;
  campanha?: string | null;
  midia?: string | null;
  utm_id?: string | null;
  data_primeiro_contato?: string | null;
  responsavel?: string | null;
  motivo_cancelamento?: string | null;
  unidade?: string | null;       // Nome da unidade (texto livre)
  id_unidade?: number | null;    // FK para units (bigint)
  id_contact?: string | null;   // FK bidirecional para contacts
}

export interface LeadWithDetails extends Lead {
  unit?: Unit | null;
  lastMessageDirection?: 'inbound' | 'outbound' | null;
  // 🔄 H2.2: timestamp se o lead voltou de base_fria pra contato_feito
  reactivated_at?: string | null;
  // 🔢 H2.2: quantos templates automáticos de follow-up já foram enviados
  followup_count?: number;
  // ✨ H2.2: indica se o lead foi reativado nos últimos 14 dias
  recently_reactivated?: boolean;
  // 🔥 H2.3: cliente respondeu APÓS o último envio de follow-up automático
  respondeu_apos_followup?: boolean;
  // 🔥 H2.3: timestamp do último inbound após o follow-up — usado p/ ordenação
  ultimo_inbound_apos_followup?: string | null;
}