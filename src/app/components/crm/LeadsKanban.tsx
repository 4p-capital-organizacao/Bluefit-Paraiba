import { LeadWithDetails, LeadStatus } from '../../types/database';
import { User, Phone, Mail, Calendar, MapPin, Clock, Star, Award, RotateCcw } from 'lucide-react';
import { useDrag, useDrop } from 'react-dnd';
import { Badge } from '../ui/badge';
import { cn } from '../ui/utils';
import { useRef } from 'react';
import { FollowupStepper } from './FollowupStepper';

// SVG inline do ícone WhatsApp (sem dependência externa)
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

interface LeadsKanbanProps {
  leads: LeadWithDetails[];
  onLeadClick: (lead: LeadWithDetails) => void;
  onStatusChange: (leadId: string, newStatus: LeadStatus) => void;
  onWhatsAppClick?: (lead: LeadWithDetails) => void;
}

// Helper para calcular tempo relativo
function getTimeAgo(date: string | Date): string {
  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);
  
  if (diffInSeconds < 60) return 'agora';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h`;
  if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d`;
  if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)}mes`;
  return `${Math.floor(diffInSeconds / 31536000)}a`;
}

// Helper para formatar data curta (dd/mm)
function formatShortDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// Helper para calcular tempo na situação atual
function getTimeInCurrentStatus(lead: LeadWithDetails): string {
  return getTimeAgo(lead.created_at);
}

// Encurta URLs longas com UTMs — mostra só host + 1 segmento, sem query.
// Texto livre passa intacto (truncate via CSS).
function formatOrigem(origem: string): string {
  if (!origem) return '';
  const cleaned = origem.trim();
  const looksLikeUrl =
    /^https?:\/\//i.test(cleaned) ||
    /^[a-z0-9-]+\.[a-z]{2,}/i.test(cleaned); // ex: "o.com.br/campina?..."
  if (!looksLikeUrl) return cleaned;
  try {
    const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : 'https://' + cleaned;
    const u = new URL(withProto);
    const firstSegment = u.pathname.split('/').filter(Boolean)[0];
    return u.hostname + (firstSegment ? '/' + firstSegment : '');
  } catch {
    // Fallback: cortar antes do ? e limitar tamanho
    const beforeQuery = cleaned.split('?')[0];
    return beforeQuery.length > 32 ? beforeQuery.slice(0, 32) + '…' : beforeQuery;
  }
}

const ITEM_TYPE = 'LEAD';

// Identidade visual de cada stage — apenas cor de acento (texto + sidebar do card),
// sem fundo colorido na coluna (mantém canvas neutro estilo Pipedrive/Linear).
const statusConfig: Record<LeadStatus, { label: string; text: string; accent: string; dot: string }> = {
  novo: {
    label: 'Novo',
    text: 'text-blue-700',
    accent: 'bg-blue-500',
    dot: 'bg-blue-500',
  },
  contato_feito: {
    label: 'Contato Feito',
    text: 'text-purple-700',
    accent: 'bg-purple-500',
    dot: 'bg-purple-500',
  },
  visita_agendada: {
    label: 'Visita Agendada',
    text: 'text-amber-700',
    accent: 'bg-amber-500',
    dot: 'bg-amber-500',
  },
  visita_realizada: {
    label: 'Visita Realizada',
    text: 'text-cyan-700',
    accent: 'bg-cyan-500',
    dot: 'bg-cyan-500',
  },
  visita_cancelada: {
    label: 'Visita Cancelada',
    text: 'text-orange-700',
    accent: 'bg-orange-500',
    dot: 'bg-orange-500',
  },
  matriculado: {
    label: 'Matriculado',
    text: 'text-emerald-700',
    accent: 'bg-emerald-500',
    dot: 'bg-emerald-500',
  },
  base_fria: {
    label: 'Base fria',
    text: 'text-slate-600',
    accent: 'bg-slate-400',
    dot: 'bg-slate-400',
  },
  perdido: {
    label: 'Perdido',
    text: 'text-red-700',
    accent: 'bg-red-500',
    dot: 'bg-red-500',
  },
};

// Cor do avatar circular (responsável) — derivada do nome
function avatarColor(name: string): string {
  const colors = ['bg-blue-500', 'bg-purple-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
  return colors[Math.abs(hash) % colors.length];
}

function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const columns: LeadStatus[] = [
  'novo',
  'contato_feito',
  'visita_agendada',
  'visita_realizada',
  'visita_cancelada',
  'matriculado',
  'base_fria',
  'perdido',
];

// Componente do Card arrastável
interface LeadCardProps {
  lead: LeadWithDetails;
  onLeadClick: (lead: LeadWithDetails) => void;
  onWhatsAppClick?: (lead: LeadWithDetails) => void;
}

function LeadCard({ lead, onLeadClick, onWhatsAppClick }: LeadCardProps) {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: ITEM_TYPE,
    item: { id: lead.id, currentStatus: lead.situacao },
    collect: (monitor) => ({
      isDragging: !!monitor.isDragging(),
    }),
  }), [lead.id, lead.situacao]);

  const config = statusConfig[lead.situacao];
  const responsibleName = lead.responsavel?.trim();
  const showFollowupStepper = (lead.followup_count != null && lead.followup_count > 0) || lead.situacao === 'base_fria';
  const hasInboundFresh = lead.lastMessageDirection === 'inbound';

  return (
    <div
      ref={drag}
      className={cn(
        'relative bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden',
        'hover:shadow-md hover:border-slate-300 transition-all cursor-grab active:cursor-grabbing group',
        isDragging && 'opacity-40',
      )}
      onClick={() => onLeadClick(lead)}
    >
      {/* Sidebar colorida 3px com a cor do stage */}
      <span className={cn('absolute left-0 top-0 bottom-0 w-[3px]', config?.accent || 'bg-slate-400')} />

      <div className="pl-3 pr-2.5 py-2.5 space-y-1.5">
        {/* Linha 1: Nome + REATIVADO + WhatsApp */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-[13px] text-slate-900 leading-tight truncate">
              {lead.nome_completo}
            </h4>
            {lead.recently_reactivated && (
              <span
                className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5 bg-emerald-100 text-emerald-700"
                title="Lead voltou da Base fria — cliente respondeu"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                REATIVADO
              </span>
            )}
          </div>
          {lead.telefone && onWhatsAppClick && (
            <button
              onClick={(e) => { e.stopPropagation(); onWhatsAppClick(lead); }}
              className={cn(
                'relative w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0',
                'bg-[#25D366]/10 text-[#25D366] hover:bg-[#25D366] hover:text-white transition-colors',
              )}
              title="Abrir chat WhatsApp"
            >
              <WhatsAppIcon className="w-3 h-3" />
              {hasInboundFresh && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full border border-white animate-pulse" />
              )}
            </button>
          )}
        </div>

        {/* Linha 2: chips compactos (origem + score + classificação) */}
        {(lead.origem || lead.pontuacao != null || lead.classificacao) && (
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            {lead.origem && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] text-slate-500 max-w-[140px]"
                title={lead.origem}
              >
                <MapPin className="w-2.5 h-2.5 flex-shrink-0" />
                <span className="truncate">{formatOrigem(lead.origem)}</span>
              </span>
            )}
            {lead.pontuacao != null && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-700">
                <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />
                {lead.pontuacao}
              </span>
            )}
            {lead.classificacao && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-purple-700">
                <Award className="w-2.5 h-2.5" />
                <span className="truncate max-w-[100px]">{lead.classificacao}</span>
              </span>
            )}
          </div>
        )}

        {/* Linha 3: telefone (preferência) ou email (fallback) — não os dois */}
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          {lead.telefone ? (
            <>
              <Phone className="w-3 h-3 flex-shrink-0" />
              <span className="truncate font-mono">{lead.telefone}</span>
            </>
          ) : lead.email ? (
            <>
              <Mail className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{lead.email}</span>
            </>
          ) : null}
        </div>

        {/* Rodapé: avatar do responsável + tempo + stepper */}
        <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-100">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {responsibleName ? (
              <>
                <span
                  className={cn(
                    'w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0',
                    avatarColor(responsibleName),
                  )}
                  title={responsibleName}
                >
                  {avatarInitials(responsibleName)}
                </span>
                <span className="text-[10px] text-slate-500 truncate">{responsibleName}</span>
              </>
            ) : (
              <span className="text-[10px] text-slate-300 italic">Sem responsável</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {showFollowupStepper && (
              <FollowupStepper
                count={lead.followup_count || 0}
                total={2}
                exhausted={lead.situacao === 'base_fria'}
              />
            )}
            <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-slate-500" title={`Criado: ${formatShortDate(lead.created_at)}`}>
              <Clock className="w-2.5 h-2.5" />
              {getTimeInCurrentStatus(lead)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Componente da Coluna com drop zone
interface KanbanColumnProps {
  status: LeadStatus;
  leads: LeadWithDetails[];
  onLeadClick: (lead: LeadWithDetails) => void;
  onDrop: (leadId: string, newStatus: LeadStatus) => void;
  onWhatsAppClick?: (lead: LeadWithDetails) => void;
}

function KanbanColumn({ status, leads, onLeadClick, onDrop, onWhatsAppClick }: KanbanColumnProps) {
  const ref = useRef<HTMLDivElement>(null);
  const config = statusConfig[status];

  const [{ isOver, canDrop }, drop] = useDrop(() => ({
    accept: ITEM_TYPE,
    drop: (item: { id: string; currentStatus: LeadStatus }) => {
      if (item.currentStatus?.toLowerCase() !== status.toLowerCase()) {
        onDrop(item.id, status);
      }
    },
    collect: (monitor) => ({
      isOver: !!monitor.isOver(),
      canDrop: !!monitor.canDrop(),
    }),
  }), [status, onDrop]);

  drop(ref);

  const isActive = isOver && canDrop;

  return (
    <div
      ref={ref}
      className={cn(
        'flex-shrink-0 w-[240px] flex flex-col h-full min-h-0 rounded-lg border bg-slate-50/80 transition-colors',
        isActive ? 'border-[#0028e6] bg-blue-50/50' : 'border-slate-200',
      )}
    >
      {/* Header neutro: dot colorido + label + count */}
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-slate-200/80 sticky top-0 bg-slate-50/95 backdrop-blur-sm rounded-t-lg z-10">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('w-2 h-2 rounded-full flex-shrink-0', config.dot)} />
          <h3 className={cn('font-semibold text-[12px] uppercase tracking-wide truncate', config.text)}>
            {config.label}
          </h3>
        </div>
        <span className="text-[10px] font-bold text-slate-500 bg-white border border-slate-200 rounded-md px-1.5 py-0.5 flex-shrink-0">
          {leads.length}
        </span>
      </div>

      {/* Cards dos leads */}
      <div className="flex-1 overflow-y-auto space-y-2 p-2 min-h-0">
        {leads.length === 0 ? (
          <div className={cn(
            'text-center py-12 text-[11px] text-slate-400 rounded-md border-2 border-dashed transition-colors',
            isActive ? 'border-[#0028e6] text-[#0028e6] bg-blue-50' : 'border-slate-200',
          )}>
            {isActive ? 'Solte aqui' : 'Vazio'}
          </div>
        ) : (
          leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onLeadClick={onLeadClick}
              onWhatsAppClick={onWhatsAppClick}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function LeadsKanban({ leads, onLeadClick, onStatusChange, onWhatsAppClick }: LeadsKanbanProps) {
  const getLeadsByStatus = (status: LeadStatus) => {
    return leads.filter(lead => 
      lead.situacao?.toLowerCase() === status.toLowerCase()
    );
  };

  const handleDrop = (leadId: string, newStatus: LeadStatus) => {
    onStatusChange(leadId, newStatus);
  };

  return (
    <div className="inline-flex gap-3 sm:gap-4 pb-4 h-full min-w-full px-3 md:px-6 pt-3 md:pt-6">
      {columns.map((status) => {
        const statusLeads = getLeadsByStatus(status);

        return (
          <KanbanColumn
            key={status}
            status={status}
            leads={statusLeads}
            onLeadClick={onLeadClick}
            onDrop={handleDrop}
            onWhatsAppClick={onWhatsAppClick}
          />
        );
      })}
      {/* Spacer to ensure last column isn't clipped by scrollbar */}
      <div className="flex-shrink-0 w-6" aria-hidden />
    </div>
  );
}