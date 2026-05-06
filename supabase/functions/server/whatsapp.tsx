/**
 * Integração com WhatsApp Cloud API da Meta
 * Documentação: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const META_API_VERSION = 'v21.0'; // Atualizado de v19.0 (depreciada) para v21.0
const META_API_BASE_URL = 'https://graph.facebook.com';

/**
 * Interface para template da API da Meta
 */
export interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  components?: Array<{
    type: string;
    format?: string;
    text?: string;
    parameters?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
}

/**
 * Interface para envio de template
 */
export interface SendTemplateParams {
  to: string; // Número no formato E.164 (ex: 5511987654321, sem +)
  templateName: string;
  languageCode: string;
  components?: Array<{
    type: string;
    parameters?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
}

/**
 * Envia um template aprovado via WhatsApp Cloud API
 */
export async function sendWhatsAppTemplate(params: SendTemplateParams): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
  details?: any;
}> {
  try {
    // 🔥 Limpar token (remover espaços e caracteres invisíveis)
    const rawToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const accessToken = rawToken?.trim().replace(/[\r\n\t]/g, '');
    const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID')?.trim();

    console.log('\n📨 Enviando template via WhatsApp Cloud API');

    if (!accessToken) {
      console.error('❌ META_WHATSAPP_ACCESS_TOKEN não configurado');
      return {
        success: false,
        error: 'WhatsApp Access Token não configurado. Configure nas variáveis de ambiente.'
      };
    }

    if (!phoneNumberId) {
      console.error('❌ META_WHATSAPP_PHONE_NUMBER_ID não configurado');
      return {
        success: false,
        error: 'WhatsApp Phone Number ID não configurado. Configure nas variáveis de ambiente.'
      };
    }

    console.log('\n📋 DADOS DO ENVIO:');
    console.log('- Template:', params.templateName);
    console.log('- Language:', params.languageCode);
    console.log('- To:', params.to);
    console.log('- Components:', params.components ? `${params.components.length} component(s)` : 'Nenhum');

    // Preparar número de destino (remover + se existir)
    const toNumber = params.to.replace(/\+/g, '');
    console.log('- To (limpo):', toNumber);

    // Montar payload da API
    const payload: any = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'template',
      template: {
        name: params.templateName,
        language: {
          code: params.languageCode
        }
      }
    };

    // Adicionar components se existirem
    if (params.components && params.components.length > 0) {
      // 🔥 VALIDAÇÃO CRÍTICA: Verificar se há parâmetros vazios
      console.log('\n🔍 ====== VALIDANDO COMPONENTS ANTES DO ENVIO ======');
      console.log('📊 Total de components:', params.components.length);
      
      let hasEmptyParams = false;
      const emptyParamsList: string[] = [];
      
      params.components.forEach((comp: any, compIndex: number) => {
        console.log(`\n📦 Component ${compIndex + 1}/${params.components.length}:`);
        console.log('   - Type:', comp.type);
        console.log('   - Sub_type:', comp.sub_type || 'N/A');
        console.log('   - Index:', comp.index ?? 'N/A');
        console.log('   - Has parameters:', !!comp.parameters);
        
        if (comp.parameters) {
          console.log(`   - Parameters count: ${comp.parameters.length}`);
          
          comp.parameters.forEach((param: any, paramIndex: number) => {
            console.log(`\n   🔍 Param ${paramIndex + 1}/${comp.parameters.length}:`);
            console.log('      - Type:', param.type);
            
            // Verificar baseado no tipo de parâmetro
            if (param.type === 'text') {
              const textValue = param.text;
              const isEmpty = textValue === undefined || textValue === null || textValue === '' || (typeof textValue === 'string' && textValue.trim() === '');
              
              console.log('      - Text value:', JSON.stringify(textValue));
              console.log('      - Is undefined:', textValue === undefined);
              console.log('      - Is null:', textValue === null);
              console.log('      - Is empty string:', textValue === '');
              console.log('      - Length:', textValue?.length || 0);
              console.log('      - After trim:', typeof textValue === 'string' ? JSON.stringify(textValue.trim()) : 'N/A');
              console.log('      - Is empty (final):', isEmpty);
              
              if (isEmpty) {
                console.error('      ❌ PARÂMETRO TEXT VAZIO DETECTADO!');
                hasEmptyParams = true;
                emptyParamsList.push(`Component[${compIndex}].type=${comp.type}.param[${paramIndex}].type=text`);
              } else {
                console.log('      ✅ Parâmetro text OK');
              }
            } else if (['image', 'video', 'document'].includes(param.type)) {
              // Verificar parâmetros de mídia
              const mediaObj = param[param.type];
              const link = mediaObj?.link;
              const isEmpty = !link || link.trim() === '';
              
              console.log('      - Media type:', param.type);
              console.log('      - Media object:', mediaObj);
              console.log('      - Link:', link);
              const linkLength = link?.length || 0;
              console.log('      - Link length:', linkLength);
              console.log('      - Is empty (final):', isEmpty);
              
              if (isEmpty) {
                console.error('      ❌ PARÂMETRO MEDIA VAZIO DETECTADO!');
                hasEmptyParams = true;
                emptyParamsList.push(`Component[${compIndex}].type=${comp.type}.param[${paramIndex}].type=${param.type}`);
              } else {
                console.log('      ✅ Parâmetro media OK');
              }
            } else {
              console.log('      ⚠️ Tipo de parâmetro desconhecido:', param.type);
            }
          });
        } else {
          console.log('   ⚠️ Component sem parâmetros');
        }
      });
      
      console.log('\n' + '='.repeat(60));
      
      if (hasEmptyParams) {
        console.error('❌ VALIDAÇÃO FALHOU!');
        console.error('🚨 Parâmetros vazios encontrados:', emptyParamsList.length);
        console.error('📋 Lista de parâmetros vazios:');
        emptyParamsList.forEach(param => console.error(`   - ${param}`));
        console.error('\n💡 ISTO CAUSARÁ ERRO NA API DA META: "Parameter name is missing or empty"');
        console.error('📦 Components problemáticos:');
        console.error(JSON.stringify(params.components, null, 2));
        
        return {
          success: false,
          error: `Parâmetros inválidos detectados (${emptyParamsList.length}): Verifique se todos os campos obrigatórios foram preenchidos. Parâmetros vazios: ${emptyParamsList.join(', ')}`
        };
      }
      
      console.log('✅ VALIDAÇÃO PASSOU! Todos os parâmetros estão preenchidos corretamente');
      console.log('=' .repeat(60) + '\n');
      
      // 🔥 CRÍTICO: Só adicionar components ao payload se passar na validação
      payload.template.components = params.components;
      console.log('📦 COMPONENTS VALIDADOS E ADICIONADOS AO PAYLOAD');
    } else {
      console.log('ℹ️ Nenhum component para adicionar (template sem variáveis)');
      // 🔥 NÃO ADICIONAR o campo components ao payload se não houver components
      // Isso evita enviar "components: undefined" ou "components: []"
    }

    console.log('\n📤 PAYLOAD COMPLETO:');
    console.log(JSON.stringify(payload, null, 2));

    // Fazer requisição para a API da Meta
    const url = `${META_API_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/messages`;
    console.log('\n🔗 URL da API:', url);
    console.log('🔑 Token (primeiros 50 chars):', accessToken.substring(0, 50) + '...');
    
    console.log('\n📡 Fazendo requisição...');
    
    // 🔥 LOG DETALHADO DO PAYLOAD ANTES DE ENVIAR
    console.log('\n🔍 ====== PAYLOAD FINAL PARA A META ======');
    console.log('Template name:', payload.template.name);
    console.log('Language code:', payload.template.language.code);
    console.log('To:', payload.to);
    console.log('Has components:', !!payload.template.components);
    
    if (payload.template.components) {
      console.log('Components count:', payload.template.components.length);
      console.log('\n📋 COMPONENTS STRINGIFIED (EXACT):');
      console.log(JSON.stringify(payload.template.components, null, 2));
      
      // 🔥 ANÁLISE DETALHADA DE CADA COMPONENT
      payload.template.components.forEach((comp: any, idx: number) => {
        console.log(`\n🔎 Component ${idx}:`, comp.type);
        if (comp.parameters) {
          comp.parameters.forEach((param: any, pIdx: number) => {
            if (param.type === 'text') {
              console.log(`   Param ${pIdx}: type=text, text="${param.text}", length=${param.text?.length || 0}`);
            } else {
              console.log(`   Param ${pIdx}: type=${param.type}`, JSON.stringify(param));
            }
          });
        }
      });
    } else {
      console.log('Components: UNDEFINED (template sem variáveis)');
    }
    console.log('=' .repeat(60));
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    console.log('📊 Status da resposta:', response.status, response.statusText);

    const responseData = await response.json();
    console.log('📦 Resposta da API:');
    console.log(JSON.stringify(responseData, null, 2));

    if (!response.ok) {
      console.error('\n❌ ERRO NA API DA META:');
      console.error('Status:', response.status);
      console.error('Error:', responseData);
      
      // Mensagem de erro mais amigável
      let friendlyError = responseData.error?.message || 'Erro ao enviar template';
      
      // Traduzir erros comuns
      if (responseData.error?.code === 100) {
        // Verificar se é erro de WABA_ID ou PHONE_NUMBER_ID inválido
        const errorMsg = responseData.error?.message || '';
        const errorDetails = responseData.error?.error_data?.details || '';
        
        if (errorMsg.includes('does not exist') || errorMsg.includes('cannot be loaded') || errorMsg.includes('missing permissions')) {
          console.error('🔴 ERRO CRÍTICO: ID INVÁLIDO DETECTADO!');
          console.error('📋 Phone Number ID usado:', phoneNumberId);
          console.error('💡 SOLUÇÃO: Verifique se META_WHATSAPP_PHONE_NUMBER_ID está correto.');
          console.error('💡 O ID deve ser o Phone Number ID da Business Platform, não o WABA_ID!');
          
          friendlyError = `❌ ID inválido (${phoneNumberId}): Este Phone Number ID não existe ou você não tem permissão para acessá-lo. Verifique se META_WHATSAPP_PHONE_NUMBER_ID está correto no painel da Meta Business Platform.`;
        } else {
          friendlyError = `Parâmetro inválido: ${errorDetails || friendlyError}`;
        }
      } else if (responseData.error?.code === 131047) {
        friendlyError = 'Template não encontrado ou não aprovado. Verifique se o template existe e está aprovado.';
      } else if (responseData.error?.code === 131026) {
        friendlyError = 'Número de telefone não encontrado no WhatsApp.';
      }
      
      return {
        success: false,
        error: friendlyError,
        details: responseData
      };
    }

    console.log('\n✅ TEMPLATE ENVIADO COM SUCESSO!');

    // Formato de resposta da Meta:
    // {
    //   "messaging_product": "whatsapp",
    //   "contacts": [{"input": "5511987654321", "wa_id": "5511987654321"}],
    //   "messages": [{"id": "wamid.xxx"}]
    // }

    const messageId = responseData.messages?.[0]?.id;
    console.log('📬 Message ID:', messageId);
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ ENVIO CONCLUÍDO COM SUCESSO                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    return {
      success: true,
      messageId
    };

  } catch (error) {
    console.error('\n❌ EXCEÇÃO AO ENVIAR TEMPLATE:');
    console.error(error);
    console.error('Stack:', error instanceof Error ? error.stack : 'N/A');
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      details: error
    };
  }
}

