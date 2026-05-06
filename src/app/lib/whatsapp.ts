import { WhatsAppTemplate } from '../types/database';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { supabase } from './supabase';

const SERVER_URL = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1`;

export interface SendMessageParams {
  conversationId: string;
  contactPhone: string;
  message: string;
}

export interface SendTemplateParams {
  conversationId: string;
  contactPhone: string;
  templateName: string;
  languageCode: string;
  components?: any[];
}

/**
 * Envia uma mensagem livre via WhatsApp (Backend)
 */
export async function sendWhatsAppMessage(params: SendMessageParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    
    if (!token) {
      return { success: false, error: 'Sessão não autenticada' };
    }

    const response = await fetch(`${SERVER_URL}/api/whatsapp/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${publicAnonKey}`,
        'X-User-Token': token
      },
      body: JSON.stringify({
        conversationId: params.conversationId,
        to: params.contactPhone,
        message: params.message
      })
    });

    const data = await response.json();
    
    return data;
  } catch (error) {
    return { success: false, error: 'Erro de conexão' };
  }
}

/**
 * Envia um template via WhatsApp (APENAS via backend - sem fallback)
 */
export async function sendWhatsAppTemplate(
  conversationId: string,
  to: string,
  templateName: string,
  languageCode: string,
  components?: any[]
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    // Pegar sessão atual direto
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();

    let token: string | undefined;

    if (sessionError || !session?.access_token) {
      // Tentar refresh como última tentativa
      const { data: { session: refreshedSession } } = await supabase.auth.refreshSession();

      if (!refreshedSession?.access_token) {
        return {
          success: false,
          error: 'Sessão expirada. Por favor, faça logout e login novamente para continuar.'
        };
      }

      token = refreshedSession.access_token;
    } else {
      token = session.access_token;
    }

    if (!token) {
      return {
        success: false,
        error: 'Não foi possível obter token de autenticação. Faça logout e login novamente.'
      };
    }

    const response = await fetch(`${SERVER_URL}/api/whatsapp/send-template`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ✅ Supabase Edge Functions requer ANON_KEY no Authorization
        'Authorization': `Bearer ${publicAnonKey}`,
        // ✅ JWT do usuário vai em header customizado
        'X-User-Token': token
      },
      body: JSON.stringify({
        conversationId,
        to,
        templateName,
        languageCode,
        parameters: components // ✅ Renomeado de 'components' para 'parameters' (match com backend)
      })
    });

    // Tentar parsear resposta como JSON
    let data;
    try {
      data = await response.json();
    } catch (e) {
      return { success: false, error: 'Erro ao processar resposta do servidor' };
    }

    if (!response.ok) {
      // Se erro 401, a sessão realmente expirou
      if (response.status === 401) {
        return {
          success: false,
          error: 'Sua sessão expirou. Por favor, clique em "Sair" no menu superior e faça login novamente.'
        };
      }

      return {
        success: false,
        error: data.error || data.message || `Erro HTTP ${response.status}`
      };
    }

    if (!data.success) {
      return { success: false, error: data.error || 'Erro ao enviar template' };
    }

    return data;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro de conexão com o servidor'
    };
  }
}

/**
 * Busca templates disponíveis (VIA BACKEND - ENDPOINT PÚBLICO)
 * @param opts.includeAllStatuses se true, retorna PENDING/REJECTED/APPROVED/etc.
 *        Caso contrário (default), retorna apenas APPROVED (uso no envio).
 */
export async function fetchAvailableTemplates(
  opts: { includeAllStatuses?: boolean } = {},
): Promise<WhatsAppTemplate[]> {
  try {
    const qs = opts.includeAllStatuses ? '?all=1' : '';
    const url = `${SERVER_URL}/api/whatsapp/templates${qs}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${publicAnonKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();

    if (data.success && data.templates && data.templates.length > 0) {
      return data.templates.map((t: any) => ({
        template_name: t.name || t.template_name,
        language: t.language,
        category: t.category,
        components: t.components,
        status: t.status,
      }));
    }

    return [];
  } catch (error) {
    return [];
  }
}

/**
 * Verifica se a conversa está dentro da janela de 24h do WhatsApp
 */
export async function checkWhatsAppWindow(conversationId: string): Promise<{
  isWithinWindow: boolean;
  lastInboundMessage: Date | null;
  hoursRemaining: number | null;
}> {
  try {
    const { data: messages, error } = await supabase
      .from('messages')
      .select('sent_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(1);

    if (error || !messages || messages.length === 0) {
      return {
        isWithinWindow: false,
        lastInboundMessage: null,
        hoursRemaining: 0
      };
    }

    const lastMessageDate = new Date(messages[0].sent_at);
    const now = new Date();
    const diffMs = now.getTime() - lastMessageDate.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const isWithinWindow = diffHours < 24;

    return {
      isWithinWindow,
      lastInboundMessage: lastMessageDate,
      hoursRemaining: Math.max(0, 24 - diffHours)
    };
  } catch (error) {
    return {
      isWithinWindow: false,
      lastInboundMessage: null,
      hoursRemaining: 0
    };
  }
}