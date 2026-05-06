/**
 * Stepper visual para mostrar follow-ups automáticos enviados ao lead.
 *
 * Exibe N círculos (default 3) preenchidos conforme `count`. Próximo passo:
 *  - Se count < total: o próximo círculo está pulsando ("aguardando envio")
 *  - Se count == total: todos preenchidos, lead próximo a virar base_fria
 *
 * Uso típico no card do Kanban (LeadsKanban). Para leads em `base_fria`
 * ou `contato_feito` com pelo menos 1 envio.
 */

import { cn } from '../ui/utils';

interface FollowupStepperProps {
  count: number;       // quantos templates já enviados
  total?: number;      // total previsto (default 3)
  className?: string;
  /** Indica se o lead está atualmente em base_fria (estilização extra) */
  exhausted?: boolean;
}

export function FollowupStepper({ count, total = 3, className, exhausted }: FollowupStepperProps) {
  if (count <= 0 && !exhausted) return null; // não exibe se nunca foi tocado

  const safeCount = Math.min(Math.max(count, 0), total);

  return (
    <div className={cn('inline-flex items-center gap-0.5', className)} title={`${safeCount}/${total} follow-ups enviados`}>
      {Array.from({ length: total }).map((_, i) => {
        const filled = i < safeCount;
        const isNext = i === safeCount && !exhausted;
        return (
          <span key={i} className="inline-flex items-center">
            <span
              className={cn(
                'inline-block rounded-full transition-colors',
                filled
                  ? exhausted
                    ? 'bg-slate-400 w-1.5 h-1.5'
                    : 'bg-[#0023D5] w-1.5 h-1.5'
                  : isNext
                    ? 'bg-amber-400 w-1.5 h-1.5 animate-pulse'
                    : 'bg-slate-200 w-1.5 h-1.5',
              )}
            />
            {i < total - 1 && (
              <span
                className={cn(
                  'inline-block h-px w-1.5',
                  filled && i < safeCount - 1 ? 'bg-[#0023D5]' : 'bg-slate-300',
                )}
              />
            )}
          </span>
        );
      })}
      <span className="text-[9px] text-slate-500 font-mono ml-1 leading-none">
        {safeCount}/{total}
      </span>
    </div>
  );
}
