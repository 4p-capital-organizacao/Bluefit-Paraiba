/**
 * H1.5 — Snippet Picker (slash-command)
 *
 * Popover acima do composer que abre quando o messageText começa com "/".
 * Filtra os snippets globais e da unidade conforme texto após o "/".
 * Setas ↑↓ navegam, Enter/Tab seleciona, Esc fecha.
 *
 * Ao selecionar: aplica variáveis e substitui o messageText pelo body final.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Sparkles, Star } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { applyVars, buildSnippetVars, CATEGORY_LABEL, SnippetVars } from '../lib/snippets';
import { cn } from './ui/utils';

export interface SnippetRow {
  id: number;
  unit_id: number | null;
  category: string;
  title: string;
  body: string;
  is_global_favorite: boolean;
  usage_count: number;
}

interface SnippetPickerProps {
  messageText: string;
  onPick: (finalBody: string) => void;
  contact?: { display_name?: string | null; first_name?: string | null } | null;
  consultor?: { nome?: string | null; sobrenome?: string | null } | null;
  unitName?: string | null;
}

export function SnippetPicker({ messageText, onPick, contact, consultor, unitName }: SnippetPickerProps) {
  const [snippets, setSnippets] = useState<SnippetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const slashQuery = useMemo(() => {
    if (!messageText.startsWith('/')) return null;
    const trimmed = messageText.slice(1);
    if (trimmed.includes('\n')) return null; // após pular linha, não é mais slash command
    return trimmed.toLowerCase();
  }, [messageText]);

  const isOpen = slashQuery !== null;

  const vars: SnippetVars = useMemo(
    () => buildSnippetVars({ contact, consultor, unitName }),
    [contact, consultor, unitName],
  );

  const loadSnippets = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('quick_replies')
      .select('id, unit_id, category, title, body, is_global_favorite, usage_count')
      .order('is_global_favorite', { ascending: false })
      .order('usage_count', { ascending: false })
      .limit(100);
    if (error) {
      console.error('[SnippetPicker] erro ao carregar snippets:', error);
    } else {
      setSnippets((data as SnippetRow[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isOpen && snippets.length === 0 && !loading) {
      loadSnippets();
    }
  }, [isOpen, snippets.length, loading, loadSnippets]);

  const filtered = useMemo(() => {
    if (slashQuery === null) return [];
    if (slashQuery === '') return snippets;
    const q = slashQuery.trim();
    return snippets.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.body.toLowerCase().includes(q),
    );
  }, [slashQuery, snippets]);

  useEffect(() => {
    setHighlight(0);
  }, [slashQuery]);

  const handleSelect = useCallback(
    async (snippet: SnippetRow) => {
      const finalBody = applyVars(snippet.body, vars);
      onPick(finalBody);
      // fire-and-forget: incrementa usage_count
      try {
        await supabase.rpc('increment_quick_reply_usage', { p_id: snippet.id });
        // otimista local
        setSnippets((prev) =>
          prev.map((s) => (s.id === snippet.id ? { ...s, usage_count: s.usage_count + 1 } : s)),
        );
      } catch (err) {
        console.error('[SnippetPicker] increment_quick_reply_usage falhou:', err);
      }
    },
    [onPick, vars],
  );

  // Keyboard navigation: capturado no document quando aberto
  useEffect(() => {
    if (!isOpen || filtered.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const sel = filtered[highlight];
        if (sel) {
          e.preventDefault();
          handleSelect(sel);
        }
      }
    }
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true } as any);
  }, [isOpen, filtered, highlight, handleSelect]);

  // scroll item destacado para a vista
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-idx="${highlight}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-4 md:left-6 right-4 md:right-6 mb-2 max-w-2xl max-h-[280px] overflow-y-auto z-30 rounded-xl bg-white border border-[#E5E7EB] shadow-2xl"
      role="listbox"
    >
      <div className="sticky top-0 bg-white px-3 py-2 border-b border-[#F3F3F3] flex items-center gap-2 text-xs text-[#6B7280]">
        <Sparkles className="w-3.5 h-3.5 text-[#0023D5]" />
        <span>
          Snippets {slashQuery ? <em className="text-[#1B1B1B] not-italic">"/{slashQuery}"</em> : null} —{' '}
          <kbd className="px-1 rounded border border-[#E5E7EB] text-[10px]">↑↓</kbd> navegar,{' '}
          <kbd className="px-1 rounded border border-[#E5E7EB] text-[10px]">Tab</kbd>/{' '}
          <kbd className="px-1 rounded border border-[#E5E7EB] text-[10px]">Enter</kbd> escolher,{' '}
          <kbd className="px-1 rounded border border-[#E5E7EB] text-[10px]">Esc</kbd> fechar
        </span>
      </div>

      {loading && snippets.length === 0 ? (
        <div className="p-4 text-xs text-[#9CA3AF]">Carregando…</div>
      ) : filtered.length === 0 ? (
        <div className="p-4 text-xs text-[#9CA3AF]">
          Nenhum snippet bate com "/{slashQuery}". Peça pro supervisor cadastrar um.
        </div>
      ) : (
        <ul className="py-1">
          {filtered.map((s, idx) => {
            const isHL = idx === highlight;
            const preview = applyVars(s.body, vars);
            return (
              <li
                key={s.id}
                data-idx={idx}
                className={cn(
                  'px-3 py-2 cursor-pointer flex items-start gap-3 border-b last:border-b-0 border-[#F9FAFB]',
                  isHL ? 'bg-[#E6EAFF]' : 'hover:bg-[#F9FAFB]',
                )}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  // mousedown evita perder foco do textarea antes do click
                  e.preventDefault();
                  handleSelect(s);
                }}
                role="option"
                aria-selected={isHL}
              >
                <div className="flex-shrink-0 mt-0.5">
                  {s.is_global_favorite ? (
                    <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                  ) : (
                    <Hash className="w-3.5 h-3.5 text-[#9CA3AF]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[13px] font-semibold text-[#1B1B1B] truncate">{s.title}</span>
                    <span className="text-[10px] uppercase tracking-wide text-[#9CA3AF]">
                      {CATEGORY_LABEL[s.category] || s.category}
                    </span>
                    <span className="text-[10px] text-[#9CA3AF] ml-auto">
                      {s.unit_id === null ? 'Global' : 'Unidade'}
                    </span>
                  </div>
                  <p className="text-[12px] text-[#4B5563] leading-snug line-clamp-2 whitespace-pre-line">
                    {preview}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