/**
 * Envia uma mensagem de texto livre via WhatsApp Cloud API
 * IMPORTANTE: Só funciona dentro da janela de 24h
 */
export async function sendWhatsAppTextMessage(
  to: string,
  message: string
): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
  details?: any;
}> {
  try {
    const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');

    console.log('\n🔍 [META API] Verificando credenciais...');
    console.log('- accessToken:', accessToken ? `${accessToken.substring(0, 20)}...` : 'AUSENTE');
    console.log('- phoneNumberId:', phoneNumberId || 'AUSENTE');

    if (!accessToken || !phoneNumberId) {
      console.error('❌ [META API] Credenciais não configuradas!');
      return {
        success: false,
        error: 'WhatsApp não configurado (accessToken ou phoneNumberId ausente)'
      };
    }

    console.log('📤 [META API] Enviando mensagem de texto via WhatsApp Cloud API...');
    console.log('- To:', to);
    console.log('- Message:', message.substring(0, 50) + '...');

    const toNumber = to.replace(/\+/g, '');

    const payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: {
        body: message
      }
    };

    console.log('📦 [META API] Payload:', JSON.stringify(payload, null, 2));

    const url = `${META_API_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/messages`;
    console.log('🌐 [META API] URL:', url);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    console.log('📊 [META API] Status da resposta:', response.status, response.statusText);

    const responseData = await response.json();
    console.log('📋 [META API] Resposta completa:', JSON.stringify(responseData, null, 2));

    if (!response.ok) {
      console.error('❌ [META API] Erro na API da Meta:', responseData);
      return {
        success: false,
        error: responseData.error?.message || `Erro HTTP ${response.status}`,
        details: responseData
      };
    }

    console.log('✅ [META API] Mensagem enviada com sucesso!');

    const messageId = responseData.messages?.[0]?.id;
    console.log('🆔 [META API] Message ID (wamid):', messageId);

    return {
      success: true,
      messageId
    };

  } catch (error) {
    console.error('❌ [META API] Exceção ao enviar mensagem via WhatsApp:', error);
    console.error('Stack:', error instanceof Error ? error.stack : 'N/A');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      details: error
    };
  }
}

