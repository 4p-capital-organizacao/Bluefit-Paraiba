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

const ITEM_TYPE = 'LEAD';

const statusConfig: Record<LeadStatus, { label: string; color: string; bgColor: string }> = {
  novo: { 
    label: 'Novo', 
    color: 'text-blue-700', 
    bgColor: 'bg-blue-50 border-blue-200' 
  },
  contato_feito: { 
    label: 'Contato Feito', 
    color: 'text-purple-700', 
    bgColor: 'bg-purple-50 border-purple-200' 
  },
  visita_agendada: { 
    label: 'Visita Agendada', 
    color: 'text-amber-700', 
    bgColor: 'bg-amber-50 border-amber-200' 
  },
  visita_realizada: { 
    label: 'Visita Realizada', 
    color: 'text-cyan-700', 
    bgColor: 'bg-cyan-50 border-cyan-200' 
  },
  visita_cancelada: { 
    label: 'Visita Cancelada', 
    color: 'text-orange-700', 
    bgColor: 'bg-orange-50 border-orange-200' 
  },
  matriculado: {
    label: 'Matriculado',
    color: 'text-green-700',
    bgColor: 'bg-green-50 border-green-200'
  },
  base_fria: {
    label: 'Base fria',
    color: 'text-slate-600',
    bgColor: 'bg-slate-100 border-slate-300'
  },
  perdido: {
    label: 'Perdido',
    color: 'text-red-700',
    bgColor: 'bg-red-50 border-red-200'
  },
};

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

  return (
    <div
      ref={drag}
      className={cn(
        "bg-white rounded-lg p-4 shadow-sm border border-slate-200",
        "hover:shadow-md transition-all cursor-move",
        "hover:border-[#0028e6] group",
        isDragging && 'opacity-50 cursor-grabbing'
      )}
      onClick={() => onLeadClick(lead)}
    >
      {/* Nome + WhatsApp Button */}
      <h4 className="font-bold text-slate-900 mb-2 flex items-center justify-between gap-2">
        <span className="truncate flex items-center gap-1.5">
          {lead.nome_completo}
          {lead.recently_reactivated && (
            <span
              className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200"
              title="Lead voltou da Base fria — cliente respondeu"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              REATIVADO
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Botão WhatsApp */}
          {lead.telefone && onWhatsAppClick && (
            <button
              onClick={(e) => {
                e.stopPropagation(); // Impedir que abra o formulário do lead
                onWhatsAppClick(lead);
              }}
              className={cn(
                "relative w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-200",
                "bg-[#25D366]/10 text-[#25D366] hover:bg-[#25D366] hover:text-white",
                "hover:shadow-md hover:shadow-[#25D366]/25 active:scale-90"
              )}
              title="Abrir chat WhatsApp"
            >
              <WhatsAppIcon className="w-3.5 h-3.5" />
              {/* Bolinha vermelha: última mensagem é do cliente (inbound) */}
              {lead.lastMessageDirection === 'inbound' && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white animate-pulse" />
              )}
            </button>
          )}
        </div>
      </h4>

      {/* Origem + Pontuação + Classificação - linha compacta */}
      {(lead.origem || (lead.pontuacao !== null && lead.pontuacao !== undefined) || lead.classificacao) && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {lead.origem && (
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              {lead.origem}
            </span>
          )}
          {lead.pontuacao !== null && lead.pontuacao !== undefined && (
            <Badge
              variant="secondary"
              className="bg-amber-100 text-amber-700 text-[10px] font-semibold flex items-center gap-0.5 px-1.5 py-0 h-5"
            >
              <Star className="w-3 h-3 fill-amber-500 text-amber-500" />
              {lead.pontuacao}
            </Badge>
          )}
          {lead.classificacao && (
            <Badge
              variant="secondary"
              className="bg-purple-100 text-purple-700 text-[10px] font-semibold flex items-center gap-0.5 px-1.5 py-0 h-5"
            >
              <Award className="w-3 h-3" />
              {lead.classificacao}
            </Badge>
          )}
        </div>
      )}

      {/* Informações */}
      <div className="space-y-1.5 text-xs">
        {/* Telefone */}
        <div className="flex items-center gap-2 text-slate-600">
          <Phone className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{lead.telefone}</span>
        </div>

        {/* Email */}
        {lead.email && (
          <div className="flex items-center gap-2 text-slate-600">
            <Mail className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">{lead.email}</span>
          </div>
        )}

        {/* Responsável */}
        {lead.responsavel && (
          <div className="flex items-center gap-2 text-slate-600">
            <User className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">
              {lead.responsavel}
            </span>
          </div>
        )}

        {/* Stepper de follow-ups (mostra só se já recebeu pelo menos 1 ou está em base_fria) */}
        {(lead.followup_count != null && lead.followup_count > 0) || lead.situacao === 'base_fria' ? (
          <div className="pt-2 mt-2 border-t border-slate-100 flex items-center gap-2">
            <span className="text-[9px] text-slate-500 uppercase font-semibold tracking-wide">Follow-ups</span>
            <FollowupStepper
              count={lead.followup_count || 0}
              total={3}
              exhausted={lead.situacao === 'base_fria'}
            />
          </div>
        ) : null}

        {/* Rodapé: Data de criação (esq) | Tempo na situação (dir) */}
        <div className="flex items-center justify-between gap-2 pt-2 mt-2 border-t border-slate-100">
          <div className="flex items-center gap-1 text-slate-400">
            <Calendar className="w-3 h-3 flex-shrink-0" />
            <span className="text-[10px]">{formatShortDate(lead.created_at)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3 text-[#0028e6] flex-shrink-0" />
            <span className="text-[11px] font-semibold text-[#0028e6]">
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
      className="flex-shrink-0 w-[260px] sm:w-[280px] md:w-[300px] lg:w-[320px] flex flex-col h-full min-h-0"
    >
      {/* Header da coluna */}
      <div className={cn(
        "px-4 py-3 rounded-t-xl border-2 border-b-0 transition-all",
        config.bgColor,
        isActive && "ring-2 ring-[#0028e6] ring-offset-2"
      )}>
        <div className="flex items-center justify-between">
          <h3 className={cn("font-bold text-sm", config.color)}>
            {config.label}
          </h3>
          <Badge variant="secondary" className="text-xs font-bold">
            {leads.length}
          </Badge>
        </div>
      </div>

      {/* Cards dos leads */}
      <div className={cn(
        "flex-1 overflow-y-auto space-y-3 p-3 border-2 border-t-0 rounded-b-xl transition-all min-h-0",
        config.bgColor,
        isActive && "ring-2 ring-[#0028e6] ring-offset-2 bg-opacity-70"
      )}>
        {leads.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">
            {isActive ? 'Solte aqui' : 'Nenhum lead'}
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