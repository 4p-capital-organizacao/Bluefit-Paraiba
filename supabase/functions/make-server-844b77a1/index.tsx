import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import * as kv from "./kv_store.tsx";
import * as kvContacts from "./kv_contacts.tsx";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as whatsapp from "./whatsapp.tsx";

// 🔥 VERSÃO: 5.0.0 - CLEAN ARCHITECTURE - 26/01/2026
// ✅ Endpoints de Templates e Envio de Mensagens (API REST)
// ✅ Webhook delegado ao n8n (arquitetura limpa)
// 🚨 TIMESTAMP: 1737936000000

const app = new Hono();

// Create Supabase admin client
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Create Supabase client for auth
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_ANON_KEY')!
);

// ========================================
// 🔐 MIDDLEWARE DE AUTENTICAÇÃO JWT
// ========================================

/**
 * Middleware para verificar JWT do Supabase
 * Extrai o token do header Authorization e valida com o Supabase
 */
async function authMiddleware(c: any, next: any) {
  // ✅ Ler JWT do usuário do header customizado X-User-Token
  const userToken = c.req.header('X-User-Token');
  
  if (!userToken) {
    console.error('❌ [AUTH] Header X-User-Token ausente');
    return c.json({
      success: false,
      error: 'Não autorizado. Token de autenticação ausente.'
    }, 401);
  }
  
  // Verificar token silenciosamente (log verbose removido para reduzir ruído)
  
  // ✅ Usar supabaseAdmin (SERVICE_ROLE_KEY) para validar JWT do usuário
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(userToken);
  
  if (error || !user) {
    console.warn('⚠️ [AUTH] Token inválido ou expirado:', error?.message);
    return c.json({
      success: false,
      error: 'Não autorizado. Token inválido ou expirado.'
    }, 401);
  }
  
  console.log('✅ [AUTH] Usuário autenticado:', user.email);
  
  // Adicionar usuário ao contexto para uso posterior
  c.set('user', user);
  c.set('userId', user.id);
  
  return await next();
}

// ========================================
// 💾 HELPER FUNCTION: SALVAR MENSAGEM ENVIADA
// ========================================

/**
 * Salva uma mensagem enviada (outbound) no banco de dados
 * @param params - Dados da mensagem
 * @returns ID da mensagem criada ou erro
 */
async function saveOutboundMessage(params: {
  conversationId: string;
  type: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio';
  body: string;
  providerMessageId?: string;
  mediaUrl?: string;
  templateName?: string;
  toPhoneE164?: string;
}): Promise<{ success: boolean; messageId?: string; dbMessageId?: string; error?: string }> {
  try {
    console.log('\n💾 [SAVE MESSAGE] Salvando mensagem outbound no Postgres...');
    console.log('- Conversation ID:', params.conversationId);
    console.log('- Type:', params.type);
    console.log('- Body:', params.body.substring(0, 50) + (params.body.length > 50 ? '...' : ''));
    console.log('- Provider Message ID:', params.providerMessageId || 'NÃO INFORMADO (será atualizado depois)');
    console.log('- To (E.164):', params.toPhoneE164 || 'N/A');

    const initialStatus = params.providerMessageId ? 'sent' : 'queued';
    
    console.log('📝 [SAVE MESSAGE] Status inicial:', initialStatus);
    console.log('📝 [SAVE MESSAGE] Tem provider_message_id?', !!params.providerMessageId);

    // 1️⃣ INSERIR MENSAGEM NA TABELA messages
    const messageData: any = {
      conversation_id: params.conversationId,
      direction: 'outbound',
      type: params.type,
      body: params.body, // ✅ Para áudios/mídias, o body JÁ CONTÉM a URL (igual às mensagens inbound)
      sent_at: new Date().toISOString(),
      status: initialStatus,
      created_at: new Date().toISOString()
    };

    if (params.providerMessageId) {
      messageData.provider_message_id = params.providerMessageId;
    }

    // ❌ REMOVIDO: Não usamos media_url porque essa coluna não existe
    // A URL da mídia é salva diretamente no campo "body" (consistente com inbound)

    const { data: message, error: messageError } = await supabaseAdmin
      .from('messages')
      .insert(messageData)
      .select()
      .single();

    if (messageError) {
      console.error('❌ [SAVE MESSAGE] Erro ao inserir mensagem:', messageError);
      return {
        success: false,
        error: `Erro ao salvar mensagem: ${messageError.message}`
      };
    }

    console.log('✅ [SAVE MESSAGE] Mensagem salva com sucesso!');
    console.log('- DB Message ID:', message.id);
    console.log('- Status:', message.status);

    // 2️⃣ ATUALIZAR ÚLTIMA MENSAGEM DA CONVERSA
    const { error: conversationError } = await supabaseAdmin
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', params.conversationId);

    if (conversationError) {
      console.error('⚠️ [SAVE MESSAGE] Erro ao atualizar conversa:', conversationError);
    }

    return {
      success: true,
      messageId: params.providerMessageId,
      dbMessageId: message.id
    };

  } catch (error) {
    console.error('❌ [SAVE MESSAGE] Exceção ao salvar mensagem:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido ao salvar mensagem'
    };
  }
}

// ========================================
// 🚦 TRAVA DE ENVIO DE TEMPLATES (anti-spam / custo Meta)
// ========================================

// Intervalo mínimo exigido entre templates consecutivos sem resposta do cliente.
// streak = nº de templates outbound enviados DESDE a última resposta inbound.
//   streak 0 → 1º template: liberado
//   streak 1 → 2º template: só após 24h do último
//   streak 2 → 3º template: só após 48h do último
//   streak >=3 → trava dura até o cliente responder
const TEMPLATE_THROTTLE_HOURS: Record<number, number> = { 1: 24, 2: 48 };
const TEMPLATE_THROTTLE_HARD_BLOCK_AT = 3;

interface TemplateThrottleResult {
  allowed: boolean;
  streak: number;
  lastTemplateAt: string | null;
  requiredHours: number | null;
  nextAllowedAt: string | null;
  hardBlocked: boolean;
  reason: 'ok' | 'wait' | 'hard_block' | 'no_conversation' | 'error';
}

/**
 * Avalia se um novo template pode ser enviado para a conversa, aplicando a trava
 * progressiva (24h / 48h / hard block). Qualquer mensagem inbound do cliente reseta
 * a contagem. Em caso de erro de query, NÃO bloqueia (fail-open) para não derrubar o
 * envio por um bug — apenas loga.
 */
async function evaluateTemplateThrottle(
  conversationId?: string | number | null,
): Promise<TemplateThrottleResult> {
  const base: TemplateThrottleResult = {
    allowed: true, streak: 0, lastTemplateAt: null,
    requiredHours: null, nextAllowedAt: null, hardBlocked: false, reason: 'ok',
  };

  if (!conversationId) return { ...base, reason: 'no_conversation' };

  try {
    // 1) Última resposta inbound do cliente (marco que reseta a contagem)
    const { data: inbound } = await supabaseAdmin
      .from('messages')
      .select('sent_at, created_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      .order('sent_at', { ascending: false })
      .limit(1);

    const lastInboundAt = inbound && inbound.length > 0
      ? (inbound[0].sent_at || inbound[0].created_at)
      : null;

    // 2) Templates outbound enviados DEPOIS da última resposta (a "streak")
    let q = supabaseAdmin
      .from('messages')
      .select('sent_at, created_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .eq('type', 'template')
      .order('sent_at', { ascending: false });

    if (lastInboundAt) q = q.gt('sent_at', lastInboundAt);

    const { data: templates } = await q;

    const streak = templates?.length || 0;
    if (streak === 0) return { ...base, streak: 0, reason: 'ok' };

    const lastTemplateAt = templates![0].sent_at || templates![0].created_at;

    // streak >= 3 → trava dura (até o cliente responder)
    if (streak >= TEMPLATE_THROTTLE_HARD_BLOCK_AT) {
      return {
        allowed: false, streak, lastTemplateAt,
        requiredHours: null, nextAllowedAt: null,
        hardBlocked: true, reason: 'hard_block',
      };
    }

    const requiredHours = TEMPLATE_THROTTLE_HOURS[streak]; // 1→24h, 2→48h
    const nextAllowedMs = new Date(lastTemplateAt).getTime() + requiredHours * 3600_000;

    if (Date.now() >= nextAllowedMs) {
      return { ...base, allowed: true, streak, lastTemplateAt, requiredHours, reason: 'ok' };
    }

    return {
      allowed: false, streak, lastTemplateAt, requiredHours,
      nextAllowedAt: new Date(nextAllowedMs).toISOString(),
      hardBlocked: false, reason: 'wait',
    };
  } catch (err) {
    console.error('⚠️ [THROTTLE] Erro ao avaliar trava de template (fail-open):', err);
    return { ...base, reason: 'error' };
  }
}

/**
 * Busca o texto renderizado de um template (HEADER + BODY) direto no Graph API
 * da Meta. Usado para gravar o body real da mensagem no chat ao enviar templates
 * automaticamente. Cai num fallback marcador se faltar credencial ou der erro.
 */
async function fetchTemplateRenderedText(
  templateName: string,
  languageCode: string,
  fallbackLabel = '(envio automático)',
): Promise<string> {
  const fallback = `[${templateName}] ${fallbackLabel}`;
  try {
    const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
    const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';
    if (!metaAccessToken || !wabaId) return fallback;

    const tplResp = await fetch(
      `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&language=${languageCode}`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${metaAccessToken}` } },
    );
    if (!tplResp.ok) return fallback;

    const tplData = await tplResp.json();
    const tpl = tplData.data?.[0];
    if (!tpl) return fallback;

    const headerC = tpl.components?.find((c: any) => c.type === 'HEADER');
    const bodyC = tpl.components?.find((c: any) => c.type === 'BODY');
    let ft = '';
    if (headerC?.text) ft += headerC.text + '\n\n';
    if (bodyC?.text) ft += bodyC.text;
    return ft.trim() || fallback;
  } catch (err) {
    console.warn('⚠️ [TEMPLATE] Erro ao buscar texto do template:', err);
    return fallback;
  }
}

// ========================================
// 🌐 CONFIGURAÇÃO DE CORS E LOGGING
// ========================================

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'apikey', 'X-User-Token'],
  credentials: true
}));

// ========================================
// 🏥 HEALTH CHECK
// ========================================

app.get("/make-server-844b77a1/health", (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '5.0.0',
    service: 'Blue Desk API'
  });
});

// Também disponibilizar sem prefixo para compatibilidade
app.get("/health", (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '5.0.0',
    service: 'Blue Desk API'
  });
});

// ========================================
// 🧪 ENDPOINTS DE TESTE (DEBUG)
// ========================================

/**
 * Endpoint de teste sem autenticação
 * PÚBLICO - Para verificar se o servidor está respondendo
 */
app.post("/make-server-844b77a1/api/test-no-auth", (c) => {
  console.log('🧪 [TEST-NO-AUTH] Endpoint chamado com sucesso');
  return c.json({
    success: true,
    message: 'Servidor está funcionando! Endpoint de teste sem autenticação.',
    timestamp: new Date().toISOString()
  });
});

/**
 * Endpoint de teste que recebe token no body (não no header)
 * PÚBLICO - Para testar validação de token sem middleware
 */
app.post("/make-server-844b77a1/api/test-token-in-body", async (c) => {
  console.log('🧪 [TEST-TOKEN-IN-BODY] Endpoint chamado');
  
  try {
    const body = await c.req.json();
    const userToken = body.token;
    
    console.log('- Token recebido no body:', userToken ? `${userToken.substring(0, 30)}...` : 'AUSENTE');
    
    if (!userToken) {
      return c.json({
        success: false,
        error: 'Token não fornecido no body'
      }, 400);
    }
    
    // Validar token usando SERVICE_ROLE_KEY
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(userToken);
    
    if (error || !user) {
      console.error('❌ [TEST-TOKEN-IN-BODY] Token inválido:', error?.message);
      return c.json({
        success: false,
        error: 'Token inválido ou expirado',
        validationResult: { error },
        tokenPayload: null,
        supabaseConfig: {
          url: Deno.env.get('SUPABASE_URL'),
          hasServiceRoleKey: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
        }
      }, 401);
    }
    
    console.log('✅ [TEST-TOKEN-IN-BODY] Token válido! Usuário:', user.email);
    
    return c.json({
      success: true,
      message: 'Token validado com sucesso!',
      validationResult: { user },
      tokenPayload: {
        email: user.email,
        id: user.id
      }
    });
    
  } catch (error) {
    console.error('❌ [TEST-TOKEN-IN-BODY] Erro:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// ========================================
// 🔐 AUTH ENDPOINTS
// ========================================

/**
 * POST /api/auth/signup
 * Cria uma nova conta de usuário
 * PÚBLICO - Para cadastro de novos usuários
 */
app.post("/make-server-844b77a1/api/auth/signup", async (c) => {
  console.log('\n👤 [SIGNUP] Criando nova conta...');

  try {
    const body = await c.req.json();
    const { email, password, nome, sobrenome, cpf, telefone, id_unidade } = body;

    console.log('- Email:', email);
    console.log('- Nome:', nome, sobrenome);
    console.log('- CPF:', cpf || '(não informado)');
    console.log('- Telefone:', telefone || '(não informado)');
    console.log('- Unidade:', id_unidade || '(não informada)');

    // Validar campos obrigatórios (cpf e telefone são opcionais no cadastro)
    if (!email || !password || !nome || !sobrenome) {
      return c.json({
        success: false,
        error: 'Email, senha, nome e sobrenome são obrigatórios'
      }, 400);
    }

    // Verificar se email já existe
    const { data: existingEmail } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingEmail) {
      return c.json({
        success: false,
        error: 'Este email já está cadastrado no sistema'
      }, 409);
    }

    // Verificar se CPF já existe (somente se informado)
    if (cpf) {
      const { data: existingCPF } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('cpf', cpf)
        .maybeSingle();

      if (existingCPF) {
        return c.json({
          success: false,
          error: 'Este CPF já está cadastrado no sistema'
        }, 409);
      }
    }

    // Verificar se telefone já existe (somente se informado)
    if (telefone) {
      const { data: existingPhone } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('telefone', telefone)
        .maybeSingle();

      if (existingPhone) {
        return c.json({
          success: false,
          error: 'Este telefone já está cadastrado no sistema'
        }, 409);
      }
    }

    // Buscar cargo "Sem cargo" (padrão)
    const { data: cargoSemCargo, error: cargoError } = await supabaseAdmin
      .from('cargos')
      .select('id')
      .eq('papeis', 'Sem cargo')
      .maybeSingle();

    if (cargoError || !cargoSemCargo) {
      console.error('❌ Cargo "Sem cargo" não encontrado:', cargoError);
      return c.json({
        success: false,
        error: 'Cargo padrão não encontrado no sistema. Contate o administrador.'
      }, 500);
    }

    // Ler redirectTo do body (URL de callback para confirmação de email)
    const redirectTo = body.redirectTo || '';

    // Criar usuário no Supabase Auth (SEM confirmar email — requer verificação)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: {
        nome,
        sobrenome,
        cpf,
        telefone
      }
    });

    if (authError || !authData.user) {
      console.error('❌ Erro ao criar usuário no Auth:', authError);
      return c.json({
        success: false,
        error: authError?.message || 'Erro ao criar conta de autenticação'
      }, 500);
    }

    console.log('✅ Usuário criado no Auth (email NÃO confirmado):', authData.user.id);

    // Criar profile na tabela profiles
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({
        id: authData.user.id,
        email,
        nome,
        sobrenome,
        cpf: cpf || null,
        telefone: telefone || null,
        id_cargo: cargoSemCargo.id,
        id_unidade: id_unidade ? Number(id_unidade) : null,
        ativo: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    if (profileError) {
      console.error('❌ Erro ao criar profile:', profileError);
      
      // Remover usuário do Auth se falhar ao criar profile
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      
      return c.json({
        success: false,
        error: 'Erro ao criar perfil de usuário. Tente novamente.'
      }, 500);
    }

    console.log('✅ Profile criado com sucesso!');

    // Inserir na profile_units (unidade principal)
    if (id_unidade) {
      const { error: unitError } = await supabaseAdmin
        .from('profile_units')
        .insert({
          profile_id: authData.user.id,
          unit_id: Number(id_unidade),
          is_primary: true,
        });
      if (unitError) {
        console.warn('⚠️ Erro ao inserir profile_units (não crítico):', unitError.message);
      } else {
        console.log('✅ profile_units criado com unidade principal:', id_unidade);
      }
    }

    // 📧 ENVIAR EMAIL DE CONFIRMAÇÃO
    // Estratégia: /auth/v1/resend PRIMEIRO (gera token + envia email).
    // Fallback: generateLink via Admin API (só se resend retornar 429).
    let emailSent = false;
    let confirmationError = null;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    try {
      console.log('📧 [SIGNUP] Tentando enviar email de confirmação via /auth/v1/resend...');
      console.log('   - redirectTo:', redirectTo || '(não informado)');

      // 1) Tentar enviar email via GoTrue /auth/v1/resend PRIMEIRO
      const resendResponse = await fetch(`${supabaseUrl}/auth/v1/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
        },
        body: JSON.stringify({
          type: 'signup',
          email,
          options: {
            emailRedirectTo: redirectTo || undefined,
          },
        }),
      });

      if (resendResponse.ok) {
        emailSent = true;
        console.log('✅ [SIGNUP] Email de confirmação enviado com sucesso!');
      } else {
        const resendErrorText = await resendResponse.text();
        console.warn('⚠️ [SIGNUP] Resend falhou (HTTP ' + resendResponse.status + '):', resendErrorText);

        if (resendResponse.status === 429) {
          console.log('⏳ [SIGNUP] Rate limited no resend. Tentando generateLink como fallback...');

          // 2) Fallback: generateLink via Admin API para ao menos criar o token
          try {
            const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
              type: 'signup',
              email,
              password,
              options: {
                redirectTo: redirectTo || undefined,
              },
            });

            if (linkError) {
              console.error('⚠️ [SIGNUP] Fallback generateLink também falhou:', linkError.message);
            } else {
              console.log('✅ [SIGNUP] Token gerado via fallback. Próximo resend manual deve funcionar.');
            }
          } catch (genErr) {
            console.error('⚠️ [SIGNUP] Exceção no fallback generateLink:', genErr);
          }

          confirmationError = 'rate_limited';
        } else {
          confirmationError = `Falha ao enviar email (HTTP ${resendResponse.status})`;
        }
      }
    } catch (emailErr) {
      console.error('⚠️ [SIGNUP] Exceção ao enviar email:', emailErr);
      confirmationError = emailErr instanceof Error ? emailErr.message : 'Erro desconhecido';
    }

    return c.json({
      success: true,
      message: emailSent
        ? 'Conta criada! Verifique seu email para confirmar.'
        : 'Conta criada! Verifique seu email ou solicite reenvio.',
      emailSent,
      confirmationError,
      user: {
        id: authData.user.id,
        email: authData.user.email
      }
    });

  } catch (error) {
    console.error('❌ Erro ao criar conta:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro ao criar conta'
    }, 500);
  }
});

// ========================================
// 📧 REENVIO DE EMAIL DE CONFIRMAÇÃO
// ========================================

/**
 * POST /api/auth/resend-confirmation
 * Reenvia o email de confirmação para um usuário não confirmado.
 * Fluxo resiliente: Admin API primeiro (sem rate limit), GoTrue como best-effort.
 * PÚBLICO
 */
app.post("/make-server-844b77a1/api/auth/resend-confirmation", async (c) => {
  console.log('\n📧 [RESEND] Reenviando email de confirmação...');

  try {
    const body = await c.req.json();
    const { email, redirectTo } = body;

    if (!email) {
      return c.json({ success: false, error: 'Email é obrigatório' }, 400);
    }

    console.log('- Email:', email);
    console.log('- redirectTo:', redirectTo || '(não informado)');

    // ─── 1) Buscar usuário de forma confiável via profiles → getUserById ───
    let authUser: any = null;
    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      if (profile?.id) {
        const { data: { user }, error: getUserErr } = await supabaseAdmin.auth.admin.getUserById(profile.id);
        if (!getUserErr && user) {
          authUser = user;
          console.log('✅ [RESEND] Usuário encontrado via profiles → getUserById:', authUser.id);
        }
      }
    } catch (lookupErr) {
      console.warn('⚠️ [RESEND] Exceção ao buscar via profiles:', lookupErr);
    }

    // Fallback: listUsers paginado (caso profiles não tenha o email)
    if (!authUser) {
      try {
        const { data: usersData } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
        authUser = usersData?.users?.find((u: any) => u.email === email) || null;
        if (authUser) {
          console.log('✅ [RESEND] Usuário encontrado via listUsers fallback:', authUser.id);
        }
      } catch (listErr) {
        console.warn('⚠️ [RESEND] Exceção no fallback listUsers:', listErr);
      }
    }

    // ─── 2) Se o email já está confirmado, retornar imediatamente ───
    if (authUser?.email_confirmed_at) {
      console.log('ℹ️ [RESEND] Email já está confirmado.');
      return c.json({
        success: true,
        autoConfirmed: true,
        message: 'Seu email já está confirmado! Faça login normalmente.'
      });
    }

    // ─── 3) Tentar enviar email via GoTrue /auth/v1/resend (best-effort) ───
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    let emailSent = false;

    try {
      const resendResponse = await fetch(`${supabaseUrl}/auth/v1/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': anonKey,
        },
        body: JSON.stringify({
          type: 'signup',
          email,
          options: {
            emailRedirectTo: redirectTo || undefined,
          },
        }),
      });

      if (resendResponse.ok) {
        console.log('✅ [RESEND] Email reenviado com sucesso via GoTrue!');
        emailSent = true;
      } else {
        const errorText = await resendResponse.text();
        console.warn(`⚠️ [RESEND] GoTrue retornou ${resendResponse.status}:`, errorText);
        // Não bloqueia — continua para auto-confirmar via Admin API
      }
    } catch (resendErr) {
      console.warn('⚠️ [RESEND] Exceção ao chamar GoTrue /resend:', resendErr);
    }

    // Se o email foi enviado com sucesso, retornar
    if (emailSent) {
      return c.json({ success: true, message: 'Email de confirmação reenviado!' });
    }

    // ─── 4) GoTrue falhou (429 ou outro) — NÃO auto-confirmar ───
    // O email deve ser confirmado apenas pelo próprio usuário clicando no link.
    // Se o GoTrue está com rate limit, orientamos aguardar.
    if (authUser && !authUser.email_confirmed_at) {
      console.log('⏳ [RESEND] GoTrue indisponível (rate limit ou erro). Aguardando cooldown...');
      return c.json({
        success: false,
        rateLimited: true,
        waitSeconds: 60,
        error: 'Limite de envio atingido. Aguarde um minuto e tente novamente, ou verifique sua caixa de spam.'
      }, 429);
    }

    // ─── 5) Nenhum método funcionou — retorno seguro genérico ───
    if (!authUser) {
      // Não revelar se o email existe ou não
      return c.json({
        success: true,
        message: 'Se o email estiver cadastrado, você receberá um link de confirmação.'
      });
    }

    // Caso raro: usuário existe mas GoTrue + Admin API falharam
    return c.json({
      success: false,
      error: 'Não foi possível confirmar o email no momento. Tente novamente em alguns segundos.',
      rateLimited: true,
      waitSeconds: 30,
    }, 429);

  } catch (error) {
    console.error('❌ [RESEND] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro ao reenviar email'
    }, 500);
  }
});

// ========================================
// 🔑 RECUPERAÇÃO DE SENHA (Admin API — bypassa rate limit)
// ========================================

/**
 * POST /api/auth/recovery
 * Envia email de recuperação de senha.
 *
 * Estratégia CORRIGIDA:
 * 1) PRIMÁRIO: Chamar GoTrue /recover para ENVIAR O EMAIL
 *    - O email template deve usar: {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery
 *    - Isso faz o link do email ir direto para o app com token_hash
 * 2) FALLBACK: Se /recover falhar (429 rate limit), usar generateLink() para
 *    gerar um link direto que o frontend pode mostrar como alternativa
 *
 * IMPORTANTE: NÃO chamar generateLink() quando /recover funcionar, pois
 * generateLink() cria um novo token que INVALIDA o token do email.
 *
 * PÚBLICO
 */
app.post("/make-server-844b77a1/api/auth/recovery", async (c) => {
  console.log('\n🔑 [RECOVERY] Solicitação de recuperação de senha...');

  try {
    const body = await c.req.json();
    const { email, redirectTo } = body;

    if (!email) {
      return c.json({ success: false, error: 'Email é obrigatório' }, 400);
    }

    console.log('- Email:', email);
    console.log('- redirectTo:', redirectTo || '(não informado)');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // ─── 1) MÉTODO PRIMÁRIO: Enviar email via GoTrue /recover ───
    console.log('📧 [RECOVERY] Tentando enviar email via GoTrue /recover...');

    let emailSent = false;
    let emailError = '';

    try {
      const recoverResponse = await fetch(`${supabaseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          email,
          ...(redirectTo ? { redirect_to: redirectTo } : {}),
          gotrue_meta_security: { captcha_token: '' },
        }),
      });

      if (recoverResponse.ok) {
        emailSent = true;
        console.log('✅ [RECOVERY] Email enviado com sucesso via /recover!');
      } else {
        const errText = await recoverResponse.text();
        emailError = `HTTP ${recoverResponse.status}: ${errText}`;
        console.warn('⚠️ [RECOVERY] /recover falhou:', emailError);
      }
    } catch (fetchErr) {
      emailError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.warn('⚠️ [RECOVERY] Exceção ao chamar /recover:', emailError);
    }

    // Se o email foi enviado com sucesso, retornar sem gerar link extra
    // (para não invalidar o token do email)
    if (emailSent) {
      console.log('✅ [RECOVERY] Fluxo por email concluído. Retornando sucesso.');
      return c.json({
        success: true,
        emailSent: true,
        message: 'Email de recuperação enviado! Verifique sua caixa de entrada.'
      });
    }

    // ─── 2) FALLBACK: generateLink (só quando email falhou) ───
    console.log('🔄 [RECOVERY] Email falhou. Usando generateLink como fallback...');
    console.log('   - Motivo da falha:', emailError);

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: {
        redirectTo: redirectTo || undefined,
      },
    });

    if (linkError) {
      console.error('❌ [RECOVERY] generateLink também falhou:', linkError.message);
      return c.json({
        success: true,
        emailSent: false,
        message: 'Se o email estiver cadastrado, você receberá as instruções em breve.'
      });
    }

    const actionLink = linkData?.properties?.action_link;
    let tokenHash: string | null = null;

    if (actionLink) {
      try {
        const url = new URL(actionLink);
        tokenHash = url.searchParams.get('token_hash') || url.searchParams.get('token');
        console.log('🔗 [RECOVERY] token_hash extraído do generateLink:', tokenHash ? '(presente)' : '(ausente)');
      } catch (e) {
        console.error('⚠️ [RECOVERY] Erro ao parsear action_link:', e);
      }
    }

    if (tokenHash) {
      const baseRedirect = redirectTo || `${supabaseUrl}`;
      const recoveryUrl = `${baseRedirect}?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`;
      console.log('✅ [RECOVERY] URL de recovery (fallback) construída.');

      return c.json({
        success: true,
        emailSent: false,
        recoveryUrl,
        message: 'O envio de email está temporariamente limitado. Use o link alternativo abaixo.'
      });
    }

    return c.json({
      success: true,
      emailSent: false,
      message: 'Se o email estiver cadastrado, você receberá as instruções em breve.'
    });

  } catch (error) {
    console.error('❌ [RECOVERY] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro ao processar recuperação'
    }, 500);
  }
});