/**
 * Envia uma imagem via WhatsApp Cloud API
 */
export async function sendWhatsAppImageMessage(
  to: string,
  imageUrl: string,
  caption?: string
): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
  details?: any;
}> {
  try {
    const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');

    if (!accessToken || !phoneNumberId) {
      return {
        success: false,
        error: 'WhatsApp não configurado'
      };
    }

    console.log('📤 [META API] Enviando imagem via WhatsApp...');
    console.log('- To:', to);
    console.log('- Image URL:', imageUrl);
    console.log('- Caption:', caption || 'N/A');

    const toNumber = to.replace(/\+/g, '');

    const payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'image',
      image: {
        link: imageUrl,
        ...(caption && { caption })
      }
    };

    const url = `${META_API_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('❌ [META API] Erro ao enviar imagem:', responseData);
      return {
        success: false,
        error: responseData.error?.message || `Erro HTTP ${response.status}`,
        details: responseData
      };
    }

    console.log('✅ [META API] Imagem enviada com sucesso!');

    return {
      success: true,
      messageId: responseData.messages?.[0]?.id
    };

  } catch (error) {
    console.error('❌ [META API] Exceção ao enviar imagem:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      details: error
    };
  }
}

/**
 * Envia um documento via WhatsApp Cloud API
 */
export async function sendWhatsAppDocumentMessage(
  to: string,
  documentUrl: string,
  filename: string,
  caption?: string
): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
  details?: any;
}> {
  try {
    const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');

    if (!accessToken || !phoneNumberId) {
      return {
        success: false,
        error: 'WhatsApp não configurado'
      };
    }

    console.log('📤 [META API] Enviando documento via WhatsApp...');
    console.log('- To:', to);
    console.log('- Document URL:', documentUrl);
    console.log('- Filename:', filename);
    console.log('- Caption:', caption || 'N/A');

    const toNumber = to.replace(/\+/g, '');

    const payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'document',
      document: {
        link: documentUrl,
        filename,
        ...(caption && { caption })
      }
    };

    const url = `${META_API_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('❌ [META API] Erro ao enviar documento:', responseData);
      return {
        success: false,
        error: responseData.error?.message || `Erro HTTP ${response.status}`,
        details: responseData
      };
    }

    console.log('✅ [META API] Documento enviado com sucesso!');

    return {
      success: true,
      messageId: responseData.messages?.[0]?.id
    };

  } catch (error) {
    console.error('❌ [META API] Exceção ao enviar documento:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      details: error
    };
  }
}

