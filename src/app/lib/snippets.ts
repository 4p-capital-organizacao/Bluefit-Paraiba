/**
 * H1.5 — Helpers para snippets (quick replies) com variáveis dinâmicas.
 */

export interface SnippetVars {
  primeiro_nome?: string | null;
  nome_consultor?: string | null;
  unidade?: string | null;
  horario_atendimento?: string | null;
}

export const SNIPPET_VAR_KEYS = [
  'primeiro_nome',
  'nome_consultor',
  'unidade',
  'nome_unidade',
  'horario_atendimento',
] as const;

const DEFAULT_HORARIO = 'segunda a sexta, das 8h às 18h';

function firstNameOf(displayName: string | null | undefined, firstName?: string | null): string {
  if (firstName && firstName.trim()) return firstName.trim();
  if (!displayName) return '';
  return displayName.trim().split(/\s+/)[0] || '';
}

export function applyVars(body: string, vars: SnippetVars): string {
  const horario = vars.horario_atendimento || DEFAULT_HORARIO;
  return body
    .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, vars.primeiro_nome ?? '')
    .replace(/\{\{\s*nome_consultor\s*\}\}/gi, vars.nome_consultor ?? '')
    .replace(/\{\{\s*nome_unidade\s*\}\}/gi, vars.unidade ?? '')
    .replace(/\{\{\s*unidade\s*\}\}/gi, vars.unidade ?? '')
    .replace(/\{\{\s*horario_atendimento\s*\}\}/gi, horario);
}

export function buildSnippetVars(args: {
  contact?: { display_name?: string | null; first_name?: string | null } | null;
  consultor?: { nome?: string | null; sobrenome?: string | null } | null;
  unitName?: string | null;
}): SnippetVars {
  return {
    primeiro_nome: firstNameOf(args.contact?.display_name, args.contact?.first_name),
    nome_consultor: args.consultor?.nome
      ? `${args.consultor.nome}${args.consultor.sobrenome ? ' ' + args.consultor.sobrenome : ''}`.trim()
      : '',
    unidade: args.unitName || '',
    horario_atendimento: DEFAULT_HORARIO,
  };
}

export const CATEGORY_LABEL: Record<string, string> = {
  saudacao: 'Saudação',
  visita: 'Visita',
  cobranca: 'Cobrança',
  aniversario: 'Aniversário',
  duvida: 'Dúvida',
  encerramento: 'Encerramento',
  geral: 'Geral',
};

export const SNIPPET_CATEGORIES = Object.keys(CATEGORY_LABEL);
