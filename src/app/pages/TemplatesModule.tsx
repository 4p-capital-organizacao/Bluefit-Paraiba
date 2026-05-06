/**
 * Página de gestão de Templates Meta.
 * Tabs:
 *   - "Lista" → TemplateListPanel (com status)
 *   - "Criar" → CreateTemplateForm
 *
 * Acesso restrito via menu_item_permissions (module_key='templates').
 */

import { FileText, Plus } from 'lucide-react';
import { useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { TemplateListPanel } from '@/app/components/TemplateListPanel';
import { CreateTemplateForm } from '@/app/components/CreateTemplateForm';

export function TemplatesModule() {
  const [tab, setTab] = useState<'list' | 'create'>('list');
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br from-slate-50 to-blue-50/30 p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#0028e6] to-[#00e5ff] flex items-center justify-center shadow-lg">
              <FileText className="w-5 h-5 text-white" />
            </div>
            Templates WhatsApp
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Crie e gerencie templates aprovados pela Meta para envio fora da janela de 24h.
          </p>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'list' | 'create')} className="space-y-5">
          <TabsList className="grid w-full grid-cols-2 lg:w-auto lg:inline-grid">
            <TabsTrigger value="list" className="gap-2">
              <FileText className="w-4 h-4" />
              Lista de templates
            </TabsTrigger>
            <TabsTrigger value="create" className="gap-2">
              <Plus className="w-4 h-4" />
              Criar template
            </TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="space-y-3">
            <TemplateListPanel key={refreshKey} />
          </TabsContent>

          <TabsContent value="create" className="space-y-3">
            <CreateTemplateForm
              onCreated={() => {
                setRefreshKey((k) => k + 1);
                setTab('list');
              }}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