/**
 * Envia um áudio via WhatsApp Cloud API
 */
export async function sendWhatsAppAudioMessage(
  to: string,
  audioUrl: string
): Promise<{
  success: boolean;
  messageId?: string;
  error?: string;
  details?: any;
}> {
  try {
    const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');

    if (!accessToken || !phoneNumberId) {
      return {
        success: false,
        error: 'WhatsApp não configurado'
      };
    }

    console.log('📤 [META API] Enviando áudio via WhatsApp...');
    console.log('- To:', to);
    console.log('- Audio URL:', audioUrl);

    const toNumber = to.replace(/\+/g, '');

    const payload = {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'audio',
      audio: {
        link: audioUrl
      }
    };

    const url = `${META_API_BASE_URL}/${META_API_VERSION}/${phoneNumberId}/messages`;
    
    console.log('🎤 [META API] URL da requisição:', url);
    console.log('🎤 [META API] Payload:', JSON.stringify(payload, null, 2));
    console.log('🎤 [META API] Token presente?', accessToken ? 'SIM' : 'NÃO');
    console.log('🎤 [META API] Phone Number ID:', phoneNumberId);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();
    
    console.log('📊 [META API] Status da resposta:', response.status, response.statusText);
    console.log('📊 [META API] Response completa:', JSON.stringify(responseData, null, 2));

    if (!response.ok) {
      console.error('❌ [META API] Erro ao enviar áudio:', responseData);
      return {
        success: false,
        error: responseData.error?.message || `Erro HTTP ${response.status}`,
        details: responseData
      };
    }

    console.log('✅ [META API] Áudio enviado com sucesso!');

    return {
      success: true,
      messageId: responseData.messages?.[0]?.id
    };

  } catch (error) {
    console.error('❌ [META API] Exceção ao enviar áudio:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      details: error
    };
  }
}