// ========================================
// 🔍 CONFIG CHECK - DIAGNÓSTICO DE CONFIGURAÇÃO
// ========================================

/**
 * Verifica se as variáveis de ambiente do WhatsApp estão configuradas
 * PÚBLICO - Para diagnóstico
 */
app.get("/make-server-844b77a1/api/whatsapp/config-check", async (c) => {
  console.log('🔍 Verificando configuração do WhatsApp...');
  
  const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
  const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID');
  const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');
  
  let detectedWabaId = null;
  let phoneNumberInfo = null;
  let phoneNumberIdValid = false;
  
  // Tentar buscar o WABA ID automaticamente e validar PHONE_NUMBER_ID
  if (accessToken && phoneNumberId) {
    console.log('🔍 Tentando validar Phone Number ID e buscar WABA ID automaticamente...');
    
    try {
      const phoneInfoUrl = `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=id,verified_name,display_phone_number,quality_rating,whatsapp_business_account_id`;
      const response = await fetch(phoneInfoUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      
      if (response.ok) {
        phoneNumberInfo = await response.json();
        detectedWabaId = phoneNumberInfo.whatsapp_business_account_id;
        phoneNumberIdValid = true;
        console.log('✅ Phone Number ID VÁLIDO!');
        console.log('✅ WABA ID detectado:', detectedWabaId);
      } else {
        const errorData = await response.json();
        console.error('❌ Phone Number ID INVÁLIDO ou sem permissões!');
        console.error('Erro:', errorData);
        phoneNumberIdValid = false;
        
        // Verificar se o erro é de ID não encontrado
        if (errorData.error?.code === 100 || errorData.error?.message?.includes('does not exist')) {
          console.error('🔴 ERRO CRÍTICO: O META_WHATSAPP_PHONE_NUMBER_ID não existe ou você não tem acesso a ele.');
          console.error('💡 Solução: Verifique o Phone Number ID no painel da Meta Business Platform.');
        }
      }
    } catch (e) {
      console.error('❌ Exceção ao validar Phone Number ID:', e);
      phoneNumberIdValid = false;
    }
  }
  
  const config = {
    META_WHATSAPP_ACCESS_TOKEN: {
      configured: !!accessToken,
      value: accessToken ? `${accessToken.substring(0, 20)}...` : 'NÃO CONFIGURADO',
      length: accessToken?.length || 0
    },
    META_WHATSAPP_WABA_ID: {
      configured: !!wabaId,
      value: wabaId || 'NÃO CONFIGURADO',
      detectedValue: detectedWabaId || 'Não foi possível detectar automaticamente',
      isCorrect: wabaId === detectedWabaId
    },
    META_WHATSAPP_PHONE_NUMBER_ID: {
      configured: !!phoneNumberId,
      value: phoneNumberId || 'NÃO CONFIGURADO',
      isValid: phoneNumberIdValid,
      validationStatus: phoneNumberIdValid ? '✅ VÁLIDO' : '❌ INVÁLIDO OU SEM ACESSO'
    }
  };
  
  const allConfigured = accessToken && phoneNumberId && phoneNumberIdValid;
  
  let recommendation = null;
  let criticalError = null;
  
  // 🔴 ERRO CRÍTICO: Phone Number ID inválido
  if (phoneNumberId && !phoneNumberIdValid) {
    criticalError = {
      type: 'INVALID_PHONE_NUMBER_ID',
      message: `❌ ERRO CRÍTICO: O Phone Number ID "${phoneNumberId}" é inválido ou você não tem permissão para acessá-lo.`,
      solution: 'Verifique o Phone Number ID correto no painel da Meta Business Platform (https://business.facebook.com/settings/whatsapp-business-accounts) e atualize a variável META_WHATSAPP_PHONE_NUMBER_ID.',
      impact: 'Você NÃO conseguir enviar mensagens até corrigir este ID.'
    };
  }
  
  // Recomendações para WABA_ID
  if (detectedWabaId && wabaId && wabaId !== detectedWabaId) {
    recommendation = `⚠️ ATENÇÃO: O META_WHATSAPP_WABA_ID configurado (${wabaId}) é diferente do WABA ID real detectado (${detectedWabaId}). Atualize para: ${detectedWabaId}`;
  } else if (detectedWabaId && !wabaId) {
    recommendation = `💡 Configure META_WHATSAPP_WABA_ID com o valor: ${detectedWabaId}`;
  }
  
  return c.json({
    success: allConfigured,
    message: allConfigured 
      ? 'Todas as variáveis estão configuradas e validadas ✅' 
      : criticalError 
        ? criticalError.message
        : 'Algumas variáveis de ambiente estão faltando ou inválidas',
    config,
    phoneNumberInfo,
    recommendation,
    criticalError,
    missingVars: [
      !accessToken && 'META_WHATSAPP_ACCESS_TOKEN',
      (!phoneNumberId || !phoneNumberIdValid) && 'META_WHATSAPP_PHONE_NUMBER_ID (válido)',
      !wabaId && !detectedWabaId && 'META_WHATSAPP_WABA_ID'
    ].filter(Boolean)
  });
});

// ========================================
// 📱 WHATSAPP API - TEMPLATES
// ========================================

/**
 * GET /api/whatsapp/templates
 * Busca templates disponíveis da API da Meta
 * PÚBLICO - Não requer autenticação
 */
app.get("/make-server-844b77a1/api/whatsapp/templates", async (c) => {
  const timestamp = new Date().toISOString();
  const includeAll = c.req.query('all') === '1';

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  🚀 ENDPOINT TEMPLATES - PÚBLICO                         ║');
  console.log(`║  🕐 ${timestamp}                                          ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    console.log(`📋 [PÚBLICO] Buscando templates da API da Meta (all=${includeAll})...`);

    const result = await whatsapp.fetchWhatsAppTemplates({ includeAllStatuses: includeAll });

    console.log('📦 Resultado da busca:', {
      success: result.success,
      templatesCount: result.templates?.length || 0,
      hasError: !!result.error
    });

    if (!result.success) {
      console.error('❌ Erro ao buscar templates:', result.error);
      return c.json({
        success: false,
        error: result.error,
        details: result.details,
        templates: []
      }, 200);
    }

    console.log(`✅ ${result.templates?.length || 0} templates retornados ao frontend`);

    return c.json({
      success: true,
      templates: result.templates,
      total: result.templates?.length || 0,
      timestamp
    });

  } catch (error) {
    console.error('❌ Exceção ao buscar templates:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      templates: []
    }, 500);
  }
});

/**
 * POST /api/whatsapp/templates
 * Cria um novo template via API da Meta (apenas Gerentes/Admin — cargo >= 4)
 */
app.post("/make-server-844b77a1/api/whatsapp/templates", authMiddleware, async (c) => {
  try {
    const userId = c.get('userId');

    // Verificar permissão via menu_item_permissions (admin pode reconfigurar via UI)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, id_cargo, cargo:cargos!profiles_id_cargo_fkey(id, level, papeis)')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return c.json({ success: false, error: 'Perfil não encontrado.' }, 403);
    }

    const cargoLevel = (profile.cargo as any)?.level ?? 0;

    // Consulta a tabela menu_item_permissions
    const { data: perm, error: permErr } = await supabaseAdmin
      .from('menu_item_permissions')
      .select('required_cargo_levels')
      .eq('module_key', 'templates')
      .single();

    if (permErr || !perm) {
      console.warn(`⚠️ [TEMPLATES] menu_item_permissions sem registro para 'templates'`);
      return c.json({
        success: false,
        error: 'Permissões do módulo Templates não configuradas. Peça ao administrador.'
      }, 403);
    }

    const allowedLevels: number[] = perm.required_cargo_levels || [];
    if (!allowedLevels.includes(cargoLevel)) {
      console.warn(`⚠️ [TEMPLATES] Acesso negado userId=${userId} cargoLevel=${cargoLevel} permitidos=${JSON.stringify(allowedLevels)}`);
      return c.json({
        success: false,
        error: 'Seu cargo não tem permissão para criar templates. Peça ao administrador.'
      }, 403);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'Body inválido.' }, 400);
    }

    const input = {
      name: typeof body.name === 'string' ? body.name.trim() : '',
      language: typeof body.language === 'string' ? body.language.trim() : 'pt_BR',
      category: body.category,
      body: typeof body.body === 'string' ? body.body : '',
      bodyExamples: Array.isArray(body.bodyExamples)
        ? body.bodyExamples
            .filter((e: any) => typeof e === 'string')
            .map((e: string) => e.trim())
        : undefined,
      footer: typeof body.footer === 'string' ? body.footer.trim() : null,
      buttons: Array.isArray(body.buttons)
        ? body.buttons
            .filter((b: any) => b && typeof b.text === 'string')
            .map((b: any) => ({ type: 'QUICK_REPLY', text: String(b.text).trim() }))
        : [],
    };

    console.log(`📨 [TEMPLATES][POST] userId=${userId} cargoLevel=${cargoLevel} name=${input.name}`);

    const result = await whatsapp.createWhatsAppTemplate(input as any);

    if (!result.success) {
      return c.json({ success: false, error: result.error, details: result.details }, 400);
    }

    return c.json({ success: true, template: result.template }, 200);
  } catch (error) {
    console.error('❌ Exceção ao criar template:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    }, 500);
  }
});

/**
 * DELETE /api/whatsapp/templates/:name
 * Apaga template na Meta (todas as línguas com esse nome). Restrito por
 * menu_item_permissions['templates'].
 */
app.delete("/make-server-844b77a1/api/whatsapp/templates/:name", authMiddleware, async (c) => {
  try {
    const userId = c.get('userId');
    const templateName = c.req.param('name');

    if (!templateName) {
      return c.json({ success: false, error: 'Nome do template não informado.' }, 400);
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, id_cargo, cargo:cargos!profiles_id_cargo_fkey(id, level, papeis)')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return c.json({ success: false, error: 'Perfil não encontrado.' }, 403);
    }
    const cargoLevel = (profile.cargo as any)?.level ?? 0;

    const { data: perm } = await supabaseAdmin
      .from('menu_item_permissions')
      .select('required_cargo_levels')
      .eq('module_key', 'templates')
      .single();

    const allowedLevels: number[] = (perm as any)?.required_cargo_levels || [];
    if (!allowedLevels.includes(cargoLevel)) {
      console.warn(`⚠️ [TEMPLATES][DELETE] Acesso negado userId=${userId} cargoLevel=${cargoLevel}`);
      return c.json({
        success: false,
        error: 'Seu cargo não tem permissão para excluir templates.'
      }, 403);
    }

    console.log(`🗑️ [TEMPLATES][DELETE] userId=${userId} cargoLevel=${cargoLevel} name=${templateName}`);

    const result = await whatsapp.deleteWhatsAppTemplate(templateName);
    if (!result.success) {
      return c.json({ success: false, error: result.error, details: result.details }, 400);
    }
    return c.json({ success: true }, 200);
  } catch (error) {
    console.error('❌ Exceção ao deletar template:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    }, 500);
  }
});

/**
 * POST /api/automation/run-followup
 * Disparada por pg_cron via pg_net. Autentica via header X-Cron-Secret
 * (env var BLUEDESK_CRON_SECRET).
 *
 * Para cada unidade com followup_enabled=true:
 *   1. Verifica cap diário (sent_today < daily_cap)
 *   2. Chama RPC eligible_followup_leads(unit_id, restante_do_cap)
 *   3. Para cada lead: envia template via Meta API
 *   4. Loga em automated_message_log
 *   5. Salva mensagem outbound no banco (saveOutboundMessage)
 */
app.post("/make-server-844b77a1/api/automation/run-followup", async (c) => {
  const expectedSecret = Deno.env.get('BLUEDESK_CRON_SECRET');
  const providedSecret = c.req.header('X-Cron-Secret');

  if (!expectedSecret) {
    console.error('❌ [AUTOMATION] BLUEDESK_CRON_SECRET não configurado');
    return c.json({ success: false, error: 'Secret não configurado no servidor' }, 500);
  }
  if (providedSecret !== expectedSecret) {
    console.warn('⚠️ [AUTOMATION] X-Cron-Secret inválido');
    return c.json({ success: false, error: 'Não autorizado' }, 401);
  }

  const startedAt = Date.now();
  console.log('\n🤖 [AUTOMATION] Iniciando run-followup');

  try {
    // 1. Carrega unidades com automação ativa
    const { data: units, error: unitsErr } = await supabaseAdmin
      .from('unit_automation_settings')
      .select('unit_id, daily_cap, template_name, template_language, followup_enabled')
      .eq('followup_enabled', true);

    if (unitsErr) {
      console.error('❌ [AUTOMATION] Erro ao listar unidades ativas:', unitsErr);
      return c.json({ success: false, error: unitsErr.message }, 500);
    }

    if (!units || units.length === 0) {
      console.log('ℹ️ [AUTOMATION] Nenhuma unidade com automação ativa.');
      return c.json({ success: true, processed: 0, units: [] });
    }

    const totalsByUnit: any[] = [];

    for (const u of units) {
      const unitId = (u as any).unit_id;
      const cap = (u as any).daily_cap || 50;
      const templateName = (u as any).template_name || 'followup_contato_feito_v1';
      const templateLanguage = (u as any).template_language || 'pt_BR';

      // 🆕 Pré-busca o texto renderizado do template (HEADER+BODY) UMA vez por
      // unidade. Vai ser usado como body da mensagem outbound em vez do antigo
      // placeholder [template_name] (envio automático de follow-up).
      const renderedTemplateText = await fetchTemplateRenderedText(
        templateName,
        templateLanguage,
        '(envio automático de follow-up)',
      );

      // 2. Conta envios de hoje
      const todayRes = await supabaseAdmin.rpc('count_followups_today', { p_unit_id: unitId });
      const sentToday = todayRes?.error ? 0 : (todayRes.data as number) || 0;
      const remaining = Math.max(0, cap - sentToday);

      if (remaining <= 0) {
        console.log(`⏭️ [AUTOMATION] Unidade ${unitId}: cap diário atingido (${sentToday}/${cap})`);
        totalsByUnit.push({ unit_id: unitId, sent_today: sentToday, processed: 0, skipped: 'daily_cap' });
        continue;
      }

      // 3. Lista leads elegíveis (até remaining)
      const eligibleRes = await supabaseAdmin.rpc('eligible_followup_leads', {
        p_unit_id: unitId,
        p_limit: remaining,
      });

      if (eligibleRes.error) {
        console.error(`❌ [AUTOMATION] Erro eligible_followup_leads(unit=${unitId}):`, eligibleRes.error);
        totalsByUnit.push({ unit_id: unitId, error: eligibleRes.error.message });
        continue;
      }

      const eligible = (eligibleRes.data as any[]) || [];
      console.log(`📋 [AUTOMATION] Unidade ${unitId}: ${eligible.length} leads elegíveis (cap restante ${remaining})`);

      let okCount = 0;
      let failCount = 0;

      for (const lead of eligible) {
        const phone = String(lead.phone || '').replace(/\+/g, '');
        if (!phone) {
          await supabaseAdmin.from('automated_message_log').insert({
            template_name: templateName,
            language: templateLanguage,
            lead_id: lead.lead_id,
            contact_id: lead.contact_id,
            unit_id: unitId,
            reason: 'sla_followup_72h',
            status: 'skipped',
            error_message: 'Lead sem telefone',
          });
          continue;
        }

        // 🚦 TRAVA: respeita o mesmo intervalo entre templates (24h/48h/hard-block).
        // Defesa extra além da cadência da RPC — evita reenvio acumulado sem resposta.
        if (lead.conversation_id) {
          const throttle = await evaluateTemplateThrottle(lead.conversation_id);
          if (!throttle.allowed) {
            console.warn(`🚦 [AUTOMATION] Lead ${lead.lead_id} bloqueado pela trava (streak=${throttle.streak}, reason=${throttle.reason})`);
            await supabaseAdmin.from('automated_message_log').insert({
              template_name: templateName,
              language: templateLanguage,
              lead_id: lead.lead_id,
              conversation_id: lead.conversation_id,
              contact_id: lead.contact_id,
              unit_id: unitId,
              reason: 'sla_followup_72h',
              status: 'skipped',
              error_message: throttle.hardBlocked
                ? `Trava: ${throttle.streak} templates sem resposta (hard block)`
                : `Trava: aguardando ${throttle.requiredHours}h sem resposta (streak ${throttle.streak})`,
            });
            continue;
          }
        }

        // Envia template via Meta
        const sendResult = await whatsapp.sendWhatsAppTemplate({
          to: phone,
          templateName,
          languageCode: templateLanguage,
        });

        const reason = (lead.envio_count && lead.envio_count > 0) ? 'sla_followup_reenvio_7d' : 'sla_followup_72h';

        if (sendResult.success) {
          okCount++;

          // Loga sucesso
          await supabaseAdmin.from('automated_message_log').insert({
            template_name: templateName,
            language: templateLanguage,
            lead_id: lead.lead_id,
            conversation_id: lead.conversation_id,
            contact_id: lead.contact_id,
            unit_id: unitId,
            reason,
            meta_message_id: sendResult.messageId,
            status: 'sent',
          });

          // Salva mensagem outbound (aparece no chat) com o body renderizado do template
          if (lead.conversation_id) {
            try {
              await saveOutboundMessage({
                conversationId: String(lead.conversation_id),
                type: 'template',
                body: renderedTemplateText,
                providerMessageId: sendResult.messageId,
                templateName,
                toPhoneE164: phone,
              });
            } catch (saveErr) {
              console.warn('⚠️ [AUTOMATION] saveOutboundMessage falhou (lead', lead.lead_id, '):', saveErr);
            }
          }
        } else {
          failCount++;
          await supabaseAdmin.from('automated_message_log').insert({
            template_name: templateName,
            language: templateLanguage,
            lead_id: lead.lead_id,
            conversation_id: lead.conversation_id,
            contact_id: lead.contact_id,
            unit_id: unitId,
            reason,
            status: 'failed',
            error_message: sendResult.error || 'Erro desconhecido',
          });
          console.error(`❌ [AUTOMATION] Falha lead=${lead.lead_id} unit=${unitId}: ${sendResult.error}`);
        }
      }

      // Move leads que já receberam todos os templates para base_fria
      const moveRes = await supabaseAdmin.rpc('move_leads_to_base_fria', { p_unit_id: unitId });
      const movedToBaseFria = moveRes?.error ? 0 : (moveRes.data as number) || 0;

      totalsByUnit.push({
        unit_id: unitId,
        sent_today_before: sentToday,
        processed: eligible.length,
        ok: okCount,
        failed: failCount,
        moved_to_base_fria: movedToBaseFria,
        cap_remaining_after: remaining - eligible.length,
      });
    }

    const elapsed = Date.now() - startedAt;
    console.log(`✅ [AUTOMATION] Concluído em ${elapsed}ms:`, totalsByUnit);

    return c.json({
      success: true,
      duration_ms: elapsed,
      units: totalsByUnit,
    });
  } catch (error) {
    console.error('❌ [AUTOMATION] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    }, 500);
  }
});

/**
 * GET /api/whatsapp/templates/:name
 * Busca detalhes de um template específico
 */
app.get("/make-server-844b77a1/api/whatsapp/templates/:name", async (c) => {
  const templateName = c.req.param('name');
  const languageCode = c.req.query('language') || 'pt_BR';

  console.log('\n🔍 Buscando template específico:', templateName);
  console.log('- Language:', languageCode);

  try {
    // Buscar todos os templates
    const result = await whatsapp.fetchWhatsAppTemplates();

    if (!result.success) {
      return c.json({
        success: false,
        error: result.error
      }, 400);
    }

    // Filtrar pelo nome e idioma
    const template = result.templates?.find((t: any) => 
      t.name === templateName && 
      t.language === languageCode
    );

    if (!template) {
      console.log('❌ Template não encontrado');
      
      // Buscar template da Meta API para obter texto completo
      const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
      const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';
      
      if (metaAccessToken && wabaId) {
        const templateResponse = await fetch(
          `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&language=${languageCode}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${metaAccessToken}`
            }
          }
        );
        
        if (templateResponse.ok) {
          const templateData = await templateResponse.json();
          console.log('✅ Template buscado da Meta:', JSON.stringify(templateData, null, 2));
          
          if (templateData.data && templateData.data.length > 0) {
            const template = templateData.data[0];
            const bodyComponent = template.components?.find((c: any) => c.type === 'BODY');
            const headerComponent = template.components?.find((c: any) => c.type === 'HEADER');
            
            let fullText = '';
            
            // ADICIONAR HEADER (se existir e tiver texto)
            if (headerComponent?.text) {
              fullText += headerComponent.text + '\n\n';
            }
            
            // ADICIONAR BODY (sempre obrigatório)
            if (bodyComponent?.text) {
              fullText += bodyComponent.text;
            }
            
            console.log('📝 Texto completo do template:', fullText);
            
            return c.json({
              success: true,
              template: {
                ...template,
                fullText
              }
            });
          }
        }
      }
      
      return c.json({
        success: false,
        error: 'Template não encontrado'
      }, 404);
    }

    console.log('✅ Template encontrado:', template.name);

    return c.json({
      success: true,
      template
    });

  } catch (error) {
    console.error('❌ Erro ao buscar template:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 📤 WHATSAPP API - ENVIO DE MENSAGENS
// ========================================

/**
 * Processa o texto do template substituindo variáveis pelos valores reais
 * @param templateText - Texto original do template com {{1}}, {{2}}, etc
 * @param components - Array de componentes com os parâmetros
 * @returns Texto processado com variáveis substituídas
 */
function processTemplateText(templateText: string, components?: any[]): string {
  if (!components || components.length === 0) {
    return templateText;
  }

  let processedText = templateText;

  // Processar componentes BODY (onde ficam as variáveis de texto)
  const bodyComponent = components.find((c: any) => c.type === 'body');
  
  if (bodyComponent && bodyComponent.parameters) {
    bodyComponent.parameters.forEach((param: any, index: number) => {
      if (param.type === 'text' && param.text) {
        // Substituir variáveis posicionais {{1}}, {{2}}, etc
        const positionalPattern = new RegExp(`\\{\\{${index + 1}\\}\\}`, 'g');
        processedText = processedText.replace(positionalPattern, param.text);
        
        // Substituir variáveis nomeadas se houver parameter_name
        if (param.parameter_name) {
          const namedPattern = new RegExp(`\\{\\{${param.parameter_name}\\}\\}`, 'g');
          processedText = processedText.replace(namedPattern, param.text);
        }
      }
    });
  }

  return processedText;
}

/**
 * POST /api/whatsapp/send-template
 * Envia um template do WhatsApp
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.post("/make-server-844b77a1/api/whatsapp/send-template", authMiddleware, async (c) => {
  console.log('\n📤 [SEND TEMPLATE] Recebendo requisição...');

  try {
    const body = await c.req.json();
    console.log('📦 Body recebido:', JSON.stringify(body, null, 2));

    const { to, templateName, languageCode, parameters, conversationId } = body;

    if (!to) {
      return c.json({
        success: false,
        error: 'Campo "to" (nmero do destinatário) é obrigatório'
      }, 400);
    }

    if (!templateName) {
      return c.json({
        success: false,
        error: 'Campo "templateName" é obrigatório'
      }, 400);
    }

    console.log('📤 [SEND TEMPLATE] Enviando template:', templateName);
    console.log('- Para:', to);
    console.log('- Idioma:', languageCode || 'pt_BR');
    console.log('- Parâmetros:', parameters);

    // 🚦 TRAVA: valida o intervalo entre templates ANTES de gastar envio na Meta
    const throttle = await evaluateTemplateThrottle(conversationId);
    if (!throttle.allowed) {
      console.warn(`🚦 [SEND TEMPLATE] Bloqueado pela trava (streak=${throttle.streak}, reason=${throttle.reason})`);
      const errorMsg = throttle.hardBlocked
        ? `Este cliente já recebeu ${throttle.streak} templates sem responder. Aguarde uma resposta antes de enviar outro template — ou feche a conversa / mova o lead para a Base Fria.`
        : `Trava de envio: o ${throttle.streak + 1}º template para este cliente só pode ser enviado após ${throttle.requiredHours}h do último. Liberado em ${new Date(throttle.nextAllowedAt!).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`;
      return c.json({ success: false, error: errorMsg, throttle, blocked: true }, 429);
    }

    // ✅ Passar como objeto (interface SendTemplateParams)
    const result = await whatsapp.sendWhatsAppTemplate({
      to,
      templateName,
      languageCode: languageCode || 'pt_BR',
      components: parameters || []
    });

    console.log('📡 Resposta da API do WhatsApp:', JSON.stringify(result, null, 2));

    if (result.success && conversationId) {
      // Buscar o texto completo do template da API da Meta
      let templateText = templateName; // Fallback para o nome do template
      
      try {
        console.log('📄 [TEMPLATE TEXT] Buscando texto completo do template...');
        
        const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
        const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';
        
        if (metaAccessToken && wabaId) {
          const templateResponse = await fetch(
            `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&language=${languageCode || 'pt_BR'}`,
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${metaAccessToken}`
              }
            }
          );
          
          if (templateResponse.ok) {
            const templateData = await templateResponse.json();
            
            if (templateData.data && templateData.data.length > 0) {
              const template = templateData.data[0];
              const bodyComponent = template.components?.find((c: any) => c.type === 'BODY');
              const headerComponent = template.components?.find((c: any) => c.type === 'HEADER');
              
              let fullText = '';
              
              // ADICIONAR HEADER (se existir e tiver texto)
              if (headerComponent?.text) {
                fullText += headerComponent.text + '\n\n';
              }
              
              // ADICIONAR BODY (sempre obrigatório)
              if (bodyComponent?.text) {
                fullText += bodyComponent.text;
              }
              
              // Processar variáveis no texto
              templateText = processTemplateText(fullText, parameters);
              
              console.log('✅ [TEMPLATE TEXT] Texto processado:', templateText.substring(0, 100) + '...');
            }
          }
        }
      } catch (err) {
        console.warn('⚠️ [TEMPLATE TEXT] Erro ao buscar texto do template, usando nome:', err);
        // Manter templateText como templateName (fallback)
      }
      
      // Salvar mensagem no banco de dados
      const saveResult = await saveOutboundMessage({
        conversationId,
        type: 'template',
        body: templateText,  // ✅ Agora salva o texto processado ao invés apenas do nome
        providerMessageId: result.messageId,
        templateName: templateName,
        toPhoneE164: to
      });

      console.log('💾 Resultado do salvamento:', saveResult);
    }

    return c.json(result);

  } catch (error) {
    console.error('❌ [SEND TEMPLATE] Erro:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * POST /api/conversations/:id/move-to-base-fria
 * Move o lead vinculado à conversa para a Base Fria (tira da esteira do operador).
 * Usado quando o cliente não respondeu após os 3 templates (trava dura).
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.post("/make-server-844b77a1/api/conversations/:id/move-to-base-fria", authMiddleware, async (c) => {
  const conversationId = c.req.param('id');
  console.log('\n❄️ [BASE FRIA] Movendo lead da conversa', conversationId);

  try {
    // 1) Conversa → contact_id
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (convErr) return c.json({ success: false, error: convErr.message }, 500);
    if (!conv || !(conv as any).contact_id) {
      return c.json({ success: false, error: 'Conversa ou contato não encontrado' }, 404);
    }

    // 2) Lead pelo contato (ignora os que já estão em base_fria)
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('id, situacao')
      .eq('id_contact', (conv as any).contact_id)
      .neq('situacao', 'base_fria')
      .limit(1)
      .maybeSingle();

    if (leadErr) return c.json({ success: false, error: leadErr.message }, 500);
    if (!lead) {
      return c.json({ success: false, error: 'Nenhum lead ativo encontrado para este contato' }, 404);
    }

    // 3) Atualiza situacao + histórico
    const { error: updErr } = await supabaseAdmin
      .from('leads')
      .update({
        situacao: 'base_fria',
        motivo_cancelamento: 'Movido manualmente (sem resposta após templates)',
      })
      .eq('id', (lead as any).id);

    if (updErr) return c.json({ success: false, error: updErr.message }, 500);

    await supabaseAdmin.from('lead_history').insert({
      lead_id: (lead as any).id,
      field_changed: 'situacao',
      old_value: (lead as any).situacao,
      new_value: 'base_fria',
      changed_at: new Date().toISOString(),
    });

    console.log('✅ [BASE FRIA] Lead', (lead as any).id, 'movido para base_fria');
    return c.json({ success: true, leadId: (lead as any).id });
  } catch (error) {
    console.error('❌ [BASE FRIA] Erro:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    }, 500);
  }
});

/**
 * POST /api/whatsapp/send-text
 * Envia uma mensagem de texto simples
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.post("/make-server-844b77a1/api/whatsapp/send-text", authMiddleware, async (c) => {
  console.log('\n📤 [SEND TEXT] Recebendo requisição...');

  try {
    const body = await c.req.json();
    console.log('📦 Body recebido:', JSON.stringify(body, null, 2));

    const { to, message, conversationId } = body;

    if (!to) {
      return c.json({
        success: false,
        error: 'Campo "to" (número do destinatário) é obrigatório'
      }, 400);
    }

    if (!message) {
      return c.json({
        success: false,
        error: 'Campo "message" é obrigatório'
      }, 400);
    }

    console.log('📤 [SEND TEXT] Enviando mensagem de texto');
    console.log('- Para:', to);
    console.log('- Mensagem:', message);

    const result = await whatsapp.sendWhatsAppTextMessage(to, message);

    console.log('📡 Resposta da API do WhatsApp:', JSON.stringify(result, null, 2));

    if (result.success && conversationId) {
      // Salvar mensagem no banco de dados
      const saveResult = await saveOutboundMessage({
        conversationId,
        type: 'text',
        body: message,
        providerMessageId: result.messageId,
        toPhoneE164: to
      });

      console.log('💾 Resultado do salvamento:', saveResult);
    }

    return c.json(result);

  } catch (error) {
    console.error('❌ [SEND TEXT] Erro:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * POST /api/whatsapp/send-message
 * Envia uma mensagem de texto (alias para send-text)
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.post("/make-server-844b77a1/api/whatsapp/send-message", authMiddleware, async (c) => {
  console.log('\n📤 [SEND MESSAGE] Recebendo requisição...');

  try {
    const body = await c.req.json();
    console.log('📦 Body recebido:', JSON.stringify(body, null, 2));

    const { to, message, conversationId } = body;

    if (!to) {
      return c.json({
        success: false,
        error: 'Campo "to" (número do destinatário) é obrigatório'
      }, 400);
    }

    if (!message) {
      return c.json({
        success: false,
        error: 'Campo "message" é obrigatório'
      }, 400);
    }

    console.log('📤 [SEND MESSAGE] Enviando mensagem de texto');
    console.log('- Para:', to);
    console.log('- Mensagem:', message);

    const result = await whatsapp.sendWhatsAppTextMessage(to, message);

    console.log('📡 Resposta da API do WhatsApp:', JSON.stringify(result, null, 2));

    if (result.success && conversationId) {
      // Salvar mensagem no banco de dados
      const saveResult = await saveOutboundMessage({
        conversationId,
        type: 'text',
        body: message,
        providerMessageId: result.messageId,
        toPhoneE164: to
      });

      console.log('💾 Resultado do salvamento:', saveResult);
    }

    return c.json(result);

  } catch (error) {
    console.error('❌ [SEND MESSAGE] Erro:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * POST /api/whatsapp/send-media
 * Envia imagem, documento ou áudio via WhatsApp
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.post("/make-server-844b77a1/api/whatsapp/send-media", authMiddleware, async (c) => {
  console.log('\n📤 [SEND MEDIA] Recebendo requisição...');

  try {
    // Parse FormData
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const to = formData.get('to') as string;
    const conversationId = formData.get('conversationId') as string;
    const type = formData.get('type') as 'image' | 'document' | 'audio';
    const caption = formData.get('caption') as string || '';

    console.log('📦 Dados recebidos:');
    console.log('- Para:', to);
    console.log('- Tipo:', type);
    console.log('- Legenda:', caption);
    console.log('- Arquivo:', file ? file.name : 'N/A');
    console.log('- Tamanho:', file ? (file.size / 1024 / 1024).toFixed(2) + 'MB' : 'N/A');

    if (!file) {
      return c.json({
        success: false,
        error: 'Arquivo não fornecido'
      }, 400);
    }

    if (!to) {
      return c.json({
        success: false,
        error: 'Campo "to" (número do destinatário) é obrigatório'
      }, 400);
    }

    if (!type || (type !== 'image' && type !== 'document' && type !== 'audio')) {
      return c.json({
        success: false,
        error: 'Tipo deve ser "image", "document" ou "audio"'
      }, 400);
    }

    // 1️⃣ Fazer upload do arquivo para Supabase Storage
    console.log('📤 [SEND MEDIA] Fazendo upload para Supabase Storage...');
    
    const bucketName = 'make-844b77a1-whatsapp-media';
    
    // 🔧 Sanitizar nome do arquivo (remover espaços, acentos e caracteres especiais)
    const sanitizeFileName = (name: string): string => {
      return name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_|_$/g, '');
    };
    
    const sanitizedFileName = sanitizeFileName(file.name);
    const fileName = `${Date.now()}-${sanitizedFileName}`;
    const filePath = `${type}s/${fileName}`;
    
    console.log('📝 Nome do arquivo original:', file.name);
    console.log('📝 Nome do arquivo sanitizado:', fileName);
    console.log('📝 Caminho completo:', filePath);

    // Converter File para ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const { data: uploadData, error: uploadError } = await supabaseAdmin
      .storage
      .from(bucketName)
      .upload(filePath, uint8Array, {
        contentType: file.type,
        upsert: false
      });

    if (uploadError) {
      console.error('❌ Erro no upload:', uploadError);
      return c.json({
        success: false,
        error: `Erro ao fazer upload: ${uploadError.message}`
      }, 500);
    }

    console.log('✅ Upload concluído:', uploadData.path);

    // 2️⃣ Gerar URL pública do arquivo
    const { data: urlData } = await supabaseAdmin
      .storage
      .from(bucketName)
      .createSignedUrl(filePath, 31536000);

    if (!urlData?.signedUrl) {
      return c.json({
        success: false,
        error: 'Erro ao gerar URL do arquivo'
      }, 500);
    }

    const mediaUrl = urlData.signedUrl;
    console.log('🔗 URL gerada:', mediaUrl);

    // 3️⃣ Enviar para WhatsApp via API da Meta
    console.log(`📤 [SEND MEDIA] Enviando ${type} para WhatsApp...`);

    let result;
    if (type === 'image') {
      result = await whatsapp.sendWhatsAppImageMessage(to, mediaUrl, caption);
    } else if (type === 'audio') {
      console.log('🎤 [SEND MEDIA] Tipo detectado: ÁUDIO');
      console.log('🎤 [SEND MEDIA] URL do áudio:', mediaUrl);
      console.log('🎤 [SEND MEDIA] Destinatário:', to);
      result = await whatsapp.sendWhatsAppAudioMessage(to, mediaUrl);
    } else {
      result = await whatsapp.sendWhatsAppDocumentMessage(to, mediaUrl, file.name, caption);
    }

    console.log('📡 Resposta da API do WhatsApp:', JSON.stringify(result, null, 2));
    
    // Log específico para áudio
    if (type === 'audio') {
      console.log('🎤 [SEND MEDIA] Resultado do envio de áudio:');
      console.log('  - Success:', result.success);
      console.log('  - Message ID:', result.messageId);
      console.log('  - Error:', result.error || 'Nenhum');
      if (result.details) {
        console.log('  - Details:', JSON.stringify(result.details, null, 2));
      }
    }

    // ⚠️ SE O ENVIO PARA O WHATSAPP FALHOU, retornar erro imediatamente
    if (!result.success) {
      console.error('❌ [SEND MEDIA] Falha ao enviar para WhatsApp!');
      console.error('  - Error:', result.error);
      console.error('  - Details:', result.details);
      return c.json({
        success: false,
        error: result.error || 'Erro ao enviar para WhatsApp',
        details: result.details
      }, 500);
    }

    // 4️⃣ Salvar mensagem no banco
    if (result.success && conversationId) {
      console.log('💾 [SEND MEDIA] Salvando mensagem no banco...');
      console.log('  - Conversation ID:', conversationId);
      console.log('  - Type:', type);
      console.log('  - Media URL:', mediaUrl);
      console.log('  - Provider Message ID:', result.messageId);
      
      const saveResult = await saveOutboundMessage({
        conversationId,
        type,
        body: type === 'audio' ? mediaUrl : (caption || mediaUrl), // ✅ Para áudio, salvar URL no body (igual às mensagens inbound)
        providerMessageId: result.messageId,
        toPhoneE164: to
      });

      console.log('💾 Resultado do salvamento:', saveResult);
      
      if (!saveResult.success) {
        console.error('❌ [SEND MEDIA] Erro ao salvar no banco:', saveResult.error);
      } else {
        console.log('✅ [SEND MEDIA] Mensagem salva com sucesso no banco!');
      }
    } else {
      console.log('⚠️ [SEND MEDIA] Não salvando no banco:');
      console.log('  - result.success:', result.success);
      console.log('  - conversationId:', conversationId);
    }

    return c.json(result);

  } catch (error) {
    console.error('❌ [SEND MEDIA] Erro:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 💬 CONVERSATIONS API
// ========================================

/**
 * GET /api/conversations
 * Lista todas as conversas com dados relacionais
 * 🔐 FILTRO POR CARGO E UNIDADE:
 * - Atendente: vê apenas conversas atribuídas a ele
 * - Supervisor/Gerente: vê todas as conversas da unidade dele
 * 🚀 PAGINAÇÃO: Suporta limit e offset via query params
 * 🏷️ FILTRO POR TAG: Suporta tag_id via query param (server-side)
 * 🔍 BUSCA: Suporta search via query param (busca em mensagens e contatos)
 */
app.get("/make-server-844b77a1/api/conversations", async (c) => {
  const token = c.req.query('token');
  const limit = parseInt(c.req.query('limit') || '50', 10); // 🚀 Default: 50 conversas
  const offset = parseInt(c.req.query('offset') || '0', 10); // 🚀 Default: offset 0
  const tagId = c.req.query('tag_id') || null; // 🏷️ Filtro por tag (server-side)
  const search = c.req.query('search') || null; // 🔍 Busca por texto

  try {
    // 🔐 AUTENTICAÇÃO: Buscar usuário logado
    const userToken = c.req.header('X-User-Token');
    
    if (!userToken) {
      console.error('❌ [CONVERSATIONS] Token de usuário não fornecido');
      return c.json({
        success: false,
        error: 'Autenticação necessária'
      }, 401);
    }

    // Obter dados do usuário logado
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(userToken);
    
    if (userError || !user) {
      console.error('❌ [CONVERSATIONS] Erro ao obter usuário:', userError);
      return c.json({
        success: false,
        error: 'Token inválido ou expirado'
      }, 401);
    }

    const userId = user.id;
    console.log('\n👤 [CONVERSATIONS] Usuário logado:', userId);

    // 🔍 Buscar profile do usuário com cargo e unidade
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select(`
        id,
        nome,
        sobrenome,
        email,
        id_cargo,
        id_unidade,
        cargo:cargos!profiles_id_cargo_fkey(id, papeis)
      `)
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      console.error('❌ [CONVERSATIONS] Erro ao buscar profile:', profileError);
      return c.json({
        success: false,
        error: 'Perfil do usuário não encontrado'
      }, 404);
    }

    const cargo = profile.cargo?.papeis;
    const unidadeId = profile.id_unidade;

    console.log('📋 [CONVERSATIONS] Cargo do usuário:', cargo);
    console.log('🏢 [CONVERSATIONS] Unidade do usuário:', unidadeId);

    // 🔐 VERIFICAR CARGO E DEFINIR FILTROS
    if (cargo === 'Sem cargo' || !cargo) {
      console.log('🚫 [CONVERSATIONS] Usuário SEM CARGO - acesso negado');
      return c.json({
        success: true,
        conversations: [],
        total: 0,
        message: 'Usuário sem permissão de acesso às conversas'
      });
    }

    if (['Atendente', 'Supervisor', 'Gerente'].includes(cargo) && !unidadeId) {
      console.warn('⚠️ [CONVERSATIONS] Usuário sem unidade definida');
      return c.json({
        success: false,
        error: 'Usuário sem unidade definida'
      }, 400);
    }

    if (!['Atendente', 'Supervisor', 'Gerente', 'Administrador'].includes(cargo)) {
      console.error('❌ [CONVERSATIONS] Cargo desconhecido:', cargo);
      return c.json({
        success: false,
        error: 'Cargo não reconhecido no sistema'
      }, 403);
    }

    // Helper: Atendente, Supervisor e Gerente veem todas as conversas da unidade
    function applyRoleFilter(query: any) {
      if (cargo === 'Atendente' || cargo === 'Supervisor' || cargo === 'Gerente') {
        return query.eq('unit_id', unidadeId);
      }
      return query; // Administrador: sem filtro
    }

    // 🏷️ FILTRO POR TAG (server-side): buscar IDs de conversas com a tag
    let tagConversationIds: string[] | null = null;
    if (tagId) {
      const { data: tagConvs } = await supabaseAdmin
        .from('conversation_tags')
        .select('conversation_id')
        .eq('tag_id', tagId);

      tagConversationIds = tagConvs?.map(tc => tc.conversation_id) || [];

      if (tagConversationIds.length === 0) {
        console.log(`🏷️ [CONVERSATIONS] Nenhuma conversa com tag_id=${tagId}`);
        return c.json({
          success: true,
          conversations: [],
          total: 0,
          limit,
          offset,
          hasMore: false
        });
      }
    }

    // 🔍 BUSCA POR TEXTO: buscar IDs de conversas que contêm o termo
    let searchConversationIds: string[] | null = null;
    if (search && search.trim().length >= 2) {
      const searchTerm = `%${search.trim()}%`;

      // Buscar em mensagens (body)
      const { data: messageMatches } = await supabaseAdmin
        .from('messages')
        .select('conversation_id')
        .ilike('body', searchTerm);

      // Buscar em contatos (display_name, first_name, last_name, phone_number, wa_id)
      const { data: contactMatches } = await supabaseAdmin
        .from('contacts')
        .select('id')
        .or(`display_name.ilike.${searchTerm},first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},phone_number.ilike.${searchTerm},wa_id.ilike.${searchTerm}`);

      const messageConvIds = new Set(messageMatches?.map(m => m.conversation_id) || []);

      // Buscar conversas dos contatos encontrados
      if (contactMatches && contactMatches.length > 0) {
        const contactIds = contactMatches.map(c => c.id);
        const { data: contactConvs } = await supabaseAdmin
          .from('conversations')
          .select('id')
          .in('contact_id', contactIds);

        contactConvs?.forEach(cc => messageConvIds.add(cc.id));
      }

      searchConversationIds = Array.from(messageConvIds);

      if (searchConversationIds.length === 0) {
        console.log(`🔍 [CONVERSATIONS] Nenhuma conversa encontrada para search="${search}"`);
        return c.json({
          success: true,
          conversations: [],
          total: 0,
          limit,
          offset,
          hasMore: false
        });
      }
    }

    // Combinar filtros de tag e search (interseção)
    let filteredIds: string[] | null = null;
    if (tagConversationIds && searchConversationIds) {
      const tagSet = new Set(tagConversationIds);
      filteredIds = searchConversationIds.filter(id => tagSet.has(id));
      if (filteredIds.length === 0) {
        return c.json({ success: true, conversations: [], total: 0, limit, offset, hasMore: false });
      }
    } else if (tagConversationIds) {
      filteredIds = tagConversationIds;
    } else if (searchConversationIds) {
      filteredIds = searchConversationIds;
    }

    // Helper: aplicar filtro de IDs (tag + search)
    function applyIdFilter(query: any) {
      if (filteredIds) {
        return query.in('id', filteredIds);
      }
      return query;
    }

    // 🚀 QUERY 1: Contar total (query independente)
    const countQuery = applyIdFilter(applyRoleFilter(
      supabaseAdmin.from('conversations').select('*', { count: 'exact', head: true })
    ));
    const { count: totalCount } = await countQuery;

    console.log(`📊 [CONVERSATIONS] Total disponível: ${totalCount}, Limit: ${limit}, Offset: ${offset}${tagId ? `, Tag: ${tagId}` : ''}${search ? `, Search: "${search}"` : ''}`);

    // 🚀 QUERY 2: Buscar dados paginados (query independente)
    const dataQuery = applyIdFilter(applyRoleFilter(
      supabaseAdmin.from('conversations').select(`
        *,
        contact:contacts(*),
        assigned_user:profiles(*),
        unit:units(*)
      `)
    ))
      .order('last_message_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: conversations, error: conversationsError } = await dataQuery;

    if (conversationsError) {
      console.error('❌ Erro ao buscar conversas:', conversationsError);
      return c.json({
        success: false,
        error: conversationsError.message
      }, 500);
    }

    // Filtrar conversas sem contato (proteção)
    const validConversations = conversations?.filter(conv => conv.contact) || [];

    if (validConversations.length !== conversations?.length) {
      const orphanCount = (conversations?.length || 0) - validConversations.length;
      console.warn(`⚠️ ${orphanCount} conversa(s) órfãs ignoradas`);
    }

    // 🔥 OTIMIZAÇÃO: Batch queries em vez de N+1
    const convIds = validConversations.map(conv => conv.id);

    // Batch: última mensagem de cada conversa (1 query em vez de 50)
    let lastMessagesByConvId: Record<string, any> = {};
    if (convIds.length > 0) {
      // 🔥 FIX: PostgrestFilterBuilder em supabase-js v2 não é Promise — não tem .catch().
      //         Tratar erros via { error } do retorno em vez de .catch().
      const rpcResult = await supabaseAdmin.rpc('get_last_messages_batch', {
        conv_ids: convIds
      });
      const allLastMessages = rpcResult?.error ? null : rpcResult.data;

      // Fallback: se a RPC não existir, usar query manual otimizada
      if (!allLastMessages) {
        const { data: messagesData } = await supabaseAdmin
          .from('messages')
          .select('conversation_id, body, type, direction, sent_at')
          .in('conversation_id', convIds)
          .order('sent_at', { ascending: false });

        if (messagesData) {
          // Pegar apenas a primeira (mais recente) de cada conversa
          for (const msg of messagesData) {
            if (!lastMessagesByConvId[msg.conversation_id]) {
              lastMessagesByConvId[msg.conversation_id] = msg;
            }
          }
        }
      } else {
        for (const msg of allLastMessages) {
          lastMessagesByConvId[msg.conversation_id] = msg;
        }
      }
    }

    // Batch: mensagens recentes para contagem de pendentes (1 query em vez de 50)
    let pendingCountByConvId: Record<string, number> = {};
    if (convIds.length > 0) {
      const { data: recentMsgs } = await supabaseAdmin
        .from('messages')
        .select('conversation_id, direction, sent_at')
        .in('conversation_id', convIds)
        .order('sent_at', { ascending: false })
        .limit(convIds.length * 20); // 20 mensagens por conversa (máximo)

      if (recentMsgs) {
        // Agrupar por conversa e calcular pendentes
        const msgsByConv: Record<string, { direction: string }[]> = {};
        for (const msg of recentMsgs) {
          if (!msgsByConv[msg.conversation_id]) msgsByConv[msg.conversation_id] = [];
          if (msgsByConv[msg.conversation_id].length < 20) {
            msgsByConv[msg.conversation_id].push(msg);
          }
        }

        for (const [convId, msgs] of Object.entries(msgsByConv)) {
          let count = 0;
          for (const msg of msgs) {
            if (msg.direction === 'inbound') count++;
            else if (msg.direction === 'outbound') break;
          }
          pendingCountByConvId[convId] = count;
        }
      }
    }

    // Montar resultado final com metadata
    const conversationsWithMetadata = validConversations.map(conv => {
      const lastMessage = lastMessagesByConvId[conv.id];
      return {
        ...conv,
        last_message_preview: lastMessage?.body || 'Sem mensagens',
        last_message_type: lastMessage?.type || 'text',
        pending_messages_count: pendingCountByConvId[conv.id] || 0
      };
    });

    console.log(`✅ [CONVERSATIONS] Retornando ${conversationsWithMetadata.length} conversas (de ${totalCount} total) para ${cargo}`);

    return c.json({
      success: true,
      conversations: conversationsWithMetadata,
      total: totalCount || 0,
      limit: limit,
      offset: offset,
      hasMore: (offset + conversationsWithMetadata.length) < (totalCount || 0)
    });

  } catch (error) {
    console.error('❌ Exceção ao buscar conversas:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * GET /api/conversations/:id/messages
 * Lista mensagens de uma conversa
 */
app.get("/make-server-844b77a1/api/conversations/:id/messages", async (c) => {
  const conversationId = c.req.param('id');
  console.log('\n📨 [MESSAGES] Buscando mensagens da conversa:', conversationId);

  try {
    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true });

    if (error) {
      console.error('❌ Erro ao buscar mensagens:', error);
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }

    console.log(`✅ ${messages.length} mensagens encontradas`);

    return c.json({
      success: true,
      messages,
      total: messages.length
    });

  } catch (error) {
    console.error('❌ Exceção ao buscar mensagens:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * POST /api/conversations/create
 * Cria uma nova conversa para um contato
 */
app.post("/make-server-844b77a1/api/conversations/create", async (c) => {
  console.log('\n💬 [CREATE CONVERSATION] Criando nova conversa...');

  try {
    const body = await c.req.json();
    const { contact_id, assigned_user_id, token } = body;

    console.log('📋 Dados recebidos:');
    console.log('- contact_id:', contact_id);
    console.log('- assigned_user_id:', assigned_user_id);
    console.log('- token presente?', !!token);

    // Validar dados obrigatórios
    if (!contact_id) {
      return c.json({
        success: false,
        error: 'contact_id é obrigatório'
      }, 400);
    }

    // Verificar se o contato existe
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts')
      .select('*')
      .eq('id', contact_id)
      .single();

    if (contactError || !contact) {
      console.error('❌ Contato não encontrado:', contactError);
      return c.json({
        success: false,
        error: 'Contato não encontrado'
      }, 404);
    }

    console.log('✅ Contato encontrado:', contact.display_name);

    // Verificar se já existe conversa para este contato
    const { data: existingConv } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('contact_id', contact_id)
      .single();

    if (existingConv) {
      console.log('⚠️ Conversa já existe:', existingConv.id);
      return c.json({
        success: true,
        conversation: existingConv,
        message: 'Conversa já existe'
      });
    }

    // Criar nova conversa
    const newConversation = {
      contact_id,
      status: 'open',
      assigned_user_id: assigned_user_id || null,
      assigned_at: assigned_user_id ? new Date().toISOString() : null,
      unit_id: contact.unit_id || null,
      last_message_at: new Date().toISOString(),
      last_message_preview: 'Conversa iniciada'
    };

    console.log('📝 Criando conversa com dados:', newConversation);

    const { data: conversation, error: createError } = await supabaseAdmin
      .from('conversations')
      .insert(newConversation)
      .select()
      .single();

    if (createError) {
      console.error('❌ Erro ao criar conversa:', createError);
      return c.json({
        success: false,
        error: createError.message
      }, 500);
    }

    console.log('✅ Conversa criada com sucesso:', conversation.id);

    return c.json({
      success: true,
      conversation,
      message: 'Conversa criada com sucesso'
    });

  } catch (error) {
    console.error('❌ Exceção ao criar conversa:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * PATCH /api/conversations/:id/assign
 * Atribui uma conversa a um atendente
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.patch("/make-server-844b77a1/api/conversations/:id/assign", authMiddleware, async (c) => {
  console.log('\n👤 [ASSIGN CONVERSATION] Atribuindo conversa...');

  try {
    const conversationId = c.req.param('id');
    const body = await c.req.json();
    const { assigned_user_id, reason } = body;

    // Obter usuário logado do contexto (quem está fazendo a atribuição)
    const assignedByUserId = c.get('userId');

    console.log('📋 Dados recebidos:');
    console.log('- conversation_id:', conversationId);
    console.log('- assigned_user_id:', assigned_user_id);
    console.log('- assigned_by_user_id:', assignedByUserId);
    console.log('- reason:', reason);

    // Validar: assigned_user_id pode ser null (desatribuição) ou UUID (atribuição)
    // Apenas validar que o campo foi enviado no body
    if (assigned_user_id === undefined) {
      return c.json({
        success: false,
        error: 'assigned_user_id é obrigatório (use null para desatribuir)'
      }, 400);
    }

    const isUnassign = assigned_user_id === null;
    console.log(`📋 [ASSIGN] Operação: ${isUnassign ? 'DESATRIBUIÇÃO' : 'ATRIBUIÇÃO'}`);

    // 1️⃣ PATCH na tabela conversations
    console.log('📝 [1/3] Atualizando conversa...');
    const conversationUpdateData: any = {
      assigned_user_id: assigned_user_id,
      updated_at: new Date().toISOString()
    };
    if (!isUnassign) {
      conversationUpdateData.assigned_at = new Date().toISOString();
    }

    const { data: updatedConversation, error: updateError } = await supabaseAdmin
      .from('conversations')
      .update(conversationUpdateData)
      .eq('id', conversationId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Erro ao atualizar conversa:', updateError);
      return c.json({
        success: false,
        error: updateError.message
      }, 500);
    }

    console.log('✅ Conversa atualizada com sucesso');

    // 2️⃣ PATCH no contato vinculado — atualizar id_profile_responsavel
    // Só atualiza quando é ATRIBUIÇÃO (não desatribuição)
    let contactUpdated = false;
    if (!isUnassign && updatedConversation.contact_id) {
      console.log('📝 [2/3] Atualizando responsável do contato...');
      console.log('- Contact ID:', updatedConversation.contact_id);
      console.log('- Novo responsável:', assigned_user_id);

      const { error: contactUpdateError } = await supabaseAdmin
        .from('contacts')
        .update({
          id_profile_responsavel: assigned_user_id,
          updated_at: new Date().toISOString()
        })
        .eq('id', updatedConversation.contact_id);

      if (contactUpdateError) {
        console.error('⚠️ Erro ao atualizar responsável do contato:', contactUpdateError);
        console.warn('⚠️ Conversa atribuída, mas contato NÃO foi transferido');
      } else {
        contactUpdated = true;
        console.log('✅ Responsável do contato atualizado com sucesso');
      }
    } else if (isUnassign) {
      console.log('ℹ️ [2/3] Desatribuição: responsável do contato mantido (não alterado)');
    } else {
      console.warn('⚠️ [2/3] Conversa sem contact_id — contato não foi atualizado');
    }

    // 3️⃣ INSERT na tabela conversation_assignments (histórico)
    console.log('📝 [3/3] Registrando histórico de atribuição...');
    const assignmentData = {
      conversation_id: conversationId,
      assigned_user_id: assigned_user_id,
      assigned_by_user_id: assignedByUserId,
      assigned_at: new Date().toISOString(),
      reason: reason || null
    };

    const { data: assignment, error: assignmentError } = await supabaseAdmin
      .from('conversation_assignments')
      .insert(assignmentData)
      .select()
      .single();

    if (assignmentError) {
      console.error('❌ Erro ao registrar histórico:', assignmentError);
      // Não falhamos a requisição por causa do histórico
      console.warn('⚠️ Atribuição concluída, mas histórico não foi registrado');
    } else {
      console.log('✅ Histórico registrado com sucesso:', assignment.id);
    }

    return c.json({
      success: true,
      conversation: updatedConversation,
      assignment: assignment || null,
      contactUpdated,
      message: isUnassign 
        ? 'Conversa desatribuída com sucesso' 
        : `Conversa atribuída com sucesso${contactUpdated ? ' (contato transferido)' : ''}`
    });

  } catch (error) {
    console.error('❌ Exceção ao atribuir conversa:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 👥 CONTACTS API
// ========================================

/**
 * GET /api/contacts
 * Lista contatos com filtros baseados em cargo/unidade
 * 🔐 FILTRO POR CARGO E UNIDADE:
 * - Atendente: vê apenas contatos criados por ele
 * - Supervisor/Gerente: vê todos os contatos da unidade dele
 * - Sem cargo: não vê nada
 */
app.get("/make-server-844b77a1/api/contacts", async (c) => {
  // 🚀 Paginação server-side + filtros (search, unit_id, situation) server-side.
  // Default 50 por página, máximo 100. RBAC aplicado (atendente/sup/gerente
  // forçados pra unidade deles; admin pode escolher unit_id ou ver tudo).
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10), 1), 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);
  const search = (c.req.query('search') || '').trim();
  const unitIdParam = (c.req.query('unit_id') || '').trim();
  const situationParam = (c.req.query('situation') || '').trim();

  try {
    const userToken = c.req.header('X-User-Token');
    if (!userToken) {
      return c.json({ success: false, error: 'Autenticação necessária' }, 401);
    }

    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(userToken);
    if (userError || !user) {
      return c.json({ success: false, error: 'Token inválido ou expirado' }, 401);
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select(`id, id_unidade, cargo:cargos!profiles_id_cargo_fkey(id, papeis)`)
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return c.json({ success: false, error: 'Perfil não encontrado' }, 404);
    }

    const cargo = (profile.cargo as any)?.papeis;
    const unidadeId = profile.id_unidade;

    if (cargo === 'Sem cargo' || !cargo) {
      return c.json({ success: true, contacts: [], total: 0, limit, offset, hasMore: false });
    }

    // RBAC: define o unit_id que será aplicado (cliente não pode bypassar)
    let effectiveUnitId: string | null = null;
    if (cargo === 'Atendente' || cargo === 'Supervisor' || cargo === 'Gerente') {
      if (!unidadeId) {
        return c.json({ success: false, error: `${cargo} sem unidade definida` }, 400);
      }
      effectiveUnitId = String(unidadeId);
    } else if (cargo === 'Administrador') {
      // Admin pode filtrar por uma unidade específica via query param, ou ver tudo
      if (unitIdParam && unitIdParam !== 'all') {
        effectiveUnitId = unitIdParam;
      }
    } else {
      return c.json({ success: false, error: 'Cargo não reconhecido' }, 403);
    }

    // Monta a query com todos os filtros server-side + count exato
    let query = supabaseAdmin
      .from('contacts')
      .select('*', { count: 'exact' });

    if (effectiveUnitId) {
      query = query.eq('unit_id', effectiveUnitId);
    }
    if (situationParam && situationParam !== 'all') {
      query = query.eq('situation', situationParam);
    }
    if (search.length > 0) {
      const pattern = `%${search}%`;
      query = query.or(
        `display_name.ilike.${pattern},first_name.ilike.${pattern},last_name.ilike.${pattern},phone_number.ilike.${pattern},wa_id.ilike.${pattern}`
      );
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('❌ [CONTACTS] Erro:', error);
      return c.json({ success: false, error: error.message }, 500);
    }

    const returned = data || [];
    const total = count || 0;
    const hasMore = offset + returned.length < total;

    console.log(
      `✅ [CONTACTS] ${returned.length}/${total} ` +
      `(offset=${offset}, search="${search}", unit=${effectiveUnitId ?? 'all'}, ` +
      `situation=${situationParam || 'all'}) para ${cargo}`,
    );

    return c.json({
      success: true,
      contacts: returned,
      total,
      limit,
      offset,
      hasMore,
    });
  } catch (error) {
    console.error('❌ [CONTACTS] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
    }, 500);
  }
});

// ========================================
// 🗑️ DELETE CONTACT
// ========================================

/**
 * DELETE /api/contacts/:contactId
 * Exclui um contato e todos os dados relacionados (cascata)
 * 🔐 PROTEGIDO - Requer autenticação + cargo Supervisor+
 * 
 * Ordem de exclusão (respeitando FKs):
 * 1. message_status_events (FK → messages)
 * 2. messages (FK → conversations)
 * 3. conversation_tags (FK → conversations)
 * 4. scheduled_callbacks (FK → conversations)
 * 5. contact_notes (FK → contacts)
 * 6. conversations (FK → contacts)
 * 7. contacts
 */
app.delete("/make-server-844b77a1/api/contacts/:contactId", authMiddleware, async (c) => {
  const contactId = c.req.param('contactId');
  const userId = c.get('userId');

  console.log('\n🗑️ [DELETE CONTACT] Iniciando exclusão...');
  console.log('- Contact ID:', contactId);
  console.log('- User ID:', userId);

  try {
    // 1. Verificar permissão (Supervisor+)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select(`id, id_cargo, id_unidade, cargo:cargos!profiles_id_cargo_fkey(id, papeis)`)
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      console.error('❌ [DELETE CONTACT] Perfil não encontrado:', profileError);
      return c.json({ success: false, error: 'Perfil do usuário não encontrado' }, 403);
    }

    const cargoName = (profile.cargo as any)?.papeis?.toLowerCase() || '';
    const isSupervisorPlus = ['supervisor', 'gerente', 'administrador'].some(r => cargoName.includes(r));

    if (!isSupervisorPlus) {
      console.error('❌ [DELETE CONTACT] Permissão negada. Cargo:', cargoName);
      return c.json({ success: false, error: 'Apenas Supervisores, Gerentes e Administradores podem excluir contatos' }, 403);
    }

    // 2. Verificar se o contato existe
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts')
      .select('id, display_name, phone_number, unit_id')
      .eq('id', contactId)
      .single();

    if (contactError || !contact) {
      console.error('❌ [DELETE CONTACT] Contato não encontrado:', contactError);
      return c.json({ success: false, error: 'Contato não encontrado' }, 404);
    }

    console.log('✅ Contato encontrado:', contact.display_name, contact.phone_number);

    // 3. Buscar conversations do contato
    const { data: conversations } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId);

    const conversationIds = (conversations || []).map((cv: any) => cv.id);
    console.log(`📋 ${conversationIds.length} conversas vinculadas`);

    if (conversationIds.length > 0) {
      // 3a. Buscar messages das conversations
      const { data: messages } = await supabaseAdmin
        .from('messages')
        .select('id')
        .in('conversation_id', conversationIds);

      const messageIds = (messages || []).map((m: any) => m.id);

      // 3b. Excluir message_status_events
      if (messageIds.length > 0) {
        const { error: mseError } = await supabaseAdmin
          .from('message_status_events')
          .delete()
          .in('message_id', messageIds);
        if (mseError) console.warn('⚠️ Erro ao excluir message_status_events:', mseError.message);
        else console.log(`🗑️ message_status_events excluídos (${messageIds.length} msgs)`);
      }

      // 3c. Excluir messages
      const { error: msgError } = await supabaseAdmin
        .from('messages')
        .delete()
        .in('conversation_id', conversationIds);
      if (msgError) console.warn('⚠️ Erro ao excluir messages:', msgError.message);
      else console.log('🗑️ messages excluídas');

      // 3d. Excluir conversation_tags
      const { error: ctError } = await supabaseAdmin
        .from('conversation_tags')
        .delete()
        .in('conversation_id', conversationIds);
      if (ctError) console.warn('⚠️ Erro ao excluir conversation_tags:', ctError.message);
      else console.log('🗑️ conversation_tags excluídas');

      // 3e. Excluir scheduled_callbacks
      const { error: scError } = await supabaseAdmin
        .from('scheduled_callbacks')
        .delete()
        .in('conversation_id', conversationIds);
      if (scError) console.warn('⚠️ Erro ao excluir scheduled_callbacks:', scError.message);
      else console.log('🗑️ scheduled_callbacks excluídos');

      // 3f. Excluir conversations
      const { error: convError } = await supabaseAdmin
        .from('conversations')
        .delete()
        .eq('contact_id', contactId);
      if (convError) {
        console.error('❌ Erro ao excluir conversations:', convError);
        return c.json({ success: false, error: 'Erro ao excluir conversas: ' + convError.message }, 500);
      }
      console.log('🗑️ conversations excluídas');
    }

    // 4. Excluir contact_notes
    const { error: notesError } = await supabaseAdmin
      .from('contact_notes')
      .delete()
      .eq('contact_id', contactId);
    if (notesError) console.warn('⚠️ Erro ao excluir contact_notes:', notesError.message);
    else console.log('🗑️ contact_notes excluídas');

    // 5. Excluir o contato
    const { error: deleteError } = await supabaseAdmin
      .from('contacts')
      .delete()
      .eq('id', contactId);

    if (deleteError) {
      console.error('❌ Erro ao excluir contato:', deleteError);
      return c.json({ success: false, error: 'Erro ao excluir contato: ' + deleteError.message }, 500);
    }

    console.log(`✅ [DELETE CONTACT] Contato "${contact.display_name}" excluído com sucesso por usuário ${userId}`);

    return c.json({
      success: true,
      message: `Contato "${contact.display_name}" excluído com sucesso`,
      deleted: {
        contact: contactId,
        conversations: conversationIds.length,
      }
    });

  } catch (error) {
    console.error('❌ [DELETE CONTACT] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido ao excluir contato'
    }, 500);
  }
});

// ========================================
// 📅 SCHEDULED CALLBACKS - AGENDAMENTO DE RETORNO
// ========================================

/**
 * POST /api/callbacks/schedule
 * Cria um novo agendamento de retorno de contato
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.post("/make-server-844b77a1/api/callbacks/schedule", authMiddleware, async (c) => {
  console.log('\n📅 [SCHEDULE CALLBACK] Criando agendamento...');

  try {
    const body = await c.req.json();
    const { conversationId, scheduledAt, notes } = body;
    const userId = c.get('userId');

    console.log('📦 Body recebido:', JSON.stringify(body, null, 2));
    console.log('👤 User ID:', userId);

    // Validações
    if (!conversationId) {
      return c.json({
        success: false,
        error: 'Campo "conversationId" é obrigatório'
      }, 400);
    }

    if (!scheduledAt) {
      return c.json({
        success: false,
        error: 'Campo "scheduledAt" (data/hora do agendamento) é obrigatório'
      }, 400);
    }

    // Validar se a data é no futuro
    const scheduledDate = new Date(scheduledAt);
    const now = new Date();
    
    if (scheduledDate <= now) {
      return c.json({
        success: false,
        error: 'A data/hora do agendamento deve ser no futuro'
      }, 400);
    }

    // Verificar se a conversa existe
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id, contact_id, contacts(phone_number, wa_id, display_name)')
      .eq('id', conversationId)
      .single();

    if (convError || !conversation) {
      console.error('❌ Conversa não encontrada:', convError);
      return c.json({
        success: false,
        error: 'Conversa não encontrada'
      }, 404);
    }

    console.log('✅ Conversa encontrada:', conversation);

    // Criar agendamento
    const { data: callback, error: callbackError } = await supabaseAdmin
      .from('scheduled_callbacks')
      .insert({
        conversation_id: conversationId,
        scheduled_at: scheduledAt,
        template_id: 'retornar_contato',
        template_variables: {},
        status: 'pending',
        created_by: userId,
        notes: notes || null
      })
      .select()
      .single();

    if (callbackError) {
      console.error('❌ Erro ao criar agendamento:', callbackError);
      return c.json({
        success: false,
        error: `Erro ao criar agendamento: ${callbackError.message}`
      }, 500);
    }

    console.log('✅ Agendamento criado com sucesso!');
    console.log('- ID:', callback.id);
    console.log('- Agendado para:', callback.scheduled_at);

    return c.json({
      success: true,
      callback
    });

  } catch (error) {
    console.error('❌ Exceção ao criar agendamento:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * GET /api/callbacks/conversation/:conversationId
 * Lista agendamentos de uma conversa específica
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.get("/make-server-844b77a1/api/callbacks/conversation/:conversationId", authMiddleware, async (c) => {
  const conversationId = c.req.param('conversationId');
  
  console.log('\n📅 [LIST CALLBACKS] Listando agendamentos da conversa:', conversationId);

  try {
    const { data: callbacks, error } = await supabaseAdmin
      .from('scheduled_callbacks')
      .select(`
        *,
        created_by_profile:profiles!scheduled_callbacks_created_by_fkey(id, nome, sobrenome, email)
      `)
      .eq('conversation_id', conversationId)
      .order('scheduled_at', { ascending: true });

    if (error) {
      console.error('❌ Erro ao buscar agendamentos:', error);
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }

    console.log(`✅ ${callbacks?.length || 0} agendamentos encontrados`);

    return c.json({
      success: true,
      callbacks: callbacks || []
    });

  } catch (error) {
    console.error('❌ Exceção ao listar agendamentos:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * POST /api/callbacks/process
 * Processa agendamentos pendentes que chegaram na hora
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.post("/make-server-844b77a1/api/callbacks/process", authMiddleware, async (c) => {
  console.log('\n⏰ [PROCESS CALLBACKS] Processando agendamentos pendentes...');

  try {
    const now = new Date().toISOString();

    // Buscar agendamentos pendentes que já chegaram na hora
    const { data: callbacks, error: fetchError } = await supabaseAdmin
      .from('scheduled_callbacks')
      .select(`
        *,
        conversation:conversations(
          id,
          contact_id,
          contact:contacts(phone_number, wa_id, display_name)
        )
      `)
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true });

    if (fetchError) {
      console.error('❌ Erro ao buscar agendamentos:', fetchError);
      return c.json({
        success: false,
        error: fetchError.message
      }, 500);
    }

    console.log(`📋 ${callbacks?.length || 0} agendamentos pendentes encontrados`);

    if (!callbacks || callbacks.length === 0) {
      return c.json({
        success: true,
        processed: 0,
        message: 'Nenhum agendamento pendente no momento'
      });
    }

    const results = [];

    // Processar cada agendamento
    for (const callback of callbacks) {
      console.log(`\n📤 Processando agendamento ${callback.id}...`);
      console.log('- Conversa:', callback.conversation_id);
      console.log('- Template:', callback.template_id);
      console.log('- Agendado para:', callback.scheduled_at);

      try {
        // Obter telefone do contato
        const phoneNumber = callback.conversation?.contact?.phone_number || 
                          callback.conversation?.contact?.wa_id;

        if (!phoneNumber) {
          throw new Error('Telefone do contato não encontrado');
        }

        console.log('📞 Telefone do contato:', phoneNumber);

        // Enviar template WhatsApp
        const sendResult = await whatsapp.sendWhatsAppTemplate({
          to: phoneNumber,
          templateName: callback.template_id,
          languageCode: 'pt_BR',
          components: []
        });

        if (!sendResult.success) {
          throw new Error(sendResult.error || 'Erro ao enviar template');
        }

        console.log('✅ Template enviado com sucesso!');
        console.log('- Message ID:', sendResult.messageId);

        // Buscar texto completo do template para salvar no banco
        let templateText = callback.template_id;
        
        try {
          const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
          const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';
          
          if (metaAccessToken && wabaId) {
            const templateResponse = await fetch(
              `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${callback.template_id}&language=pt_BR`,
              {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${metaAccessToken}`
                }
              }
            );
            
            if (templateResponse.ok) {
              const templateData = await templateResponse.json();
              
              if (templateData.data && templateData.data.length > 0) {
                const template = templateData.data[0];
                const bodyComponent = template.components?.find((c: any) => c.type === 'BODY');
                const headerComponent = template.components?.find((c: any) => c.type === 'HEADER');
                
                let fullText = '';
                
                if (headerComponent?.text) {
                  fullText += headerComponent.text + '\n\n';
                }
                
                if (bodyComponent?.text) {
                  fullText += bodyComponent.text;
                }
                
                templateText = fullText || callback.template_id;
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ Erro ao buscar texto do template, usando nome:', err);
        }

        // Salvar mensagem no banco de dados
        const saveResult = await saveOutboundMessage({
          conversationId: callback.conversation_id.toString(),
          type: 'template',
          body: templateText,
          providerMessageId: sendResult.messageId,
          templateName: callback.template_id,
          toPhoneE164: phoneNumber
        });

        if (!saveResult.success) {
          console.warn('⚠️ Template enviado mas erro ao salvar no banco:', saveResult.error);
        }

        // Atualizar status do agendamento para 'sent'
        const { error: updateError } = await supabaseAdmin
          .from('scheduled_callbacks')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString()
          })
          .eq('id', callback.id);

        if (updateError) {
          console.error('⚠️ Erro ao atualizar status do agendamento:', updateError);
        }

        results.push({
          callbackId: callback.id,
          success: true,
          messageId: sendResult.messageId
        });

      } catch (error) {
        console.error(`❌ Erro ao processar agendamento ${callback.id}:`, error);

        // Marcar agendamento como failed
        await supabaseAdmin
          .from('scheduled_callbacks')
          .update({
            status: 'failed',
            error_message: error instanceof Error ? error.message : 'Erro desconhecido'
          })
          .eq('id', callback.id);

        results.push({
          callbackId: callback.id,
          success: false,
          error: error instanceof Error ? error.message : 'Erro desconhecido'
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    console.log(`\n✅ Processamento concluído!`);
    console.log(`- Sucesso: ${successCount}`);
    console.log(`- Falhas: ${failedCount}`);

    return c.json({
      success: true,
      processed: results.length,
      successCount,
      failedCount,
      results
    });

  } catch (error) {
    console.error('❌ Exceção ao processar agendamentos:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * DELETE /api/callbacks/cancel/:id
 * Cancela um agendamento
 * 🔐 PROTEGIDO - Requer autenticação
 */
app.delete("/make-server-844b77a1/api/callbacks/cancel/:id", authMiddleware, async (c) => {
  const callbackId = c.req.param('id');
  
  console.log('\n🗑️ [CANCEL CALLBACK] Cancelando agendamento:', callbackId);

  try {
    // Verificar se o agendamento existe e está pendente
    const { data: callback, error: fetchError } = await supabaseAdmin
      .from('scheduled_callbacks')
      .select('*')
      .eq('id', callbackId)
      .single();

    if (fetchError || !callback) {
      return c.json({
        success: false,
        error: 'Agendamento não encontrado'
      }, 404);
    }

    if (callback.status !== 'pending') {
      return c.json({
        success: false,
        error: `Não é possível cancelar agendamento com status "${callback.status}"`
      }, 400);
    }

    // Atualizar status para cancelled
    const { error: updateError } = await supabaseAdmin
      .from('scheduled_callbacks')
      .update({ status: 'cancelled' })
      .eq('id', callbackId);

    if (updateError) {
      console.error('❌ Erro ao cancelar agendamento:', updateError);
      return c.json({
        success: false,
        error: updateError.message
      }, 500);
    }

    console.log('✅ Agendamento cancelado com sucesso!');

    return c.json({
      success: true,
      message: 'Agendamento cancelado com sucesso'
    });

  } catch (error) {
    console.error('❌ Exceção ao cancelar agendamento:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * GET /api/units
 * Lista todas as unidades (para dropdown no formulário de contato)
 * PÚBLICO - Não requer autenticação
 */
app.get("/make-server-844b77a1/api/units", async (c) => {
  console.log('\n🏢 [UNITS] Buscando unidades...');

  try {
    const { data: units, error } = await supabaseAdmin
      .from('units')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('❌ Erro ao buscar unidades:', error);
      
      // Se a tabela não existe, retornar array vazio (não bloquear o formulário)
      if (error.message?.includes('does not exist') || error.code === '42P01') {
        console.log('⚠️ Tabela "units" não encontrada, retornando lista vazia');
        return c.json({
          success: true,
          units: [],
          total: 0,
          message: 'Tabela de unidades não configurada'
        });
      }
      
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }

    console.log(`✅ ${units?.length || 0} unidades encontradas`);

    return c.json({
      success: true,
      units: units || [],
      total: units?.length || 0
    });

  } catch (error) {
    console.error('❌ Exceção ao buscar unidades:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * GET /api/tags
 * Lista todas as tags disponíveis (para dropdown no formulário de contato)
 * PÚBLICO - Não requer autenticação
 */
app.get("/make-server-844b77a1/api/tags", async (c) => {
  console.log('\n🏷️ [TAGS] Buscando tags...');

  try {
    const { data: tags, error } = await supabaseAdmin
      .from('tags')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('❌ Erro ao buscar tags:', error);
      
      // Se a tabela não existe, retornar array vazio
      if (error.message?.includes('does not exist') || error.code === '42P01') {
        console.log('⚠️ Tabela "tags" não encontrada, retornando lista vazia');
        return c.json({
          success: true,
          tags: [],
          total: 0,
          message: 'Tabela de tags não configurada'
        });
      }
      
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }

    console.log(`✅ ${tags?.length || 0} tags encontradas`);

    return c.json({
      success: true,
      tags: tags || [],
      total: tags?.length || 0
    });

  } catch (error) {
    console.error('❌ Exceção ao buscar tags:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

/**
 * GET /api/contact-situation-enum
 * Retorna os valores válidos do enum contact_situation
 * PÚBLICO - Para configurar o dropdown dinamicamente
 */
app.get("/make-server-844b77a1/api/contact-situation-enum", async (c) => {
  console.log('\n🔍 [ENUM] Buscando valores do enum contact_situation...');

  try {
    // Query SQL para buscar os valores do enum
    const { data, error } = await supabaseAdmin.rpc('get_contact_situation_values', {});

    if (error) {
      console.error('❌ Erro ao buscar enum:', error);
      
      // Fallback: retornar valores padrão baseados na convenção comum
      console.log('⚠️ Usando valores padrão como fallback');
      return c.json({
        success: true,
        values: ['ativo', 'inativo', 'lead', 'prospecto', 'cliente'],
        source: 'fallback',
        message: 'Valores padrão (função RPC não encontrada)'
      });
    }

    console.log(`✅ Valores do enum encontrados:`, data);

    return c.json({
      success: true,
      values: data,
      source: 'database'
    });

  } catch (error) {
    console.error('❌ Exceção ao buscar enum:', error);
    
    // Fallback em caso de erro
    return c.json({
      success: true,
      values: ['ativo', 'inativo', 'lead', 'prospecto', 'cliente'],
      source: 'fallback',
      message: error instanceof Error ? error.message : 'Erro desconhecido'
    });
  }
});

/**
 * POST /api/contacts
 * Cria um novo contato usando SQL direto na tabela "contacts"
 * Recebe token no body (evita middleware JWT do Supabase)
 */
app.post("/make-server-844b77a1/api/contacts", async (c) => {
  try {
    const body = await c.req.json();
    const { whatsapp, nome, sobrenome, unit_id, situacao, tag_id, token } = body;

    console.log('\n👤 [CREATE CONTACT] Recebendo requisição...');
    console.log('- WhatsApp:', whatsapp);
    console.log('- Nome:', nome, sobrenome);
    console.log('- Unit ID:', unit_id);
    console.log('- Situação:', situacao);
    console.log('- Tag ID:', tag_id);

    // ✅ Validar campos obrigatórios
    if (!whatsapp || !nome || !sobrenome || !unit_id || !situacao || !tag_id) {
      return c.json({
        success: false,
        error: 'Campos obrigatórios: whatsapp, nome, sobrenome, unit_id, situacao, tag_id'
      }, 400);
    }

    //  Validar token do usuário (recebido no body)
    if (!token) {
      return c.json({
        success: false,
        error: 'Token de autenticação não fornecido'
      }, 401);
    }

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      console.error('❌ [CREATE CONTACT] Token inválido:', authError?.message);
      return c.json({
        success: false,
        error: 'Token inválido ou expirado'
      }, 401);
    }

    console.log('✅ [CREATE CONTACT] Usuário autenticado:', user.email);
    console.log('- User ID:', user.id);
    console.log('- id_profile_created será:', user.id);

    // 📝 Limpar número do WhatsApp (remover formatação)
    let phoneNumber = whatsapp.replace(/\D/g, '');
    
    // ✅ Adicionar código do país +55 se não estiver presente
    if (!phoneNumber.startsWith('55')) {
      phoneNumber = '55' + phoneNumber;
    }
    
    // 📝 Criar display_name (Nome + Sobrenome)
    const displayName = `${nome} ${sobrenome}`;
    
    console.log('📝 [CREATE CONTACT] Dados processados:');
    console.log('- whatsapp original:', whatsapp);
    console.log('- wa_id (com +55):', phoneNumber);
    console.log('- phone_number (com +55):', phoneNumber);
    console.log('- first_name:', nome);
    console.log('- last_name:', sobrenome);
    console.log('- display_name:', displayName);
    console.log('- unit_id:', unit_id);
    console.log('- situation:', situacao);

    // 🔍 Verificar se já existe contato com esse número
    const { data: existingContact, error: checkError } = await supabaseAdmin
      .from('contacts')
      .select('id, phone_number, display_name')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    if (checkError) {
      console.error('❌ [CREATE CONTACT] Erro ao verificar duplicata:', checkError);
      return c.json({
        success: false,
        error: `Erro ao verificar contato existente: ${checkError.message}`
      }, 500);
    }

    if (existingContact) {
      console.warn('⚠️ [CREATE CONTACT] Contato já existe:', existingContact);
      return c.json({
        success: false,
        error: 'DUPLICATE_CONTACT',
        message: `Já existe um contato cadastrado com este número de WhatsApp`,
        whatsapp: phoneNumber,
        existing_contact: {
          id: existingContact.id,
          name: existingContact.display_name,
          created_at: existingContact.created_at
        }
      }, 409);
    }

    // ✅ Inserir contato na tabela "contacts"
    const { data: newContact, error: insertError} = await supabaseAdmin
      .from('contacts')
      .insert({
        wa_id: phoneNumber,  // ✅ WhatsApp ID (obrigatório)
        phone_number: phoneNumber,
        first_name: nome,
        last_name: sobrenome,
        display_name: displayName,
        unit_id: unit_id,
        situation: situacao,  // ✅ Situação (obrigatório)
        id_profile_created: user.id,  // 🔐 UUID do usuário que criou (imutável - auditoria)
        id_profile_responsavel: user.id,  // 🔐 UUID do responsável atual (mutável - atualiza na reatribuição)
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ [CREATE CONTACT] Erro ao inserir contato:', insertError);
      
      // Se o erro for de enum inválido, retornar mensagem específica
      if (insertError.code === '22P02' && insertError.message.includes('enum')) {
        return c.json({
          success: false,
          error: `Valor de situação inválido: \"${situacao}\". Consulte /api/contact-situation-enum para ver valores válidos.`,
          invalidValue: situacao,
          hint: 'Valores comuns: ativo, inativo, lead, prospecto, cliente'
        }, 400);
      }
      
      return c.json({
        success: false,
        error: `Erro ao criar contato: ${insertError.message}`
      }, 500);
    }

    console.log('✅ [CREATE CONTACT] Contato criado com sucesso:', newContact.id);
    console.log('📋 Contato criado:', JSON.stringify(newContact, null, 2));

    // 🏷️ Inserir tag na tabela de relacionamento contact_tags (se houver)
    if (tag_id) {
      console.log('🏷️ [CREATE CONTACT] Associando tag ao contato...');
      console.log('- Tag a associar:', tag_id);

      const contactTagData = {
        contact_id: newContact.id,
        tag_id: tag_id,
        created_at: new Date().toISOString(),
        user_id: user.id  // Usuário que criou a associação
      };

      const { error: tagError } = await supabaseAdmin
        .from('contact_tags')
        .upsert(contactTagData, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });

      if (tagError) {
        console.error('❌ [CREATE CONTACT] Erro ao associar tag:', tagError);
        console.warn('⚠️ Contato criado, mas tag não foi associada');
        // Não falhamos a requisição por causa da tag
      } else {
        console.log('✅ [CREATE CONTACT] Tag associada com sucesso');
      }
    }

    return c.json({
      success: true,
      contact: newContact,
      message: 'Contato criado com sucesso'
    });

  } catch (error) {
    console.error('❌ [CREATE CONTACT] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 📝 CONTACT NOTES ENDPOINTS
// ========================================

/**
 * GET /api/contacts/:contactId/notes
 * Lista todas as anotações de um contato
 */
app.get("/make-server-844b77a1/api/contacts/:contactId/notes", async (c) => {
  try {
    const contactId = c.req.param('contactId');
    
    console.log('\n📝 [GET NOTES] Buscando anotações...');
    console.log('- Contact ID:', contactId);

    // Buscar anotações com informações do usuário
    const { data: notes, error: notesError } = await supabaseAdmin
      .from('contact_notes')
      .select(`
        id,
        contact_id,
        user_id,
        note_text,
        created_at,
        updated_at
      `)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (notesError) {
      console.error('❌ [GET NOTES] Erro ao buscar anotações:', notesError);
      return c.json({
        success: false,
        error: `Erro ao buscar anotações: ${notesError.message}`
      }, 500);
    }

    console.log(`✅ [GET NOTES] ${notes?.length || 0} anotação(ões) encontrada(s)`);

    // Buscar informações dos usuários da tabela profiles
    const notesWithUsers = await Promise.all(
      (notes || []).map(async (note) => {
        try {
          // Primeiro tentar buscar da tabela profiles
          const { data: profileData, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('nome, sobrenome, email')
            .eq('id', note.user_id)
            .single();

          if (profileData && !profileError) {
            const fullName = `${profileData.nome || ''} ${profileData.sobrenome || ''}`.trim();
            return {
              ...note,
              user_name: fullName || profileData.email || null,
              user_email: profileData.email || null
            };
          }

          // Fallback: buscar do auth.users
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(note.user_id);
          return {
            ...note,
            user_name: userData?.user?.user_metadata?.name || userData?.user?.email || null,
            user_email: userData?.user?.email || null
          };
        } catch (err) {
          console.warn(`⚠️ Erro ao buscar usuário ${note.user_id}:`, err);
          return note;
        }
      })
    );

    return c.json({
      success: true,
      notes: notesWithUsers
    });

  } catch (error) {
    console.error('❌ [GET NOTES] Erro crítico:', error);
    return c.json({
      success: false,
      error: `Erro ao buscar anotações: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
    }, 500);
  }
});

/**
 * POST /api/contacts/:contactId/notes
 * Cria uma nova anotação para um contato
 */
app.post("/make-server-844b77a1/api/contacts/:contactId/notes", async (c) => {
  try {
    const contactId = c.req.param('contactId');
    const body = await c.req.json();
    const { note_text, token } = body;

    console.log('\n📝 [CREATE NOTE] Criando anotação...');
    console.log('- Contact ID:', contactId);
    console.log('- Note text length:', note_text?.length || 0);

    // Validar campos obrigatórios
    if (!note_text || !note_text.trim()) {
      return c.json({
        success: false,
        error: 'O texto da anotação é obrigatório'
      }, 400);
    }

    if (!token) {
      return c.json({
        success: false,
        error: 'Token de autenticação não fornecido'
      }, 401);
    }

    // Validar usuário autenticado
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    
    if (authError || !user) {
      console.error('❌ [CREATE NOTE] Erro de autenticação:', authError);
      return c.json({
        success: false,
        error: 'Token inválido ou expirado'
      }, 401);
    }

    console.log('✅ [CREATE NOTE] Usuário autenticado:', user.email);

    // Verificar se o contato existe
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts')
      .select('id, first_name, last_name, display_name')
      .eq('id', contactId)
      .single();

    if (contactError || !contact) {
      console.error('❌ [CREATE NOTE] Contato não encontrado:', contactError);
      return c.json({
        success: false,
        error: 'Contato não encontrado'
      }, 404);
    }

    console.log('✅ [CREATE NOTE] Contato encontrado:', contact.display_name || `${contact.first_name} ${contact.last_name}`);

    // Criar anotação
    const { data: newNote, error: insertError } = await supabaseAdmin
      .from('contact_notes')
      .insert({
        contact_id: parseInt(contactId),
        user_id: user.id,
        note_text: note_text.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ [CREATE NOTE] Erro ao inserir anotação:', insertError);
      return c.json({
        success: false,
        error: `Erro ao criar anotação: ${insertError.message}`
      }, 500);
    }

    console.log('✅ [CREATE NOTE] Anotação criada com sucesso:', newNote.id);

    // Adicionar informações do usuário da tabela profiles
    let userName = null;
    let userEmail = user.email || null;

    // Tentar buscar da tabela profiles
    try {
      const { data: profileData } = await supabaseAdmin
        .from('profiles')
        .select('nome, sobrenome, email')
        .eq('id', user.id)
        .single();

      if (profileData) {
        const fullName = `${profileData.nome || ''} ${profileData.sobrenome || ''}`.trim();
        userName = fullName || profileData.email || user.user_metadata?.name || null;
        userEmail = profileData.email || user.email || null;
      }
    } catch (err) {
      console.warn('⚠️ Erro ao buscar profile do usuário:', err);
      userName = user.user_metadata?.name || user.email || null;
    }

    const noteWithUser = {
      ...newNote,
      user_name: userName,
      user_email: userEmail
    };

    return c.json({
      success: true,
      note: noteWithUser
    });

  } catch (error) {
    console.error('❌ [CREATE NOTE] Erro crítico:', error);
    return c.json({
      success: false,
      error: `Erro ao criar anotação: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
    }, 500);
  }
});

// ========================================
// 📦 STORAGE INITIALIZATION
// ========================================

/**
 * Helper: Retry com exponential backoff para erros temporários
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelay = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const is502Error = error?.status === 502 || error?.statusCode === '502';
      
      if (isLastAttempt || !is502Error) {
        throw error;
      }
      
      const delay = initialDelay * Math.pow(2, attempt - 1);
      console.log(`⏳ [RETRY] Tentativa ${attempt}/${maxRetries} falhou (502). Aguardando ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Retry failed');
}

/**
 * Inicializa o bucket de storage para arquivos do WhatsApp
 * Cria o bucket se não existir
 */
async function initializeStorage() {
  const bucketName = 'make-844b77a1-whatsapp-media';
  
  try {
    console.log('\n📦 [STORAGE] Inicializando bucket de mídia...');
    
    // Verificar se o bucket já existe (com retry para erros 502)
    const listBucketsWithRetry = async () => {
      const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
      if (listError) throw listError;
      return buckets;
    };
    
    let buckets;
    try {
      buckets = await retryWithBackoff(listBucketsWithRetry, 3, 1000);
    } catch (error: any) {
      console.error('❌ [STORAGE] Erro ao listar buckets após 3 tentativas:', error);
      console.log('⚠️ [STORAGE] Continuando sem inicializar bucket. Será criado quando necessário.');
      return;
    }
    
    if (!buckets) {
      console.log('⚠️ [STORAGE] Sem dados de buckets. Continuando...');
      return;
    }
    
    const bucketExists = buckets?.some(bucket => bucket.name === bucketName);
    
    if (bucketExists) {
      console.log('✅ [STORAGE] Bucket já existe:', bucketName);
      console.log('📋 [STORAGE] Bucket configurado e pronto para uso');
      return; // Não tenta deletar/recriar, apenas continua
    }
    
    // Criar bucket privado SEM restrições de MIME type
    const { data, error: createError } = await supabaseAdmin.storage.createBucket(bucketName, {
      public: false,
      fileSizeLimit: 10485760 // 10MB (sem allowedMimeTypes = aceita todos)
    });
    
    if (createError) {
      console.error('❌ [STORAGE] Erro ao criar bucket:', createError);
      return;
    }
    
    console.log('✅ [STORAGE] Bucket criado com sucesso:', bucketName);
    console.log('📋 [STORAGE] Configuração: aceita TODOS os tipos de arquivo (até 10MB)');
    
  } catch (error) {
    console.error('❌ [STORAGE] Exceção ao inicializar storage:', error);
  }
}

// ========================================
// 📤 ENDPOINT: UPLOAD DE MÍDIA (VERSÃO JSON - COM URL DA META)
// ========================================

/**
 * Upload de arquivo de mídia do WhatsApp para o Supabase Storage
 * VERSÃO 1: Recebe URL da Meta e faz download do arquivo
 * Endpoint para ser chamado pelo n8n quando receber mídia do webhook
 * ⚠️ ENDPOINT PÚBLICO - Não requer autenticação de usuário
 */
app.post('/make-server-844b77a1/api/whatsapp/upload-media', async (c) => {
  try {
    console.log('\n📤 [UPLOAD MEDIA] Iniciando upload de mídia...');
    console.log('📋 [UPLOAD MEDIA] Headers recebidos:');
    console.log('  - Authorization:', c.req.header('Authorization')?.substring(0, 50) || 'não enviado');
    console.log('  - Content-Type:', c.req.header('Content-Type'));
    console.log('  - apikey:', c.req.header('apikey')?.substring(0, 30) || 'não enviado');
    
    const body = await c.req.json();
    const { mediaUrl, mimeType, filename, conversationId, messageId } = body;
    
    console.log('📦 [UPLOAD MEDIA] Dados recebidos:');
    console.log('  - mediaUrl:', mediaUrl?.substring(0, 60) || 'não informado');
    console.log('  - mimeType:', mimeType || 'não informado');
    console.log('  - filename:', filename || 'não informado');
    console.log('  - conversationId:', conversationId || 'não informado');
    console.log('  - messageId:', messageId || 'não informado');
    
    if (!mediaUrl || !conversationId) {
      console.error('❌ [UPLOAD MEDIA] Parâmetros obrigatórios ausentes');
      return c.json({
        success: false,
        error: 'mediaUrl e conversationId são obrigatórios'
      }, 400);
    }
    
    console.log('📥 [UPLOAD MEDIA] Baixando arquivo da URL:', mediaUrl);
    
    // Baixar arquivo da URL
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      throw new Error(`Erro ao baixar arquivo: ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    
    // Gerar nome único para o arquivo
    const timestamp = Date.now();
    const extension = filename?.split('.').pop() || 'bin';
    const storagePath = `${conversationId}/${timestamp}-${filename || 'file'}`;
    
    console.log('💾 [UPLOAD MEDIA] Salvando no storage:', storagePath);
    
    // Upload para o Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('make-844b77a1-whatsapp-media')
      .upload(storagePath, buffer, {
        contentType: mimeType || 'application/octet-stream',
        upsert: false
      });
    
    if (uploadError) {
      console.error('❌ [UPLOAD MEDIA] Erro ao fazer upload:', uploadError);
      return c.json({
        success: false,
        error: `Erro ao fazer upload: ${uploadError.message}`
      }, 500);
    }
    
    console.log('✅ [UPLOAD MEDIA] Upload realizado com sucesso!');
    
    // Gerar URL assinada (válida por 7 dias)
    const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin.storage
      .from('make-844b77a1-whatsapp-media')
      .createSignedUrl(storagePath, 604800); // 7 dias
    
    if (signedUrlError) {
      console.error('⚠️ [UPLOAD MEDIA] Erro ao gerar URL assinada:', signedUrlError);
    }
    
    const publicUrl = signedUrlData?.signedUrl;
    
    console.log('🔗 [UPLOAD MEDIA] URL gerada:', publicUrl?.substring(0, 50) + '...');
    
    // Se messageId foi fornecido, atualizar a mensagem com a URL
    if (messageId && publicUrl) {
      const { error: updateError } = await supabaseAdmin
        .from('messages')
        .update({ media_url: publicUrl })
        .eq('id', messageId);
      
      if (updateError) {
        console.error('⚠️ [UPLOAD MEDIA] Erro ao atualizar mensagem:', updateError);
      } else {
        console.log('✅ [UPLOAD MEDIA] Mensagem atualizada com media_url');
      }
    }
    
    return c.json({
      success: true,
      storagePath,
      publicUrl,
      size: buffer.length
    });
    
  } catch (error) {
    console.error('❌ [UPLOAD MEDIA] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 🔗 ENDPOINT: GERAR URL ASSINADA
// ========================================

/**
 * Gera uma nova URL assinada para um arquivo já armazenado
 * Útil quando a URL expirar
 */
app.post('/make-server-844b77a1/api/storage/signed-url', async (c) => {
  try {
    const body = await c.req.json();
    const { storagePath, expiresIn } = body;
    
    if (!storagePath) {
      return c.json({
        success: false,
        error: 'storagePath é obrigatório'
      }, 400);
    }
    
    const expirationSeconds = expiresIn || 604800; // 7 dias por padrão
    
    const { data, error } = await supabaseAdmin.storage
      .from('make-844b77a1-whatsapp-media')
      .createSignedUrl(storagePath, expirationSeconds);
    
    if (error) {
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }
    
    return c.json({
      success: true,
      signedUrl: data.signedUrl,
      expiresIn: expirationSeconds
    });
    
  } catch (error) {
    console.error('❌ [SIGNED URL] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 📤 ENDPOINT: UPLOAD BINÁRIO DIRETO
// ========================================

/**
 * Upload DIRETO de arquivo binário para o Supabase Storage
 * VERSÃO 2: Recebe o arquivo binário já baixado pelo n8n
 * Mais eficiente - evita que o backend precise baixar da Meta
 * ⚠️ ENDPOINT PÚBLICO - Não requer autenticação de usuário
 * 
 * FORMATO: Binary no body + metadados nos query params
 */
app.post('/make-server-844b77a1/api/whatsapp/upload-binary', async (c) => {
  try {
    console.log('\n📤 [UPLOAD BINARY] Iniciando upload binário...');
    console.log('📋 [UPLOAD BINARY] Headers recebidos:');
    console.log('  - Content-Type:', c.req.header('Content-Type'));
    console.log('  - Authorization:', c.req.header('Authorization')?.substring(0, 50) || 'não enviado');
    
    // Ler metadados dos query params
    const conversationId = c.req.query('conversationId');
    const messageId = c.req.query('messageId') || null;
    const mimeType = c.req.query('mimeType') || c.req.header('Content-Type') || 'application/octet-stream';
    const rawFilename = c.req.query('filename') || `file-${Date.now()}`;
    
    // Sanitizar filename: remover espaços, acentos e caracteres especiais
    const sanitizeFilename = (name: string): string => {
      return name
        .normalize('NFD')                           // Decompõe caracteres acentuados
        .replace(/[\u0300-\u036f]/g, '')           // Remove marcas diacríticas (acentos)
        .replace(/\s+/g, '_')                      // Substitui espaços por underscore
        .replace(/[^a-zA-Z0-9._-]/g, '')           // Remove caracteres especiais
        .replace(/_{2,}/g, '_')                    // Remove underscores duplicados
        .toLowerCase();                            // Converte para minúsculas
    };
    
    const filename = sanitizeFilename(rawFilename);
    
    console.log('📦 [UPLOAD BINARY] Dados recebidos:');
    console.log('  - conversationId:', conversationId || 'não informado');
    console.log('  - messageId:', messageId || 'não informado');
    console.log('  - mimeType:', mimeType);
    console.log('  - filename original:', rawFilename);
    console.log('  - filename sanitizado:', filename);
    
    if (!conversationId) {
      console.error('❌ [UPLOAD BINARY] conversationId ausente');
      return c.json({
        success: false,
        error: 'conversationId é obrigatório (envie como query param: ?conversationId=UUID)'
      }, 400);
    }
    
    // Ler binário do body
    console.log('📥 [UPLOAD BINARY] Lendo binário do body...');
    const arrayBuffer = await c.req.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    
    console.log('📊 [UPLOAD BINARY] Tamanho do buffer:', buffer.length, 'bytes');
    
    if (buffer.length === 0) {
      console.error('❌ [UPLOAD BINARY] Body vazio');
      return c.json({
        success: false,
        error: 'Body não pode estar vazio. Envie o arquivo binário no body da requisição.'
      }, 400);
    }
    
    // Validar tamanho (limite: 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (buffer.length > maxSize) {
      console.error('❌ [UPLOAD BINARY] Arquivo muito grande:', buffer.length);
      return c.json({
        success: false,
        error: `Arquivo muito grande. Limite: 10MB. Tamanho: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`
      }, 400);
    }
    
    // Gerar nome único para o arquivo
    const timestamp = Date.now();
    const storagePath = `${conversationId}/${timestamp}-${filename}`;
    const finalMimeType = mimeType;
    
    console.log('💾 [UPLOAD BINARY] Salvando no storage:', storagePath);
    console.log('  - MIME Type:', finalMimeType);
    console.log('  - Tamanho:', (buffer.length / 1024).toFixed(2), 'KB');
    
    // Upload para o Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('make-844b77a1-whatsapp-media')
      .upload(storagePath, buffer, {
        contentType: finalMimeType,
        upsert: false
      });
    
    if (uploadError) {
      console.error('❌ [UPLOAD BINARY] Erro ao fazer upload:', uploadError);
      return c.json({
        success: false,
        error: `Erro ao fazer upload: ${uploadError.message}`
      }, 500);
    }
    
    console.log('✅ [UPLOAD BINARY] Upload realizado com sucesso!');
    
    // Gerar URL assinada (válida por 7 dias)
    const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin.storage
      .from('make-844b77a1-whatsapp-media')
      .createSignedUrl(storagePath, 604800); // 7 dias
    
    if (signedUrlError) {
      console.error('⚠️ [UPLOAD BINARY] Erro ao gerar URL assinada:', signedUrlError);
    }
    
    const publicUrl = signedUrlData?.signedUrl;
    
    console.log('🔗 [UPLOAD BINARY] URL gerada:', publicUrl?.substring(0, 50) + '...');
    
    // Se messageId foi fornecido, atualizar a mensagem com a URL
    if (messageId && publicUrl) {
      const { error: updateError } = await supabaseAdmin
        .from('messages')
        .update({ media_url: publicUrl })
        .eq('id', messageId);
      
      if (updateError) {
        console.error('⚠️ [UPLOAD BINARY] Erro ao atualizar mensagem:', updateError);
      } else {
        console.log('✅ [UPLOAD BINARY] Mensagem atualizada com media_url');
      }
    }
    
    return c.json({
      success: true,
      storagePath,
      publicUrl,
      size: buffer.length,
      mimeType: finalMimeType,
      filename: filename
    });
    
  } catch (error) {
    console.error('❌ [UPLOAD BINARY] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 🔧 ENDPOINT ADMINISTRATIVO: Recriar Bucket
// ========================================

/**
 * Endpoint para forçar recriação do bucket de storage
 * Útil quando precisa remover restrições de MIME type
 */
app.post('/make-server-844b77a1/admin/recreate-storage-bucket', async (c) => {
  try {
    console.log('\n🔧 [ADMIN] Recriando bucket de storage...');
    
    // Executar função de inicialização que vai deletar e recriar
    await initializeStorage();
    
    return c.json({
      success: true,
      message: 'Bucket recriado com sucesso (sem restrições de MIME type)'
    });
  } catch (error) {
    console.error('❌ [ADMIN] Erro ao recriar bucket:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 🕐 BUSINESS HOURS - HORÁRIO DE ATENDIMENTO
// ========================================

const BUSINESS_HOURS_KV_KEY = 'business_hours_config';

const DEFAULT_BUSINESS_HOURS = {
  monday: { enabled: true, slots: [{ start: '08:00', end: '18:00' }] },
  tuesday: { enabled: true, slots: [{ start: '08:00', end: '18:00' }] },
  wednesday: { enabled: true, slots: [{ start: '08:00', end: '18:00' }] },
  thursday: { enabled: true, slots: [{ start: '08:00', end: '18:00' }] },
  friday: { enabled: true, slots: [{ start: '08:00', end: '18:00' }] },
  saturday: { enabled: false, slots: [{ start: '09:00', end: '13:00' }] },
  sunday: { enabled: false, slots: [{ start: '09:00', end: '13:00' }] },
  autoReply: {
    enabled: true,
    message: 'Olá! No momento estamos fora do horário de atendimento. Retornaremos o seu contato assim que possível. Obrigado!',
  },
};

/**
 * Helper: Verifica se o horário atual está dentro do expediente
 * Usa timezone America/Sao_Paulo (Brasília)
 */
function checkBusinessHoursStatus(config: any): {
  isOpen: boolean;
  currentDay: string;
  currentTime: string;
  daySchedule: any;
  timezone: string;
} {
  const now = new Date();
  const brasiliaFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = brasiliaFormatter.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value?.toLowerCase() || '';
  let hour = parts.find(p => p.type === 'hour')?.value || '00';
  const minute = parts.find(p => p.type === 'minute')?.value || '00';
  // Edge case: some environments return '24' instead of '00' for midnight
  if (hour === '24') hour = '00';
  const currentTime = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

  const dayMap: Record<string, string> = {
    monday: 'monday', tuesday: 'tuesday', wednesday: 'wednesday',
    thursday: 'thursday', friday: 'friday', saturday: 'saturday', sunday: 'sunday',
  };

  const configDay = dayMap[weekday] || weekday;
  const daySchedule = config?.[configDay];

  console.log(`🕐 [BUSINESS HOURS] Verificação:`);
  console.log(`   - Timezone: America/Sao_Paulo`);
  console.log(`   - Dia: ${weekday} -> key: ${configDay}`);
  console.log(`   - Hora atual: ${currentTime}`);
  console.log(`   - Schedule:`, JSON.stringify(daySchedule));

  if (!daySchedule || !daySchedule.enabled) {
    console.log(`   - Resultado: FECHADO (dia desabilitado)`);
    return { isOpen: false, currentDay: configDay, currentTime, daySchedule, timezone: 'America/Sao_Paulo' };
  }

  const isOpen = daySchedule.slots?.some((slot: any) => {
    const inRange = currentTime >= slot.start && currentTime < slot.end;
    console.log(`   - Slot ${slot.start}-${slot.end}: ${inRange ? '✅ DENTRO' : '❌ FORA'}`);
    return inRange;
  }) || false;

  console.log(`   - Resultado: ${isOpen ? '🟢 ABERTO' : '🔴 FECHADO'}`);
  return { isOpen, currentDay: configDay, currentTime, daySchedule, timezone: 'America/Sao_Paulo' };
}

/**
 * GET /api/business-hours
 * Retorna a configuração de horário de atendimento salva no banco
 */
app.get('/make-server-844b77a1/api/business-hours', async (c) => {
  console.log('\n🕐 [BUSINESS HOURS] Carregando configuração...');
  try {
    const config = await kv.get(BUSINESS_HOURS_KV_KEY);
    if (!config) {
      console.log('⚠️ [BUSINESS HOURS] Nenhuma config encontrada, retornando default.');
      return c.json({ success: true, config: DEFAULT_BUSINESS_HOURS, isDefault: true });
    }
    console.log('✅ [BUSINESS HOURS] Configuração carregada.');
    return c.json({ success: true, config, isDefault: false });
  } catch (error) {
    console.error('❌ [BUSINESS HOURS] Erro ao carregar:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

/**
 * POST /api/business-hours
 * Salva a configuração de horário de atendimento no banco (KV store)
 */
app.post('/make-server-844b77a1/api/business-hours', async (c) => {
  console.log('\n🕐 [BUSINESS HOURS] Salvando configuração...');
  try {
    const body = await c.req.json();
    const { config } = body;
    if (!config) {
      return c.json({ success: false, error: 'Campo "config" é obrigatório' }, 400);
    }
    console.log('📝 [BUSINESS HOURS] Config recebida:', JSON.stringify(config).substring(0, 200) + '...');
    await kv.set(BUSINESS_HOURS_KV_KEY, config);
    console.log('✅ [BUSINESS HOURS] Salvo no banco.');
    return c.json({ success: true, message: 'Configuração salva com sucesso' });
  } catch (error) {
    console.error('❌ [BUSINESS HOURS] Erro ao salvar:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

/**
 * GET /api/business-hours/check
 * Verifica se o horário atual está dentro do expediente.
 * Para o n8n consultar ao receber mensagem inbound.
 *
 * Retorna: { isOpen, autoReplyEnabled, autoReplyMessage, debug }
 */
app.get('/make-server-844b77a1/api/business-hours/check', async (c) => {
  console.log('\n🕐 [BUSINESS HOURS CHECK] Verificando status...');
  try {
    const config = (await kv.get(BUSINESS_HOURS_KV_KEY)) || DEFAULT_BUSINESS_HOURS;
    const status = checkBusinessHoursStatus(config);
    return c.json({
      success: true,
      isOpen: status.isOpen,
      autoReplyEnabled: config.autoReply?.enabled ?? false,
      autoReplyMessage: config.autoReply?.message ?? '',
      debug: {
        currentDay: status.currentDay,
        currentTime: status.currentTime,
        timezone: status.timezone,
        daySchedule: status.daySchedule,
      }
    });
  } catch (error) {
    console.error('❌ [BUSINESS HOURS CHECK] Erro:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

/**
 * POST /api/business-hours/auto-reply
 * Endpoint ALL-IN-ONE para o n8n:
 * Verifica se está fora do horário e, se sim, envia a mensagem automática.
 *
 * Body: { phone: "5511999999999" }
 * Retorna: { sent: boolean, reason: string }
 *
 * Fluxo n8n: ao receber mensagem inbound, chamar este endpoint.
 * Se sent=true, a mensagem automática já foi enviada.
 */
app.post('/make-server-844b77a1/api/business-hours/auto-reply', async (c) => {
  console.log('\n🕐 [AUTO REPLY] Processando...');
  try {
    const body = await c.req.json();
    const { phone } = body;
    if (!phone) {
      return c.json({ success: false, error: 'Campo "phone" é obrigatório (E.164, ex: 5511999999999)' }, 400);
    }
    console.log('📱 [AUTO REPLY] Telefone:', phone);

    // 1. Carregar config
    const config = (await kv.get(BUSINESS_HOURS_KV_KEY)) || DEFAULT_BUSINESS_HOURS;

    // 2. Verificar horário
    const status = checkBusinessHoursStatus(config);

    if (status.isOpen) {
      console.log('🟢 [AUTO REPLY] Dentro do horário. Nenhuma ação.');
      return c.json({ success: true, sent: false, reason: 'within_hours', debug: { currentDay: status.currentDay, currentTime: status.currentTime, timezone: status.timezone } });
    }

    // 3. Verificar se auto-reply está ativo
    if (!config.autoReply?.enabled) {
      console.log('⚠️ [AUTO REPLY] Fora do horário, mas auto-reply desabilitado.');
      return c.json({ success: true, sent: false, reason: 'auto_reply_disabled', debug: { currentDay: status.currentDay, currentTime: status.currentTime, timezone: status.timezone } });
    }

    const autoReplyMessage = config.autoReply.message;
    if (!autoReplyMessage || autoReplyMessage.trim() === '') {
      console.log('⚠️ [AUTO REPLY] Mensagem de auto-reply vazia.');
      return c.json({ success: true, sent: false, reason: 'empty_message' });
    }

    // 4. Enviar via WhatsApp
    console.log('📤 [AUTO REPLY] Enviando resposta automática...');
    console.log('   - Para:', phone);
    console.log('   - Mensagem:', autoReplyMessage.substring(0, 80) + '...');

    const sendResult = await whatsapp.sendWhatsAppTextMessage(phone, autoReplyMessage);

    if (sendResult.success) {
      console.log('✅ [AUTO REPLY] Enviada! ID:', sendResult.messageId);

      // 5. Salvar no banco (se houver conversa)
      try {
        const phoneClean = phone.replace(/\+/g, '');
        const { data: contact } = await supabaseAdmin
          .from('contacts')
          .select('id')
          .or(`phone_e164.eq.${phoneClean},phone_e164.eq.+${phoneClean}`)
          .maybeSingle();

        if (contact) {
          const { data: conversation } = await supabaseAdmin
            .from('conversations')
            .select('id')
            .eq('contact_id', contact.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (conversation) {
            await saveOutboundMessage({
              conversationId: conversation.id,
              type: 'text',
              body: autoReplyMessage,
              providerMessageId: sendResult.messageId,
              toPhoneE164: phone,
            });
            console.log('💾 [AUTO REPLY] Salva na conversa:', conversation.id);
          }
        }
      } catch (saveErr) {
        console.warn('⚠️ [AUTO REPLY] Erro ao salvar (não crítico):', saveErr);
      }

      return c.json({
        success: true, sent: true, reason: 'sent_successfully', messageId: sendResult.messageId,
        debug: { currentDay: status.currentDay, currentTime: status.currentTime, timezone: status.timezone, message: autoReplyMessage }
      });
    } else {
      console.error('❌ [AUTO REPLY] Falha ao enviar:', sendResult.error);
      return c.json({
        success: false, sent: false, reason: 'send_failed', error: sendResult.error,
        debug: { currentDay: status.currentDay, currentTime: status.currentTime, timezone: status.timezone }
      });
    }

  } catch (error) {
    console.error('❌ [AUTO REPLY] Exceção:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

// ========================================
// 💬 CRM WHATSAPP INTEGRATION ENDPOINTS
// ========================================

/**
 * POST /api/crm/check-contact
 * Verifica se já existe um contato e conversa para o telefone do lead.
 * Retorna { exists: true, contact, conversation } ou { exists: false }
 */
app.post("/make-server-844b77a1/api/crm/check-contact", async (c) => {
  try {
    const body = await c.req.json();
    const { phone, token } = body;

    console.log('\n🔍 [CRM CHECK] Verificando contato para telefone:', phone);

    if (!phone) {
      return c.json({ success: false, error: 'Campo phone é obrigatório' }, 400);
    }

    if (!token) {
      return c.json({ success: false, error: 'Token de autenticação não fornecido' }, 401);
    }

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return c.json({ success: false, error: 'Token inválido ou expirado' }, 401);
    }

    // Normalizar telefone
    let phoneNumber = phone.replace(/\D/g, '');
    if (!phoneNumber.startsWith('55')) {
      phoneNumber = '55' + phoneNumber;
    }

    console.log('📞 [CRM CHECK] Telefone normalizado:', phoneNumber);

    // Buscar contato pelo telefone
    const { data: contact, error: contactError } = await supabaseAdmin
      .from('contacts')
      .select('*')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    if (contactError) {
      console.error('❌ [CRM CHECK] Erro ao buscar contato:', contactError);
      return c.json({ success: false, error: `Erro ao buscar contato: ${contactError.message}` }, 500);
    }

    if (!contact) {
      console.log('📭 [CRM CHECK] Contato NÃO encontrado para:', phoneNumber);
      return c.json({ success: true, exists: false });
    }

    console.log('✅ [CRM CHECK] Contato encontrado:', contact.id, contact.display_name);

    // Buscar conversa mais recente (preferencialmente aberta)
    const { data: conversations, error: convError } = await supabaseAdmin
      .from('conversations')
      .select(`
        *,
        contact:contacts!conversations_contact_id_fkey(*),
        unit:units!conversations_unit_id_fkey(id, name),
        assigned_user:profiles!conversations_assigned_user_id_fkey(*)
      `)
      .eq('contact_id', contact.id)
      .order('updated_at', { ascending: false })
      .limit(5);

    if (convError) {
      console.error('❌ [CRM CHECK] Erro ao buscar conversas:', convError);
      return c.json({ success: false, error: `Erro ao buscar conversas: ${convError.message}` }, 500);
    }

    // Priorizar conversa aberta, senão a mais recente
    let conversation = conversations?.find((cv: any) => cv.status !== 'closed') || conversations?.[0] || null;

    if (conversation) {
      // Buscar tags da conversa
      const { data: convTags } = await supabaseAdmin
        .from('conversation_tags')
        .select('tag:tags(*)')
        .eq('conversation_id', conversation.id);

      conversation.tags = convTags?.map((ct: any) => ct.tag).filter(Boolean) || [];
      console.log('💬 [CRM CHECK] Conversa encontrada:', conversation.id, 'status:', conversation.status);
    } else {
      console.log('📭 [CRM CHECK] Nenhuma conversa encontrada para o contato');

      // Se existe contato mas sem conversa, criar uma conversa automaticamente
      const { data: newConv, error: newConvError } = await supabaseAdmin
        .from('conversations')
        .insert({
          contact_id: contact.id,
          unit_id: contact.unit_id,
          status: 'open',
          assigned_user_id: null,
          last_message_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select(`
          *,
          contact:contacts!conversations_contact_id_fkey(*),
          unit:units!conversations_unit_id_fkey(id, name),
          assigned_user:profiles!conversations_assigned_user_id_fkey(*)
        `)
        .single();

      if (!newConvError && newConv) {
        newConv.tags = [];
        conversation = newConv;
        console.log('✅ [CRM CHECK] Nova conversa criada automaticamente:', conversation.id);
      }
    }

    return c.json({
      success: true,
      exists: true,
      contact,
      conversation,
      hasConversation: !!conversation,
    });

  } catch (error) {
    console.error('❌ [CRM CHECK] Exceção:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

/**
 * POST /api/crm/leads
 * Endpoint unificado: INSERT lead + onboarding automático (contact → conversation → template).
 * 
 * Fontes externas (n8n, webhook, API) devem chamar este endpoint
 * em vez de inserir diretamente na tabela leads.
 * 
 * @param nome_completo  - (obrigatório)
 * @param telefone       - (obrigatório)
 * @param id_unidade     - (obrigatório)
 * @param email, situacao, origem, campanha, midia, utm_id, responsavel,
 *        pontuacao, classificacao, ja_treina, objetivo_principal,
 *        mora_ou_trabalha_perto, quando_quer_comecar - (opcionais)
 * @param sendTemplate   - default true; se false, não dispara template
 * @param token          - JWT (opcional; se ausente, usa service role)
 */
app.post("/make-server-844b77a1/api/crm/leads", async (c) => {
  try {
    const body = await c.req.json();
    const {
      nome_completo, telefone, email,
      id_unidade, situacao,
      origem, campanha, midia, utm_id,
      responsavel, pontuacao, classificacao,
      ja_treina, objetivo_principal,
      mora_ou_trabalha_perto, quando_quer_comecar,
      sendTemplate: sendTemplateParam,
      token,
    } = body;

    console.log('\n🆕 [CREATE LEAD + ONBOARDING] Recebendo lead via API...');
    console.log('- Nome:', nome_completo);
    console.log('- Telefone:', telefone);
    console.log('- Unidade:', id_unidade);
    console.log('- Origem:', origem);
    console.log('- sendTemplate:', sendTemplateParam);

    // ── Validação ───────────────────────────────────────────────
    if (!nome_completo || !telefone) {
      return c.json({ success: false, error: 'Campos obrigatórios: nome_completo, telefone' }, 400);
    }
    if (!id_unidade) {
      return c.json({ success: false, error: 'Campo obrigatório: id_unidade (necessário para o onboarding)' }, 400);
    }

    // Autenticação (opcional)
    let userId: string | null = null;
    if (token) {
      const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
      if (!authError && user) {
        userId = user.id;
        console.log('✅ [CREATE LEAD] Usuário autenticado:', user.email);
      } else {
        console.warn('⚠️ [CREATE LEAD] Token inválido, continuando com service role');
      }
    } else {
      console.log('ℹ️ [CREATE LEAD] Sem token — fonte externa via service role');
    }

    // ── ETAPA 1: Inserir lead ───────────────────────────────────
    const leadInsert: any = {
      nome_completo: nome_completo.trim(),
      telefone: telefone.trim(),
      email: email?.trim() || null,
      situacao: situacao || 'novo',
      id_unidade,
      origem: origem?.trim() || null,
      campanha: campanha?.trim() || null,
      midia: midia?.trim() || null,
      utm_id: utm_id?.trim() || null,
      responsavel: responsavel?.trim() || null,
      pontuacao: pontuacao ?? null,
      classificacao: classificacao?.trim() || null,
      ja_treina: ja_treina?.trim() || null,
      objetivo_principal: objetivo_principal?.trim() || null,
      mora_ou_trabalha_perto: mora_ou_trabalha_perto?.trim() || null,
      quando_quer_comecar: quando_quer_comecar?.trim() || null,
      data_cadastro: new Date().toISOString(),
    };

    const { data: newLead, error: leadError } = await supabaseAdmin
      .from('leads')
      .insert(leadInsert)
      .select()
      .single();

    if (leadError) {
      console.error('❌ [CREATE LEAD] Erro ao inserir lead:', leadError);
      return c.json({ success: false, error: `Erro ao criar lead: ${leadError.message}` }, 500);
    }
    console.log('✅ [CREATE LEAD] Lead criado:', newLead.id);

    // ── ETAPA 2: Onboarding (contact → conversation) ────────────
    const shouldSendTemplate = sendTemplateParam !== false;

    let phoneNumber = telefone.replace(/\D/g, '');
    if (!phoneNumber.startsWith('55')) phoneNumber = '55' + phoneNumber;

    const nameParts = nome_completo.trim().split(/\s+/);
    const nome = nameParts[0] || nome_completo;
    const sobrenome = nameParts.slice(1).join(' ') || null;

    const { data: existingContact } = await supabaseAdmin
      .from('contacts')
      .select('id, display_name')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    let contact: any = null;
    let conversation: any = null;
    let templateResult: any = null;
    let alreadyExisted = false;

    if (existingContact) {
      console.log('⚠️ [CREATE LEAD] Contato já existe:', existingContact.id);
      alreadyExisted = true;
      contact = existingContact;

      await supabaseAdmin.from('leads').update({ id_contact: existingContact.id }).eq('id', newLead.id);
      await supabaseAdmin.from('contacts').update({ id_lead: newLead.id }).eq('id', existingContact.id);

      const { data: existingConvs } = await supabaseAdmin
        .from('conversations')
        .select(`*, contact:contacts!conversations_contact_id_fkey(*), unit:units!conversations_unit_id_fkey(id, name), assigned_user:profiles!conversations_assigned_user_id_fkey(*)`)
        .eq('contact_id', existingContact.id)
        .order('updated_at', { ascending: false })
        .limit(1);

      conversation = existingConvs?.[0] || null;

      if (!conversation) {
        const { data: newConv } = await supabaseAdmin
          .from('conversations')
          .insert({ contact_id: existingContact.id, unit_id: id_unidade, status: 'open', assigned_user_id: null, last_message_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .select(`*, contact:contacts!conversations_contact_id_fkey(*), unit:units!conversations_unit_id_fkey(id, name), assigned_user:profiles!conversations_assigned_user_id_fkey(*)`)
          .single();
        if (newConv) { newConv.tags = []; conversation = newConv; }
      } else {
        const { data: convTags } = await supabaseAdmin.from('conversation_tags').select('tag:tags(*)').eq('conversation_id', conversation.id);
        conversation.tags = convTags?.map((ct: any) => ct.tag).filter(Boolean) || [];
      }
    } else {
      const displayName = [nome, sobrenome].filter(Boolean).join(' ');
      const { data: newContact, error: contactError } = await supabaseAdmin
        .from('contacts')
        .insert({ wa_id: phoneNumber, phone_number: phoneNumber, first_name: nome, last_name: sobrenome || null, display_name: displayName, unit_id: id_unidade, situation: 'lead', id_profile_created: userId, id_profile_responsavel: null, id_lead: newLead.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .select()
        .single();

      if (contactError) {
        console.error('❌ [CREATE LEAD] Erro ao criar contato:', contactError);
        return c.json({ success: true, lead: newLead, onboarding: { success: false, error: `Erro ao criar contato: ${contactError.message}` }, message: 'Lead criado, mas onboarding falhou na criação do contato.' });
      }
      console.log('✅ [CREATE LEAD] Contato criado:', newContact.id);
      contact = newContact;

      await supabaseAdmin.from('leads').update({ id_contact: newContact.id }).eq('id', newLead.id);

      const { data: newConversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert({ contact_id: newContact.id, unit_id: id_unidade, status: 'open', assigned_user_id: null, last_message_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .select(`*, contact:contacts!conversations_contact_id_fkey(*), unit:units!conversations_unit_id_fkey(id, name), assigned_user:profiles!conversations_assigned_user_id_fkey(*)`)
        .single();

      if (convError) {
        console.error('❌ [CREATE LEAD] Erro ao criar conversa:', convError);
        return c.json({ success: true, lead: newLead, contact: newContact, onboarding: { success: false, error: `Erro ao criar conversa: ${convError.message}` }, message: 'Lead e contato criados, mas conversa falhou.' });
      }
      console.log('✅ [CREATE LEAD] Conversa criada:', newConversation.id);
      newConversation.tags = [];
      conversation = newConversation;

      await supabaseAdmin.from('conversation_events').insert({ conversation_id: newConversation.id, event_type: 'created', actor_user_id: userId, metadata: { source: 'api_create_lead', lead_id: newLead.id } });
    }

    // ── ETAPA 3: Disparar template ──────────────────────────────
    if (shouldSendTemplate && conversation) {
      console.log('📤 [CREATE LEAD] Disparando template automacao_lead...');
      const templateName = 'automacao_lead';
      const languageCode = 'pt_BR';

      const sendResult = await whatsapp.sendWhatsAppTemplate({ to: phoneNumber, templateName, languageCode, components: [] });
      console.log('📡 [CREATE LEAD] Resultado template:', JSON.stringify(sendResult, null, 2));

      if (sendResult.success) {
        console.log('✅ [CREATE LEAD] Template enviado! Message ID:', sendResult.messageId);

        let templateText = templateName;
        try {
          const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
          const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';
          if (metaAccessToken && wabaId) {
            const tplResp = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&language=${languageCode}`, { method: 'GET', headers: { 'Authorization': `Bearer ${metaAccessToken}` } });
            if (tplResp.ok) {
              const tplData = await tplResp.json();
              if (tplData.data?.[0]) {
                const tpl = tplData.data[0];
                const bodyC = tpl.components?.find((c: any) => c.type === 'BODY');
                const headerC = tpl.components?.find((c: any) => c.type === 'HEADER');
                let ft = '';
                if (headerC?.text) ft += headerC.text + '\n\n';
                if (bodyC?.text) ft += bodyC.text;
                templateText = ft;
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ [CREATE LEAD] Erro ao buscar texto template:', err);
        }

        const saveResult = await saveOutboundMessage({ conversationId: conversation.id, type: 'template', body: templateText, providerMessageId: sendResult.messageId, templateName, toPhoneE164: phoneNumber });
        templateResult = { sent: true, messageId: sendResult.messageId, dbMessageId: saveResult.dbMessageId, templateText };
      } else {
        console.error('❌ [CREATE LEAD] Falha template:', sendResult.error);
        templateResult = { sent: false, error: sendResult.error };
      }
    }

    console.log('🏁 [CREATE LEAD + ONBOARDING] Completo! Lead:', newLead.id);

    return c.json({
      success: true,
      lead: newLead,
      contact,
      conversation,
      template: templateResult,
      alreadyExisted,
      message: shouldSendTemplate
        ? 'Lead criado, contato/conversa configurados e template disparado!'
        : 'Lead criado, contato/conversa configurados!',
    });

  } catch (error) {
    console.error('❌ [CREATE LEAD] Exceção:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

/**
 * POST /api/crm/leads/db-webhook
 * DATABASE WEBHOOK — Disparado automaticamente pelo Supabase no INSERT da tabela `leads`.
 * 
 * Payload do Supabase Database Webhook:
 * {
 *   "type": "INSERT",
 *   "table": "leads",
 *   "schema": "public",
 *   "record": { id, nome_completo, telefone, id_unidade, ... },
 *   "old_record": null
 * }
 * 
 * Fluxo: INSERT detectado → verifica se lead tem contato → cria contact → conversation → dispara template
 */
app.post("/make-server-844b77a1/api/crm/leads/db-webhook", async (c) => {
  try {
    const body = await c.req.json();

    console.log('\n🔔 [DB WEBHOOK] Evento recebido na tabela leads');
    console.log('- Tipo:', body.type);
    console.log('- Tabela:', body.table);
    console.log('- Schema:', body.schema);

    // Só processar INSERTs
    if (body.type !== 'INSERT') {
      console.log('⏭️ [DB WEBHOOK] Ignorando evento:', body.type);
      return c.json({ success: true, skipped: true, reason: `Evento ${body.type} ignorado` });
    }

    const record = body.record;
    if (!record) {
      console.error('❌ [DB WEBHOOK] Payload sem record');
      return c.json({ success: false, error: 'Payload inválido: sem record' }, 400);
    }

    console.log('📋 [DB WEBHOOK] Lead recebido:');
    console.log('- ID:', record.id);
    console.log('- Nome:', record.nome_completo);
    console.log('- Telefone:', record.telefone);
    console.log('- Unidade:', record.id_unidade);
    console.log('- id_contact:', record.id_contact);
    console.log('- situacao:', record.situacao);

    // Corrigir situacao NULL/vazia → 'novo' diretamente no banco
    if (!record.situacao) {
      console.log('⚠️ [DB WEBHOOK] Lead sem situacao → corrigindo para "novo" no banco');
      await supabaseAdmin
        .from('leads')
        .update({ situacao: 'novo' })
        .eq('id', record.id);
      record.situacao = 'novo';
    }

    // Se já tem contato vinculado, pular onboarding
    if (record.id_contact) {
      console.log('⏭️ [DB WEBHOOK] Lead já tem id_contact:', record.id_contact, '— pulando');
      return c.json({ success: true, skipped: true, reason: 'Lead já possui contato vinculado' });
    }

    // Validar campos mínimos
    if (!record.telefone) {
      console.warn('⚠️ [DB WEBHOOK] Lead sem telefone');
      return c.json({ success: true, skipped: true, reason: 'Lead sem telefone' });
    }

    if (!record.id_unidade) {
      console.warn('⚠️ [DB WEBHOOK] Lead sem id_unidade');
      return c.json({ success: true, skipped: true, reason: 'Lead sem id_unidade' });
    }

    // ── Normalizar telefone ─────────────────────────────────────
    let phoneNumber = record.telefone.replace(/\D/g, '');
    if (!phoneNumber.startsWith('55')) {
      phoneNumber = '55' + phoneNumber;
    }

    const nameParts = (record.nome_completo || 'Lead').trim().split(/\s+/);
    const nome = nameParts[0];
    const sobrenome = nameParts.slice(1).join(' ') || null;

    console.log('📞 [DB WEBHOOK] Telefone normalizado:', phoneNumber);

    // ── Verificar se contato já existe ──────────────────────────
    const { data: existingContact } = await supabaseAdmin
      .from('contacts')
      .select('id, display_name')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    let contact: any = null;
    let conversation: any = null;
    let templateResult: any = null;
    let alreadyExisted = false;

    if (existingContact) {
      console.log('⚠️ [DB WEBHOOK] Contato já existe:', existingContact.id);
      alreadyExisted = true;
      contact = existingContact;

      // Vincular bidirecional
      await supabaseAdmin.from('leads').update({ id_contact: existingContact.id }).eq('id', record.id);
      await supabaseAdmin.from('contacts').update({ id_lead: record.id }).eq('id', existingContact.id);

      // Buscar/criar conversa
      const { data: existingConvs } = await supabaseAdmin
        .from('conversations')
        .select('id')
        .eq('contact_id', existingContact.id)
        .order('updated_at', { ascending: false })
        .limit(1);

      conversation = existingConvs?.[0] || null;

      if (!conversation) {
        const { data: newConv } = await supabaseAdmin
          .from('conversations')
          .insert({
            contact_id: existingContact.id,
            unit_id: record.id_unidade,
            status: 'open',
            assigned_user_id: null,
            last_message_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        conversation = newConv;
        console.log('✅ [DB WEBHOOK] Conversa criada para contato existente:', newConv?.id);
      }
    } else {
      // ── Criar contato novo ──
      const displayName = [nome, sobrenome].filter(Boolean).join(' ');

      const { data: newContact, error: contactError } = await supabaseAdmin
        .from('contacts')
        .insert({
          wa_id: phoneNumber,
          phone_number: phoneNumber,
          first_name: nome,
          last_name: sobrenome || null,
          display_name: displayName,
          unit_id: record.id_unidade,
          situation: 'lead',
          id_profile_created: null,
          id_profile_responsavel: null,
          id_lead: record.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (contactError) {
        console.error('❌ [DB WEBHOOK] Erro ao criar contato:', contactError);
        return c.json({ success: false, error: `Erro ao criar contato: ${contactError.message}` }, 500);
      }

      console.log('✅ [DB WEBHOOK] Contato criado:', newContact.id);
      contact = newContact;

      // Vincular lead → contact
      await supabaseAdmin.from('leads').update({ id_contact: newContact.id }).eq('id', record.id);

      // Criar conversa
      const { data: newConversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .insert({
          contact_id: newContact.id,
          unit_id: record.id_unidade,
          status: 'open',
          assigned_user_id: null,
          last_message_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (convError) {
        console.error('❌ [DB WEBHOOK] Erro ao criar conversa:', convError);
        return c.json({ success: false, error: `Erro ao criar conversa: ${convError.message}` }, 500);
      }

      console.log('✅ [DB WEBHOOK] Conversa criada:', newConversation.id);
      conversation = newConversation;

      // Registrar evento
      await supabaseAdmin.from('conversation_events').insert({
        conversation_id: newConversation.id,
        event_type: 'created',
        actor_user_id: null,
        metadata: { source: 'db_webhook_insert', lead_id: record.id },
      });
    }

    // ── Disparar template ───────────────────────────────────────
    if (conversation) {
      console.log('📤 [DB WEBHOOK] Disparando template automacao_lead...');

      const templateName = 'automacao_lead';
      const languageCode = 'pt_BR';

      const sendResult = await whatsapp.sendWhatsAppTemplate({
        to: phoneNumber,
        templateName,
        languageCode,
        components: [],
      });

      console.log('📡 [DB WEBHOOK] Resultado template:', JSON.stringify(sendResult, null, 2));

      if (sendResult.success) {
        console.log('✅ [DB WEBHOOK] Template enviado! Message ID:', sendResult.messageId);

        let templateText = templateName;
        try {
          const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
          const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';
          if (metaAccessToken && wabaId) {
            const tplResp = await fetch(
              `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&language=${languageCode}`,
              { method: 'GET', headers: { 'Authorization': `Bearer ${metaAccessToken}` } }
            );
            if (tplResp.ok) {
              const tplData = await tplResp.json();
              if (tplData.data?.[0]) {
                const tpl = tplData.data[0];
                const bodyC = tpl.components?.find((c: any) => c.type === 'BODY');
                const headerC = tpl.components?.find((c: any) => c.type === 'HEADER');
                let ft = '';
                if (headerC?.text) ft += headerC.text + '\n\n';
                if (bodyC?.text) ft += bodyC.text;
                templateText = ft;
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ [DB WEBHOOK] Erro ao buscar texto template:', err);
        }

        // Registrar mensagem
        const saveResult = await saveOutboundMessage({
          conversationId: conversation.id,
          type: 'template',
          body: templateText,
          providerMessageId: sendResult.messageId,
          templateName,
          toPhoneE164: phoneNumber,
        });

        console.log('✅ [DB WEBHOOK] Mensagem registrada:', saveResult);
        templateResult = { sent: true, messageId: sendResult.messageId, dbMessageId: saveResult.dbMessageId };
      } else {
        console.error('❌ [DB WEBHOOK] Falha ao enviar template:', sendResult.error);
        templateResult = { sent: false, error: sendResult.error };
      }
    }

    console.log('🏁 [DB WEBHOOK] Onboarding completo para lead:', record.id);

    return c.json({
      success: true,
      lead_id: record.id,
      contact_id: contact?.id,
      conversation_id: conversation?.id,
      template: templateResult,
      alreadyExisted,
      message: 'Onboarding automático executado via Database Webhook!',
    });

  } catch (error) {
    console.error('❌ [DB WEBHOOK] Exceção:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

/**
 * POST /api/crm/lead-onboarding
 * Cascata completa: Cria contato → conversa → dispara template → registra mensagem.
 * 
 * 🔑 REGRAS CRM:
 *    - Contato SEM responsável (id_profile_responsavel: null)
 *    - Conversa SEM atendente (assigned_user_id: null)
 *    - Apenas unit_id é definido
 *    - Referência bidirecional: leads.id_contact ↔ contacts.id_lead
 * 
 * @param lead_id     - ID do lead recém-criado
 * @param phone       - Telefone do lead
 * @param nome        - Primeiro nome
 * @param sobrenome   - Sobrenome (opcional)
 * @param unit_id     - ID da unidade
 * @param sendTemplate - Se true, dispara template "automacao_lead"
 * @param token       - JWT do usuário logado
 */
app.post("/make-server-844b77a1/api/crm/lead-onboarding", async (c) => {
  try {
    const body = await c.req.json();
    const { lead_id, phone, nome, sobrenome, unit_id, sendTemplate, token } = body;

    console.log('\n🚀 [LEAD ONBOARDING] Iniciando cascata...');
    console.log('- Lead ID:', lead_id);
    console.log('- Telefone:', phone);
    console.log('- Nome:', nome, sobrenome);
    console.log('- Unit ID:', unit_id);
    console.log('- Enviar Template:', sendTemplate);

    // ── Validação ───────────────────────────────────────────────
    if (!lead_id || !phone || !nome || !unit_id) {
      return c.json({ success: false, error: 'Campos obrigatórios: lead_id, phone, nome, unit_id' }, 400);
    }

    if (!token) {
      return c.json({ success: false, error: 'Token de autenticação não fornecido' }, 401);
    }

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return c.json({ success: false, error: 'Token inválido ou expirado' }, 401);
    }

    console.log('✅ [LEAD ONBOARDING] Usuário autenticado:', user.email);

    // ── Normalizar telefone ─────────────────────────────────────
    let phoneNumber = phone.replace(/\D/g, '');
    if (!phoneNumber.startsWith('55')) {
      phoneNumber = '55' + phoneNumber;
    }

    // ── Verificar se já existe contato para esse telefone ───────
    const { data: existingContact } = await supabaseAdmin
      .from('contacts')
      .select('id, display_name')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    if (existingContact) {
      console.log('⚠️ [LEAD ONBOARDING] Contato já existe:', existingContact.id, existingContact.display_name);
      
      // Vincular lead ↔ contact (bidirecional) mesmo que já exista
      await supabaseAdmin.from('leads').update({ id_contact: existingContact.id }).eq('id', lead_id);
      await supabaseAdmin.from('contacts').update({ id_lead: lead_id }).eq('id', existingContact.id);

      // Buscar conversa existente
      const { data: existingConvs } = await supabaseAdmin
        .from('conversations')
        .select(`
          *,
          contact:contacts!conversations_contact_id_fkey(*),
          unit:units!conversations_unit_id_fkey(id, name),
          assigned_user:profiles!conversations_assigned_user_id_fkey(*)
        `)
        .eq('contact_id', existingContact.id)
        .order('updated_at', { ascending: false })
        .limit(1);

      let conversation = existingConvs?.[0] || null;

      // Se não tem conversa, cria uma
      if (!conversation) {
        const { data: newConv } = await supabaseAdmin
          .from('conversations')
          .insert({
            contact_id: existingContact.id,
            unit_id: unit_id,
            status: 'open',
            assigned_user_id: null,
            last_message_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select(`
            *,
            contact:contacts!conversations_contact_id_fkey(*),
            unit:units!conversations_unit_id_fkey(id, name),
            assigned_user:profiles!conversations_assigned_user_id_fkey(*)
          `)
          .single();
        
        if (newConv) {
          newConv.tags = [];
          conversation = newConv;
        }
      } else {
        // Buscar tags
        const { data: convTags } = await supabaseAdmin
          .from('conversation_tags')
          .select('tag:tags(*)')
          .eq('conversation_id', conversation.id);
        conversation.tags = convTags?.map((ct: any) => ct.tag).filter(Boolean) || [];
      }

      // ── Disparar template mesmo para contato existente ──────────
      let existingTemplateResult: any = null;

      if (sendTemplate && conversation) {
        console.log('📤 [LEAD ONBOARDING] Contato já existia, mas sendTemplate=true. Disparando template...');

        const templateName = 'automacao_lead';
        const languageCode = 'pt_BR';

        const sendResult = await whatsapp.sendWhatsAppTemplate({
          to: phoneNumber,
          templateName,
          languageCode,
          components: [],
        });

        console.log('📡 [LEAD ONBOARDING] Resultado do envio (existing):', JSON.stringify(sendResult, null, 2));

        if (sendResult.success) {
          console.log('✅ [LEAD ONBOARDING] Template enviado para contato existente! Message ID:', sendResult.messageId);

          // Buscar texto do template
          let templateText = templateName;
          try {
            const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
            const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';

            if (metaAccessToken && wabaId) {
              const templateResponse = await fetch(
                `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&language=${languageCode}`,
                { method: 'GET', headers: { 'Authorization': `Bearer ${metaAccessToken}` } }
              );

              if (templateResponse.ok) {
                const templateData = await templateResponse.json();
                if (templateData.data && templateData.data.length > 0) {
                  const template = templateData.data[0];
                  const bodyComp = template.components?.find((c: any) => c.type === 'BODY');
                  const headerComp = template.components?.find((c: any) => c.type === 'HEADER');
                  let fullText = '';
                  if (headerComp?.text) fullText += headerComp.text + '\n\n';
                  if (bodyComp?.text) fullText += bodyComp.text;
                  templateText = fullText;
                }
              }
            }
          } catch (err) {
            console.warn('⚠️ [LEAD ONBOARDING] Erro ao buscar texto do template (existing):', err);
          }

          // Registrar mensagem no banco
          const saveResult = await saveOutboundMessage({
            conversationId: conversation.id,
            type: 'template',
            body: templateText,
            providerMessageId: sendResult.messageId,
            templateName,
            toPhoneE164: phoneNumber,
          });

          console.log('✅ [LEAD ONBOARDING] Mensagem registrada (existing):', saveResult);

          existingTemplateResult = {
            sent: true,
            messageId: sendResult.messageId,
            dbMessageId: saveResult.dbMessageId,
            templateText,
          };
        } else {
          console.error('❌ [LEAD ONBOARDING] Falha ao enviar template (existing):', sendResult.error);
          existingTemplateResult = {
            sent: false,
            error: sendResult.error,
          };
        }
      } else if (sendTemplate && !conversation) {
        console.warn('⚠️ [LEAD ONBOARDING] sendTemplate=true mas não há conversa para registrar mensagem');
        existingTemplateResult = { sent: false, error: 'Conversa não encontrada/criada' };
      }

      return c.json({
        success: true,
        alreadyExisted: true,
        contact: existingContact,
        conversation,
        template: existingTemplateResult,
        message: sendTemplate
          ? 'Contato já existia. Referências vinculadas e template disparado.'
          : 'Contato já existia. Referências vinculadas.',
      });
    }

    // ── ETAPA 1: Criar Contato ──────────────────────────────────
    const displayName = [nome, sobrenome].filter(Boolean).join(' ');

    const { data: newContact, error: contactError } = await supabaseAdmin
      .from('contacts')
      .insert({
        wa_id: phoneNumber,
        phone_number: phoneNumber,
        first_name: nome,
        last_name: sobrenome || null,
        display_name: displayName,
        unit_id: unit_id,
        situation: 'lead',
        id_profile_created: user.id,
        id_profile_responsavel: null,
        id_lead: lead_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (contactError) {
      console.error('❌ [LEAD ONBOARDING] Erro ao criar contato:', contactError);
      return c.json({ success: false, error: `Erro ao criar contato: ${contactError.message}` }, 500);
    }

    console.log('✅ [LEAD ONBOARDING] ETAPA 1 - Contato criado:', newContact.id);

    // ── ETAPA 1.5: Vincular lead ↔ contact (bidirecional) ──────
    const { error: linkError } = await supabaseAdmin
      .from('leads')
      .update({ id_contact: newContact.id })
      .eq('id', lead_id);

    if (linkError) {
      console.warn('⚠️ [LEAD ONBOARDING] Erro ao vincular id_contact no lead:', linkError);
    } else {
      console.log('🔗 [LEAD ONBOARDING] Lead.id_contact vinculado:', newContact.id);
    }

    // ── ETAPA 2: Criar Conversa ─────────────────────────────────
    const { data: newConversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .insert({
        contact_id: newContact.id,
        unit_id: unit_id,
        status: 'open',
        assigned_user_id: null,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select(`
        *,
        contact:contacts!conversations_contact_id_fkey(*),
        unit:units!conversations_unit_id_fkey(id, name),
        assigned_user:profiles!conversations_assigned_user_id_fkey(*)
      `)
      .single();

    if (convError) {
      console.error('❌ [LEAD ONBOARDING] Erro ao criar conversa:', convError);
      // Rollback: apagar contato criado
      await supabaseAdmin.from('contacts').delete().eq('id', newContact.id);
      await supabaseAdmin.from('leads').update({ id_contact: null }).eq('id', lead_id);
      return c.json({ success: false, error: `Erro ao criar conversa: ${convError.message}` }, 500);
    }

    console.log('✅ [LEAD ONBOARDING] ETAPA 2 - Conversa criada:', newConversation.id);

    // Registrar evento de criação
    await supabaseAdmin.from('conversation_events').insert({
      conversation_id: newConversation.id,
      event_type: 'created',
      actor_user_id: user.id,
      metadata: { source: 'crm_lead_onboarding', lead_id, lead_phone: phoneNumber },
    });

    newConversation.tags = [];

    // ── ETAPA 3 & 4: Disparar Template + Registrar Mensagem ────
    let templateResult: any = null;

    if (sendTemplate) {
      console.log('📤 [LEAD ONBOARDING] ETAPA 3 - Disparando template automacao_lead...');

      const templateName = 'automacao_lead';
      const languageCode = 'pt_BR';

      // Template automacao_lead não usa variáveis — enviar sem components
      const sendResult = await whatsapp.sendWhatsAppTemplate({
        to: phoneNumber,
        templateName,
        languageCode,
        components: [],
      });

      console.log('📡 [LEAD ONBOARDING] Resultado do envio:', JSON.stringify(sendResult, null, 2));

      if (sendResult.success) {
        console.log('✅ [LEAD ONBOARDING] ETAPA 3 - Template enviado! Message ID:', sendResult.messageId);

        // ── Buscar texto completo do template da Meta ──
        let templateText = templateName;
        try {
          const metaAccessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
          const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID') || '';

          if (metaAccessToken && wabaId) {
            const templateResponse = await fetch(
              `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&language=${languageCode}`,
              {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${metaAccessToken}` },
              }
            );

            if (templateResponse.ok) {
              const templateData = await templateResponse.json();
              if (templateData.data && templateData.data.length > 0) {
                const template = templateData.data[0];
                const bodyComp = template.components?.find((c: any) => c.type === 'BODY');
                const headerComp = template.components?.find((c: any) => c.type === 'HEADER');

                let fullText = '';
                if (headerComp?.text) fullText += headerComp.text + '\n\n';
                if (bodyComp?.text) fullText += bodyComp.text;

                templateText = fullText; // Sem variáveis para processar
                console.log('✅ [LEAD ONBOARDING] Texto do template obtido:', templateText.substring(0, 100) + '...');
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ [LEAD ONBOARDING] Erro ao buscar texto do template, usando nome:', err);
        }

        // ── ETAPA 4: Registrar mensagem no banco ──
        const saveResult = await saveOutboundMessage({
          conversationId: newConversation.id,
          type: 'template',
          body: templateText,
          providerMessageId: sendResult.messageId,
          templateName,
          toPhoneE164: phoneNumber,
        });

        console.log('✅ [LEAD ONBOARDING] ETAPA 4 - Mensagem registrada:', saveResult);

        templateResult = {
          sent: true,
          messageId: sendResult.messageId,
          dbMessageId: saveResult.dbMessageId,
          templateText,
        };
      } else {
        console.error('❌ [LEAD ONBOARDING] Falha ao enviar template:', sendResult.error);
        templateResult = {
          sent: false,
          error: sendResult.error,
        };
        // Não falhar o onboarding inteiro — contato e conversa já foram criados
      }
    } else {
      console.log('⏭️ [LEAD ONBOARDING] Template não solicitado. Pulando etapas 3 e 4.');
    }

    console.log('🏁 [LEAD ONBOARDING] Cascata completa para lead:', lead_id);

    return c.json({
      success: true,
      alreadyExisted: false,
      contact: newContact,
      conversation: newConversation,
      template: templateResult,
      message: sendTemplate
        ? 'Contato, conversa criados e template disparado com sucesso!'
        : 'Contato e conversa criados com sucesso!',
    });

  } catch (error) {
    console.error('❌ [LEAD ONBOARDING] Exceção:', error);
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }, 500);
  }
});

// ========================================
// 📊 DASHBOARD - META ANALYTICS & COSTS
// ========================================

/**
 * GET /api/dashboard/meta-analytics
 * Busca dados de custo de conversas e analytics de templates da API da Meta
 * Usa: Conversation Analytics API + Template Analytics API
 * PÚBLICO - Para o dashboard
 */
app.get("/make-server-844b77a1/api/dashboard/meta-analytics", async (c) => {
  console.log('\n📊 [META ANALYTICS] Buscando dados de custo e analytics...');

  try {
    const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const wabaId = Deno.env.get('META_WHATSAPP_WABA_ID');

    if (!accessToken || !wabaId) {
      console.error('❌ [META ANALYTICS] Credenciais Meta não configuradas');
      return c.json({
        success: false,
        error: 'Credenciais Meta (ACCESS_TOKEN ou WABA_ID) não configuradas'
      }, 400);
    }

    // Parâmetros de período (query string)
    const daysParam = c.req.query('days') || '30';
    const days = parseInt(daysParam);
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const endTimestamp = Math.floor(now.getTime() / 1000);

    console.log(`📅 Período: ${days} dias (${startDate.toISOString()} → ${now.toISOString()})`);

    // ── 1) Conversation Analytics (Custo + Volume por Categoria, granularidade DAILY) ──
    let conversationAnalytics = null;
    try {
      const convAnalyticsUrl = `https://graph.facebook.com/v21.0/${wabaId}` +
        `?fields=conversation_analytics` +
        `.start(${startTimestamp})` +
        `.end(${endTimestamp})` +
        `.granularity(DAILY)` +
        `.dimensions(CONVERSATION_CATEGORY,CONVERSATION_DIRECTION)` +
        `.metric_types(COST,CONVERSATION)`;

      console.log('📡 [1/3] Buscando Conversation Analytics...');
      const convResponse = await fetch(convAnalyticsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (convResponse.ok) {
        const convData = await convResponse.json();
        conversationAnalytics = convData.conversation_analytics;
        console.log('✅ Conversation Analytics recebido');
      } else {
        const errText = await convResponse.text();
        console.warn('⚠️ Conversation Analytics falhou:', convResponse.status, errText);
      }
    } catch (err) {
      console.warn('⚠️ Erro ao buscar Conversation Analytics:', err);
    }

    // ── 2) Conversation Analytics por Categoria (agregado) ──
    let categorySummary = null;
    try {
      const catUrl = `https://graph.facebook.com/v21.0/${wabaId}` +
        `?fields=conversation_analytics` +
        `.start(${startTimestamp})` +
        `.end(${endTimestamp})` +
        `.granularity(DAILY)` +
        `.dimensions(CONVERSATION_CATEGORY)` +
        `.metric_types(COST,CONVERSATION)`;

      console.log('📡 [2/3] Buscando Category Summary...');
      const catResponse = await fetch(catUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (catResponse.ok) {
        const catData = await catResponse.json();
        categorySummary = catData.conversation_analytics;
        console.log('✅ Category Summary recebido');
      } else {
        const errText = await catResponse.text();
        console.warn('⚠️ Category Summary falhou:', catResponse.status, errText);
      }
    } catch (err) {
      console.warn('⚠️ Erro ao buscar Category Summary:', err);
    }

    // ── 3) Template Analytics ──
    let templateAnalytics = null;
    try {
      const tmplUrl = `https://graph.facebook.com/v21.0/${wabaId}` +
        `?fields=template_analytics` +
        `.start(${startTimestamp})` +
        `.end(${endTimestamp})` +
        `.granularity(DAILY)` +
        `.metric_types(SENT,DELIVERED,READ,CLICKED)`;

      console.log('📡 [3/3] Buscando Template Analytics...');
      const tmplResponse = await fetch(tmplUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (tmplResponse.ok) {
        const tmplData = await tmplResponse.json();
        templateAnalytics = tmplData.template_analytics;
        console.log('✅ Template Analytics recebido');
      } else {
        const errText = await tmplResponse.text();
        console.warn('⚠️ Template Analytics falhou:', tmplResponse.status, errText);
      }
    } catch (err) {
      console.warn('⚠️ Erro ao buscar Template Analytics:', err);
    }

    // ── Processar dados ──
    const result: any = {
      success: true,
      period: { days, start: startDate.toISOString(), end: now.toISOString() },
      conversationAnalytics: null,
      categorySummary: null,
      templateAnalytics: null,
    };

    // Processar Conversation Analytics (custo diário)
    if (conversationAnalytics?.data) {
      const dailyCosts: Record<string, { cost: number; conversations: number }> = {};

      for (const point of conversationAnalytics.data) {
        if (point.data_points) {
          for (const dp of point.data_points) {
            const date = dp.start ? new Date(dp.start * 1000).toISOString().split('T')[0] : 'unknown';
            const cost = dp.cost || 0;
            const convCount = dp.conversation || 0;

            if (!dailyCosts[date]) dailyCosts[date] = { cost: 0, conversations: 0 };
            dailyCosts[date].cost += cost;
            dailyCosts[date].conversations += convCount;
          }
        }
      }

      result.conversationAnalytics = {
        raw: conversationAnalytics,
        dailyCosts: Object.entries(dailyCosts).map(([date, data]) => ({
          date,
          cost: data.cost,
          conversations: data.conversations,
        })).sort((a, b) => a.date.localeCompare(b.date)),
      };
    }

    // Processar Category Summary (custo por categoria)
    if (categorySummary?.data) {
      const categories: Record<string, { cost: number; conversations: number }> = {};
      let totalCost = 0;
      let totalConversations = 0;

      for (const point of categorySummary.data) {
        if (point.data_points) {
          for (const dp of point.data_points) {
            const cat = dp.conversation_category || 'UNKNOWN';
            const cost = dp.cost || 0;
            const convCount = dp.conversation || 0;

            if (!categories[cat]) categories[cat] = { cost: 0, conversations: 0 };
            categories[cat].cost += cost;
            categories[cat].conversations += convCount;
            totalCost += cost;
            totalConversations += convCount;
          }
        }
      }

      const categoryLabels: Record<string, string> = {
        AUTHENTICATION: 'Autenticação',
        MARKETING: 'Marketing',
        UTILITY: 'Utilidade',
        SERVICE: 'Serviço',
        REFERRAL_CONVERSION: 'Referral',
        UNKNOWN: 'Outros',
      };

      result.categorySummary = {
        raw: categorySummary,
        totalCost,
        totalConversations,
        categories: Object.entries(categories).map(([name, data]) => ({
          name,
          label: categoryLabels[name] || name,
          cost: data.cost,
          conversations: data.conversations,
        })),
      };
    }

    // Processar Template Analytics
    if (templateAnalytics?.data) {
      const templates: Record<string, { sent: number; delivered: number; read: number; clicked: number }> = {};

      for (const point of templateAnalytics.data) {
        if (point.data_points) {
          for (const dp of point.data_points) {
            const tmplName = dp.template_id || dp.template_name || 'unknown';
            if (!templates[tmplName]) templates[tmplName] = { sent: 0, delivered: 0, read: 0, clicked: 0 };
            templates[tmplName].sent += dp.sent || 0;
            templates[tmplName].delivered += dp.delivered || 0;
            templates[tmplName].read += dp.read || 0;
            templates[tmplName].clicked += dp.clicked || 0;
          }
        }
      }

      result.templateAnalytics = {
        raw: templateAnalytics,
        templates: Object.entries(templates).map(([name, data]) => ({
          name,
          ...data,
          deliveryRate: data.sent > 0 ? Math.round((data.delivered / data.sent) * 100) : 0,
          readRate: data.delivered > 0 ? Math.round((data.read / data.delivered) * 100) : 0,
        })),
      };
    }

    console.log('✅ [META ANALYTICS] Dados processados com sucesso');
    return c.json(result);

  } catch (error) {
    console.error('❌ [META ANALYTICS] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }, 500);
  }
});

// ========================================
// 🏢 PROFILE UNITS — GERENCIAR UNIDADES VINCULADAS
// ========================================

/**
 * GET /api/my-units
 * Retorna as unidades vinculadas do PRÓPRIO usuário autenticado
 * Qualquer usuário autenticado pode chamar (não requer cargo especial)
 * Usado pelo useUserProfile para obter unitIds sem depender de RLS
 */
app.get("/make-server-844b77a1/api/my-units", authMiddleware, async (c) => {
  const userId = c.get('userId');

  try {
    console.log(`🏢 [MY_UNITS] Buscando unidades do próprio usuário ${userId}`);

    const { data, error } = await supabaseAdmin
      .from('profile_units')
      .select('unit_id, is_primary, unit:units!profile_units_unit_id_fkey(id, name)')
      .eq('profile_id', userId);

    if (error) {
      console.error('❌ [MY_UNITS] Erro ao buscar:', error);
      return c.json({ success: true, units: [] });
    }

    console.log(`✅ [MY_UNITS] ${data?.length || 0} unidades encontradas para ${userId}`);
    return c.json({ success: true, units: data || [] });
  } catch (error) {
    console.error('❌ [MY_UNITS] Exceção:', error);
    return c.json({ success: true, units: [] });
  }
});

/**
 * GET /api/profile-units/:profileId
 * Retorna as unidades vinculadas a um perfil
 * Requer autenticação + cargo admin/gerente
 */
app.get("/make-server-844b77a1/api/profile-units/:profileId", authMiddleware, async (c) => {
  const profileId = c.req.param('profileId');
  const userId = c.get('userId');

  try {
    console.log(`🏢 [PROFILE_UNITS] GET unidades do perfil ${profileId}, solicitado por ${userId}`);

    // Verificar se o solicitante tem cargo de gestão
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('id_cargo, cargo:cargos!profiles_id_cargo_fkey(papeis)')
      .eq('id', userId)
      .single();

    const callerCargo = (callerProfile?.cargo as any)?.papeis?.toLowerCase() || '';
    const isCallerAdmin = callerCargo.includes('administrador') || callerCargo.includes('gerente');

    if (!isCallerAdmin) {
      return c.json({ success: false, error: 'Permissão insuficiente' }, 403);
    }

    const { data, error } = await supabaseAdmin
      .from('profile_units')
      .select('unit_id, is_primary')
      .eq('profile_id', profileId);

    if (error) throw error;

    return c.json({ success: true, units: data || [] });
  } catch (error) {
    console.error('❌ [PROFILE_UNITS] Erro ao buscar:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro ao buscar unidades do perfil'
    }, 500);
  }
});

/**
 * PUT /api/profile-units/:profileId
 * Substitui TODAS as unidades vinculadas a um perfil (delete + insert)
 * Body: { units: [{ unit_id: number, is_primary: boolean }] }
 * Requer autenticação + cargo Administrador
 */
app.put("/make-server-844b77a1/api/profile-units/:profileId", authMiddleware, async (c) => {
  const profileId = c.req.param('profileId');
  const userId = c.get('userId');

  try {
    const body = await c.req.json();
    const units: { unit_id: number; is_primary: boolean }[] = body.units || [];

    console.log(`🏢 [PROFILE_UNITS] PUT ${units.length} unidades para perfil ${profileId}, solicitado por ${userId}`);

    // Verificar se o solicitante é Administrador
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('id_cargo, cargo:cargos!profiles_id_cargo_fkey(papeis)')
      .eq('id', userId)
      .single();

    const callerCargo = (callerProfile?.cargo as any)?.papeis?.toLowerCase() || '';
    const isFullAdmin = callerCargo.includes('administrador');

    if (!isFullAdmin) {
      console.warn(`⚠️ [PROFILE_UNITS] Usuário ${userId} (${callerCargo}) tentou alterar unidades sem permissão`);
      return c.json({ success: false, error: 'Apenas Administradores podem alterar unidades de usuários' }, 403);
    }

    // 1. Deletar todas as vinculações anteriores
    const { error: deleteError } = await supabaseAdmin
      .from('profile_units')
      .delete()
      .eq('profile_id', profileId);

    if (deleteError) {
      console.error('❌ [PROFILE_UNITS] Erro ao deletar:', deleteError);
      throw deleteError;
    }

    // 2. Inserir as novas vinculações
    if (units.length > 0) {
      // Garantir que pelo menos uma é primary
      const hasPrimary = units.some(u => u.is_primary);
      const unitsToInsert = hasPrimary
        ? units
        : units.map((u, i) => ({ ...u, is_primary: i === 0 }));

      const { error: insertError } = await supabaseAdmin
        .from('profile_units')
        .insert(
          unitsToInsert.map(u => ({
            profile_id: profileId,
            unit_id: u.unit_id,
            is_primary: u.is_primary,
          }))
        );

      if (insertError) {
        console.error('❌ [PROFILE_UNITS] Erro ao inserir:', insertError);
        throw insertError;
      }
    }

    console.log(`✅ [PROFILE_UNITS] ${units.length} unidades salvas para ${profileId}`);

    return c.json({ success: true, count: units.length });
  } catch (error) {
    console.error('❌ [PROFILE_UNITS] Exceção:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Erro ao salvar unidades do perfil'
    }, 500);
  }
});

// ========================================
// 🚀 START SERVER
// ========================================

// Inicializar storage na primeira execução
initializeStorage().catch(console.error);

Deno.serve(app.fetch);