/**
 * Busca todos os templates aprovados da conta WhatsApp Business
 * @returns Lista de templates da API da Meta
 */
export async function fetchWhatsAppTemplates(): Promise<{
  success: boolean;
  templates?: MetaTemplate[];
  error?: string;
  details?: any;
}> {
  try {
    // 🔥 FORÇAR LIMPEZA DO TOKEN - remover espaços e caracteres invisíveis
    const rawToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const accessToken = rawToken?.trim().replace(/[\r\n\t]/g, '');
    
    let wabaId = Deno.env.get('META_WHATSAPP_WABA_ID')?.trim();
    const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID')?.trim();

    console.log('🔍 Verificando variáveis de ambiente...');
    console.log('- META_WHATSAPP_ACCESS_TOKEN:', accessToken ? `Configurado (${accessToken.substring(0, 20)}...)` : '❌ NÃO CONFIGURADO');
    console.log('- META_WHATSAPP_WABA_ID:', wabaId || '⚠️ NÃO CONFIGURADO');
    console.log('- META_WHATSAPP_PHONE_NUMBER_ID:', phoneNumberId || '❌ NÃO CONFIGURADO');
    
    // Debug: verificar se há espaços ou caracteres estranhos no token
    if (accessToken) {
      const trimmedToken = accessToken.trim();
      const hasSpaces = accessToken !== trimmedToken;
      const tokenLength = accessToken.length;
      console.log('🔐 Debug do Token:');
      console.log('  - Comprimento:', tokenLength);
      console.log('  - Tem espaços extras?', hasSpaces ? '⚠️ SIM' : '✅ NÃO');
      console.log('  - Primeiros 30 chars:', accessToken.substring(0, 30));
      console.log('  - Últimos 10 chars:', accessToken.substring(accessToken.length - 10));
      
      // Verificar se começa com "Bearer" (erro comum)
      if (accessToken.startsWith('Bearer ')) {
        console.error('❌ ERRO: Token começa com "Bearer "! Remova o prefixo "Bearer " do token.');
        return {
          success: false,
          error: '❌ Token inválido: O META_WHATSAPP_ACCESS_TOKEN não deve conter o prefixo "Bearer ". Cole apenas o token, sem prefixos.'
        };
      }
    }

    if (!accessToken) {
      console.error('❌ META_WHATSAPP_ACCESS_TOKEN não configurado');
      return {
        success: false,
        error: 'WhatsApp Access Token não configurado. Configure a variável META_WHATSAPP_ACCESS_TOKEN com um token válido da Meta.'
      };
    }

    // Se não tiver WABA_ID mas tiver PHONE_NUMBER_ID, tentar buscar o WABA_ID
    if (!wabaId && phoneNumberId) {
      console.log('⚠️ WABA_ID não configurado. Tentando buscar via Phone Number ID...');
      
      try {
        // Buscar o WABA ID a partir do Phone Number ID
        const phoneInfoUrl = `${META_API_BASE_URL}/${META_API_VERSION}/${phoneNumberId}?fields=id,verified_name,display_phone_number,quality_rating,whatsapp_business_account_id`;
        console.log('🔍 Buscando info do Phone Number:', phoneInfoUrl);
        
        const phoneResponse = await fetch(phoneInfoUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        if (phoneResponse.ok) {
          const phoneData = await phoneResponse.json();
          console.log('📱 Dados do Phone Number:', JSON.stringify(phoneData, null, 2));
          
          // O campo correto é whatsapp_business_account_id
          if (phoneData.whatsapp_business_account_id) {
            wabaId = phoneData.whatsapp_business_account_id;
            console.log('✅ WABA ID encontrado automaticamente:', wabaId);
            console.log('💡 DICA: Para evitar esta busca, configure META_WHATSAPP_WABA_ID com o valor:', wabaId);
          } else {
            console.log('⚠️ Campo whatsapp_business_account_id não encontrado na resposta');
          }
        } else {
          const errorData = await phoneResponse.json();
          console.log('❌ Erro ao buscar Phone Number info:', errorData);
        }
      } catch (e) {
        console.log('⚠️ Exceção ao tentar buscar WABA_ID automaticamente:', e);
      }
    }

    if (!wabaId) {
      console.error('❌ META_WHATSAPP_WABA_ID não configurado');
      return {
        success: false,
        error: 'WhatsApp Business Account ID (WABA) não configurado. Configure a variável META_WHATSAPP_WABA_ID com o ID da sua conta. Você pode encontrar este ID no painel de configurações do WhatsApp Business API.'
      };
    }

    console.log('📋 Buscando templates da conta WhatsApp Business...');
    console.log('- WABA ID:', wabaId);

    // Fazer requisição para a API da Meta
    const url = `${META_API_BASE_URL}/${META_API_VERSION}/${wabaId}/message_templates`;
    
    console.log('🔗 URL completa:', url);
    console.log('🔑 Token usado (primeiros 50 chars):', accessToken.substring(0, 50) + '...');
    console.log('🔑 Token usado (últimos 20 chars): ...' + accessToken.substring(accessToken.length - 20));
    
    // Fazer a requisição direta para templates
    console.log('📡 Fazendo requisição para buscar templates...');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
        // 🚨 REMOVIDO Content-Type - requisições GET não devem ter Content-Type
      }
    });

    console.log('📡 Status da resposta da Meta:', response.status, response.statusText);

    const responseData = await response.json();
    console.log('📦 Resposta da Meta (primeiros 500 chars):', JSON.stringify(responseData).substring(0, 500));

    if (!response.ok) {
      console.error('❌ Erro na API da Meta ao buscar templates');
      console.error('Status:', response.status);
      console.error('Resposta:', responseData);

      // Tratamento específico para erro 401 (token inválido)
      if (response.status === 401) {
        return {
          success: false,
          error: '🔑 Token de acesso da Meta inválido ou expirado. Gere um novo token em: https://developers.facebook.com/apps',
          details: {
            status: 401,
            message: 'Invalid JWT - O META_WHATSAPP_ACCESS_TOKEN precisa ser atualizado',
            hint: 'Tokens de acesso da Meta geralmente expiram. Você precisa gerar um novo token permanente ou configurar um sistema de renovação automática.',
            metaError: responseData
          }
        };
      }

      // Tratamento para erro 400 (WABA ID inválido)
      if (response.status === 400) {
        return {
          success: false,
          error: '📱 WhatsApp Business Account ID (WABA) inválido. Verifique se o META_WHATSAPP_WABA_ID está correto.',
          details: {
            status: 400,
            message: 'Invalid WABA ID',
            wabaId: wabaId,
            metaError: responseData
          }
        };
      }

      // Outros erros
      return {
        success: false,
        error: responseData.error?.message || `Erro HTTP ${response.status}: ${response.statusText}`,
        details: responseData
      };
    }

    console.log('✅ Templates buscados com sucesso!');
    console.log(`📊 Total de templates retornados: ${responseData.data?.length || 0}`);

    // Formato de resposta da Meta:
    // {
    //   "data": [
    //     {
    //       "name": "hello_world",
    //       "language": "en_US",
    //       "status": "APPROVED",
    //       "category": "UTILITY",
    //       "components": [...]
    //     }
    //   ],
    //   "paging": { ... }
    // }

    const templates: MetaTemplate[] = (responseData.data || []).map((template: any) => ({
      name: template.name,
      language: template.language,
      status: template.status,
      category: template.category.toLowerCase(), // UTILITY -> utility
      components: template.components
    }));

    // Filtrar apenas templates aprovados
    const approvedTemplates = templates.filter(t => t.status === 'APPROVED');

    console.log(`✅ Templates aprovados: ${approvedTemplates.length}`);
    if (approvedTemplates.length > 0) {
      console.log('📋 Templates:', approvedTemplates.map(t => `${t.name} (${t.language})`).join(', '));
    }

    return {
      success: true,
      templates: approvedTemplates
    };

  } catch (error) {
    console.error('❌ Erro ao buscar templates da API da Meta:', error);
    console.error('📋 Stack trace:', error instanceof Error ? error.stack : 'N/A');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido ao conectar com a API da Meta',
      details: error
    };
  }
}

// ============================================================
// CRIAR TEMPLATE NA META (POST /{WABA_ID}/message_templates)
// ============================================================

export interface CreateTemplateButton {
  type: 'QUICK_REPLY';
  text: string;
}

export interface CreateTemplateInput {
  name: string;
  language: string; // ex: pt_BR
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  body: string;
  footer?: string | null;
  buttons?: CreateTemplateButton[];
}

const TEMPLATE_NAME_RE = /^[a-z][a-z0-9_]{0,511}$/;

function validateCreateTemplateInput(input: CreateTemplateInput): string | null {
  if (!input.name || !TEMPLATE_NAME_RE.test(input.name)) {
    return 'Nome inválido. Use snake_case minúsculo, começando com letra (ex: meu_template_01).';
  }
  if (!input.language || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(input.language)) {
    return 'Idioma inválido (ex: pt_BR, en_US, es).';
  }
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(input.category)) {
    return 'Categoria deve ser MARKETING, UTILITY ou AUTHENTICATION.';
  }
  if (!input.body || input.body.trim().length === 0) {
    return 'Mensagem (body) é obrigatória.';
  }
  if (input.body.length > 1024) {
    return 'Mensagem (body) excede 1024 caracteres.';
  }
  if (input.footer && input.footer.length > 60) {
    return 'Rodapé excede 60 caracteres.';
  }
  if (input.buttons && input.buttons.length > 3) {
    return 'Máximo de 3 botões de resposta rápida.';
  }
  if (input.buttons) {
    for (const b of input.buttons) {
      if (b.type !== 'QUICK_REPLY') return `Tipo de botão "${b.type}" não suportado nesta versão (apenas QUICK_REPLY).`;
      if (!b.text || b.text.trim().length === 0) return 'Texto do botão não pode estar vazio.';
      if (b.text.length > 25) return 'Texto do botão excede 25 caracteres.';
    }
  }
  return null;
}

export async function createWhatsAppTemplate(input: CreateTemplateInput): Promise<{
  success: boolean;
  template?: { id?: string; status?: string; category?: string; name: string; language: string };
  error?: string;
  details?: any;
}> {
  try {
    const validationError = validateCreateTemplateInput(input);
    if (validationError) {
      return { success: false, error: validationError };
    }

    const rawToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
    const accessToken = rawToken?.trim().replace(/[\r\n\t]/g, '');
    let wabaId = Deno.env.get('META_WHATSAPP_WABA_ID')?.trim();
    const phoneNumberId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID')?.trim();

    if (!accessToken) {
      return { success: false, error: 'META_WHATSAPP_ACCESS_TOKEN não configurado.' };
    }

    // Fallback: descobrir WABA via Phone Number ID (mesmo padrão de fetchWhatsAppTemplates)
    if (!wabaId && phoneNumberId) {
      try {
        const phoneInfoUrl = `${META_API_BASE_URL}/${META_API_VERSION}/${phoneNumberId}?fields=whatsapp_business_account_id`;
        const phoneResponse = await fetch(phoneInfoUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (phoneResponse.ok) {
          const phoneData = await phoneResponse.json();
          if (phoneData.whatsapp_business_account_id) {
            wabaId = phoneData.whatsapp_business_account_id;
          }
        }
      } catch (_e) {
        // segue para erro abaixo
      }
    }

    if (!wabaId) {
      return { success: false, error: 'WABA ID não configurado nem descoberto automaticamente.' };
    }

    // Montar components no formato Meta
    const components: any[] = [
      { type: 'BODY', text: input.body },
    ];
    if (input.footer && input.footer.trim().length > 0) {
      components.push({ type: 'FOOTER', text: input.footer });
    }
    if (input.buttons && input.buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: input.buttons.map((b) => ({ type: 'QUICK_REPLY', text: b.text })),
      });
    }

    const payload = {
      name: input.name,
      language: input.language,
      category: input.category,
      components,
    };

    console.log('\n📨 [createWhatsAppTemplate] WABA:', wabaId, '| name:', input.name, '| lang:', input.language, '| category:', input.category);

    const url = `${META_API_BASE_URL}/${META_API_VERSION}/${wabaId}/message_templates`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json();
    console.log('📦 Meta response status:', response.status, '| body preview:', JSON.stringify(responseData).substring(0, 400));

    if (!response.ok) {
      const metaErr = responseData?.error;
      const friendly = metaErr?.error_user_msg || metaErr?.message || `Erro ${response.status} da Meta`;
      return {
        success: false,
        error: friendly,
        details: responseData,
      };
    }

    return {
      success: true,
      template: {
        id: responseData.id,
        status: responseData.status,
        category: responseData.category,
        name: input.name,
        language: input.language,
      },
    };
  } catch (error) {
    console.error('❌ Erro ao criar template na Meta:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      details: error,
    };
  }
}