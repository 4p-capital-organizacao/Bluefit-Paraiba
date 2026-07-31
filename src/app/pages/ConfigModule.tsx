import { useState, useEffect, useMemo } from 'react';
import {
  Users, Search, Save, X, Loader2, Edit2, Clock, Building,
  ChevronDown, ChevronRight, Shield, ShieldCheck, ShieldAlert,
  UserCheck, UserX, Filter, AlertTriangle, Lock, Zap,
} from 'lucide-react';
import { MenuPermissionsPanel } from '@/app/components/MenuPermissionsPanel';
import { AutomationPanel } from '@/app/components/AutomationPanel';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Switch } from '@/app/components/ui/switch';
import { Badge } from '@/app/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';
import { Checkbox } from '@/app/components/ui/checkbox';
import { toast } from 'sonner';
import { supabase } from '@/app/lib/supabase';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { BusinessHours } from '@/app/components/BusinessHours';
import { useUserProfile } from '@/app/hooks/useUserProfile';

interface Profile {
  id: string;
  nome: string;
  sobrenome: string;
  email: string;
  id_unidade: number | null;
  id_cargo: number | null;
  ativo: boolean;
  created_at?: string;
  unit?: { id: number; name: string } | null;
  cargo?: { id: number; papeis: string } | null;
}

interface Unit {
  id: number;
  name: string;
}

interface Cargo {
  id: number;
  papeis: string;
}

// Cargos que o Gerente NÃO pode atribuir (para evitar escalação de privilégio)
const ADMIN_ONLY_CARGOS = ['administrador'];

export function ConfigModule() {
  const { profile: currentUser } = useUserProfile();
  const isFullAdmin = currentUser.isFullAdmin;
  // Gerente pode acessar, mas com restrições
  const isManager = currentUser.isManager && !isFullAdmin;

  const [users, setUsers] = useState<Profile[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [units, setUnits] = useState<Unit[]>([]);
  const [cargos, setCargos] = useState<Cargo[]>([]);
  const [editingUser, setEditingUser] = useState<Profile | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [collapsedUnits, setCollapsedUnits] = useState<Set<string>>(new Set());
  const [togglingUserId, setTogglingUserId] = useState<string | null>(null);

  // ─── Multi-unidade (profile_units) ──────────────────
  const [editingUserUnits, setEditingUserUnits] = useState<{ unit_id: number; is_primary: boolean }[]>([]);
  const [loadingUserUnits, setLoadingUserUnits] = useState(false);

  useEffect(() => {
    loadUsers();
    loadUnits();
    loadCargos();
  }, [currentUser.isLoaded, currentUser.id_unidade]);

  // ─── Filtrar usuários ────────────────────────────────
  const filteredUsers = useMemo(() => {
    let result = users;

    // Gerente: filtrar por todas as unidades vinculadas (multi-unidade)
    if (isManager) {
      const managerUnitIds = currentUser.unitIds.length > 0
        ? currentUser.unitIds
        : (currentUser.id_unidade != null ? [currentUser.id_unidade] : []);

      if (managerUnitIds.length > 0) {
        result = result.filter(u => u.id_unidade != null && managerUnitIds.includes(u.id_unidade));
      }
    }

    // Busca textual
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(user =>
        user.nome?.toLowerCase().includes(term) ||
        user.sobrenome?.toLowerCase().includes(term) ||
        user.email?.toLowerCase().includes(term) ||
        user.cargo?.papeis?.toLowerCase().includes(term)
      );
    }

    return result;
  }, [users, searchTerm, isManager, currentUser.unitIds, currentUser.id_unidade]);

  // ─── Agrupar por unidade ────────────────────────────
  const groupedByUnit = useMemo(() => {
    const groups = new Map<string, { unit: Unit | null; users: Profile[] }>();

    filteredUsers.forEach(user => {
      const unitKey = user.id_unidade?.toString() || 'sem-unidade';
      if (!groups.has(unitKey)) {
        groups.set(unitKey, {
          unit: user.unit ? { id: user.unit.id, name: user.unit.name } : null,
          users: [],
        });
      }
      groups.get(unitKey)!.users.push(user);
    });

    // Ordenar: unidades com nome primeiro (por nome), "Sem unidade" por último
    const sorted = Array.from(groups.entries()).sort(([keyA, a], [keyB, b]) => {
      if (!a.unit) return 1;
      if (!b.unit) return -1;
      return (a.unit.name || '').localeCompare(b.unit.name || '');
    });

    return sorted;
  }, [filteredUsers]);

  // ─── Estatísticas ────────────────────────────────────
  const stats = useMemo(() => {
    const total = filteredUsers.length;
    const ativos = filteredUsers.filter(u => u.ativo).length;
    const inativos = total - ativos;
    const semCargo = filteredUsers.filter(u => {
      const c = u.cargo?.papeis?.toLowerCase();
      return !c || c === 'sem cargo';
    }).length;
    return { total, ativos, inativos, semCargo };
  }, [filteredUsers]);

  // ─── Cargos filtrados para o Gerente ─────────────────
  const allowedCargos = useMemo(() => {
    if (isFullAdmin) return cargos;
    // Gerente não pode atribuir "Administrador"
    return cargos.filter(c => !ADMIN_ONLY_CARGOS.includes(c.papeis.toLowerCase()));
  }, [cargos, isFullAdmin]);

  // ─── Loaders ─────────────────────────────────────────

  async function loadUsers() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(`
          *,
          unit:units!profiles_id_unidade_fkey(id, name),
          cargo:cargos!profiles_id_cargo_fkey(id, papeis)
        `)
        .order('nome');

      if (error) throw error;
      setUsers(data || []);
    } catch (error) {
      toast.error('Erro ao carregar usuários');
    } finally {
      setLoading(false);
    }
  }

  async function loadUnits() {
    try {
      const { data, error } = await supabase
        .from('units')
        .select('id, name')
        .order('name');
      if (error) throw error;
      setUnits(data || []);
    } catch (error) {
    }
  }

  async function loadCargos() {
    try {
      const { data, error } = await supabase
        .from('cargos')
        .select('id, papeis')
        .order('papeis');
      if (error) throw error;
      setCargos(data || []);
    } catch (error) {
    }
  }

  // ─── Handlers ────────────────────────────────────────

  function handleEditUser(user: Profile) {
    setEditingUser({ ...user });
    setShowEditDialog(true);
    loadUserUnits(user.id, user.id_unidade);
  }

  async function handleSaveUser() {
    if (!editingUser) return;

    setSaving(true);
    try {
      // Proteção de hierarquia: Gerente não pode alterar Administrador
      const isTargetAdmin = editingUser.cargo?.papeis?.toLowerCase().includes('administrador');
      if (isManager && isTargetAdmin) {
        toast.error('Você não tem permissão para alterar um Administrador');
        setSaving(false);
        return;
      }

      // Determinar unidade principal a partir de editingUserUnits
      const primaryUnit = editingUserUnits.find(u => u.is_primary);
      const primaryUnitId = primaryUnit?.unit_id ?? editingUserUnits[0]?.unit_id ?? null;

      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error('Sessão expirada. Faça login novamente.');
      }

      if (isManager) {
        // Gerente: altera apenas cargo/status, via endpoint seguro (service role +
        // validação de hierarquia/unidade no servidor). A escrita direta em `profiles`
        // é bloqueada pelo RLS (apenas Administrador), por isso passa pela edge function.
        const managePayload: { id_cargo?: number; ativo: boolean } = { ativo: editingUser.ativo };
        if (editingUser.id_cargo != null) managePayload.id_cargo = editingUser.id_cargo;

        const response = await fetch(
          `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/users/${editingUser.id}/manage`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${publicAnonKey}`,
              'apikey': publicAnonKey,
              'X-User-Token': accessToken,
            },
            body: JSON.stringify(managePayload),
          }
        );

        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Erro ao salvar alterações');
        }
      } else {
        // Administrador: atualização completa direta (RLS permite) + unidades vinculadas.
        const { data: updatedRows, error } = await supabase
          .from('profiles')
          .update({
            nome: editingUser.nome,
            sobrenome: editingUser.sobrenome,
            email: editingUser.email,
            id_unidade: primaryUnitId, // Sincronizar com a principal de profile_units
            id_cargo: editingUser.id_cargo,
            ativo: editingUser.ativo,
          })
          .eq('id', editingUser.id)
          .select('id');

        if (error) throw error;
        // RLS pode filtrar a linha silenciosamente (0 linhas, sem erro). Detectar.
        if (!updatedRows || updatedRows.length === 0) {
          throw new Error('Nenhuma alteração foi salva. Verifique suas permissões.');
        }

        // ── Salvar profile_units via servidor (bypassa RLS) ──
        const response = await fetch(
          `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/profile-units/${editingUser.id}`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${publicAnonKey}`,
              'apikey': publicAnonKey,
              'X-User-Token': accessToken,
            },
            body: JSON.stringify({ units: editingUserUnits }),
          }
        );

        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Erro ao salvar unidades vinculadas');
        }
      }

      toast.success('Usuário atualizado com sucesso');
      setShowEditDialog(false);
      setEditingUser(null);
      setEditingUserUnits([]);
      await loadUsers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erro ao salvar alterações');
    } finally {
      setSaving(false);
    }
  }

  function toggleUnit(unitKey: string) {
    setCollapsedUnits(prev => {
      const next = new Set(prev);
      if (next.has(unitKey)) {
        next.delete(unitKey);
      } else {
        next.add(unitKey);
      }
      return next;
    });
  }

  // Verifica se o usuário logado pode alternar o status de um dado user
  function canToggleUserStatus(user: Profile): boolean {
    // Não pode alterar o próprio status
    if (user.id === currentUser.id) return false;
    // Administrador pode alterar qualquer outro
    if (isFullAdmin) return true;
    // Gerente pode alterar, exceto administradores
    if (isManager) {
      const isTargetAdmin = user.cargo?.papeis?.toLowerCase().includes('administrador');
      return !isTargetAdmin;
    }
    return false;
  }

  // Texto explicativo de por que o toggle está desabilitado
  function getToggleDisabledReason(user: Profile): string | null {
    if (user.id === currentUser.id) return 'Você não pode alterar seu próprio status';
    if (isManager && user.cargo?.papeis?.toLowerCase().includes('administrador')) {
      return 'Apenas administradores podem alterar o status de outros administradores';
    }
    return null;
  }

  async function handleToggleAtivo(user: Profile) {
    if (!canToggleUserStatus(user)) return;
    const newAtivo = !user.ativo;

    setTogglingUserId(user.id);
    try {
      // Alterar status via endpoint seguro (service role + validação no servidor).
      // A escrita direta em `profiles` é bloqueada pelo RLS para não-Administradores.
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error('Sessão expirada. Faça login novamente.');

      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/users/${user.id}/manage`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${publicAnonKey}`,
            'apikey': publicAnonKey,
            'X-User-Token': accessToken,
          },
          body: JSON.stringify({ ativo: newAtivo }),
        }
      );

      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Erro ao alterar status do usuário');
      }

      // Atualizar estado local imediatamente
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ativo: newAtivo } : u));

      toast.success(
        newAtivo
          ? `${user.nome} foi reativado com sucesso`
          : `${user.nome} foi desativado com sucesso`
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erro ao alterar status do usuário');
    } finally {
      setTogglingUserId(null);
    }
  }

  function getCargoBadge(papeis: string | undefined) {
    const role = papeis?.toLowerCase() || '';
    if (role.includes('administrador')) {
      return { color: 'bg-[#FEE2E2] text-[#991B1B] border-[#FECACA]', icon: ShieldAlert, label: papeis };
    }
    if (role.includes('gerente')) {
      return { color: 'bg-[#EDE9FE] text-[#5B21B6] border-[#DDD6FE]', icon: ShieldCheck, label: papeis };
    }
    if (role.includes('supervisor')) {
      return { color: 'bg-[#E6EAFF] text-[#0023D5] border-[#C7D2FE]', icon: Shield, label: papeis };
    }
    if (role.includes('atendente')) {
      return { color: 'bg-[#DBEAFE] text-[#1E40AF] border-[#BFDBFE]', icon: UserCheck, label: papeis };
    }
    return { color: 'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]', icon: UserX, label: papeis || 'Sem cargo' };
  }

  // ─── Multi-unidade (profile_units) ──────────────────

  async function loadUserUnits(userId: string, fallbackUnitId?: number | null) {
    setLoadingUserUnits(true);
    try {
      // Buscar via servidor (bypassa RLS com SERVICE_ROLE_KEY)
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      if (!accessToken) {
        if (fallbackUnitId != null) {
          setEditingUserUnits([{ unit_id: fallbackUnitId, is_primary: true }]);
        } else {
          setEditingUserUnits([]);
        }
        setLoadingUserUnits(false);
        return;
      }

      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1/api/profile-units/${userId}`,
        {
          headers: {
            'Authorization': `Bearer ${publicAnonKey}`,
            'apikey': publicAnonKey,
            'X-User-Token': accessToken,
          },
        }
      );

      const result = await response.json();

      if (response.ok && result.success && result.units?.length > 0) {
        setEditingUserUnits(result.units);
      } else if (fallbackUnitId != null) {
        // profile_units vazia → pré-marcar a unidade do profiles.id_unidade como principal
        setEditingUserUnits([{ unit_id: fallbackUnitId, is_primary: true }]);
      } else {
        setEditingUserUnits([]);
      }
    } catch (error) {
      // Fallback mesmo em caso de erro
      if (fallbackUnitId != null) {
        setEditingUserUnits([{ unit_id: fallbackUnitId, is_primary: true }]);
      } else {
        setEditingUserUnits([]);
      }
    } finally {
      setLoadingUserUnits(false);
    }
  }

  function handleAddUnit(unitId: number) {
    const alreadyExists = editingUserUnits.some(u => u.unit_id === unitId);
    if (!alreadyExists) {
      setEditingUserUnits(prev => [...prev, { unit_id: unitId, is_primary: false }]);
    }
  }

  function handleRemoveUnit(unitId: number) {
    setEditingUserUnits(prev => prev.filter(u => u.unit_id !== unitId));
  }

  function handleTogglePrimary(unitId: number) {
    setEditingUserUnits(prev => prev.map(u => ({
      ...u,
      is_primary: u.unit_id === unitId ? true : false,
    })));
  }

  // ─── Render ──────────────────────────────────────────

  return (
    <div className="h-full overflow-auto bg-[#F9FAFB]">
      <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl md:text-3xl font-bold text-[#1B1B1B] mb-1" style={{ fontFamily: 'var(--font-display)' }}>
            Configurações
          </h1>
          <p className="text-sm text-[#6B7280]">
            {isFullAdmin
              ? 'Gerencie usuários de todas as unidades, horários e configurações do sistema'
              : currentUser.unitIds.length > 1
                ? `Gerencie os usuários das suas unidades — ${Object.values(currentUser.unitNames).join(', ')}`
                : `Gerencie os usuários da sua unidade — ${currentUser.unitName || 'N/A'}`
            }
          </p>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="users" className="space-y-6">
          <TabsList className={`grid w-full ${isFullAdmin ? 'grid-cols-4' : 'grid-cols-2'} lg:w-auto lg:inline-grid`}>
            <TabsTrigger value="users" className="gap-2">
              <Users className="w-4 h-4" />
              Usuários
            </TabsTrigger>
            <TabsTrigger value="automation" className="gap-2">
              <Zap className="w-4 h-4" />
              Automação
            </TabsTrigger>
            {isFullAdmin && (
              <TabsTrigger value="hours" className="gap-2">
                <Clock className="w-4 h-4" />
                Horário de Atendimento
              </TabsTrigger>
            )}
            {isFullAdmin && (
              <TabsTrigger value="permissions" className="gap-2">
                <Lock className="w-4 h-4" />
                Permissões de menu
              </TabsTrigger>
            )}
          </TabsList>

          {/* ═══════════ TAB: USUÁRIOS ═══════════ */}
          <TabsContent value="users" className="space-y-5">
            {/* Search + Filter */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 relative group">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9CA3AF] transition-colors group-focus-within:text-[#0023D5]" />
                <Input
                  type="text"
                  placeholder="Buscar por nome, email ou cargo..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 h-10 bg-white border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10"
                />
              </div>
              {isManager && (
                <div className="flex items-center gap-2 px-3 py-2 bg-[#E6EAFF] rounded-lg border border-[#C7D2FE]">
                  <Filter className="w-4 h-4 text-[#0023D5]" />
                  <span className="text-sm font-medium text-[#0023D5]">
                    {currentUser.unitIds.length > 1
                      ? `${currentUser.unitIds.length} unidades`
                      : `Apenas: ${currentUser.unitName || 'N/A'}`
                    }
                  </span>
                </div>
              )}
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="Total"
                value={stats.total}
                icon={<Users className="w-5 h-5 text-[#0023D5]" />}
                bg="bg-[#E6EAFF]"
              />
              <StatCard
                label="Ativos"
                value={stats.ativos}
                icon={<UserCheck className="w-5 h-5 text-[#059669]" />}
                bg="bg-[#D1FAE5]"
              />
              <StatCard
                label="Inativos"
                value={stats.inativos}
                icon={<UserX className="w-5 h-5 text-[#DC2626]" />}
                bg="bg-[#FEE2E2]"
              />
              <StatCard
                label="Acesso Pendente"
                value={stats.semCargo}
                icon={<Shield className="w-5 h-5 text-[#D97706]" />}
                bg="bg-[#FEF3C7]"
              />
            </div>

            {/* Users grouped by unit */}
            {loading ? (
              <div className="flex flex-col items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-[#0023D5] mb-3" />
                <span className="text-sm text-[#6B7280]">Carregando usuários...</span>
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20">
                <Users className="w-12 h-12 text-[#D1D5DB] mb-3" />
                <span className="text-[#6B7280] font-medium">
                  {searchTerm ? 'Nenhum usuário encontrado' : 'Nenhum usuário cadastrado'}
                </span>
              </div>
            ) : (
              <div className="space-y-4">
                {groupedByUnit.map(([unitKey, group]) => {
                  const isCollapsed = collapsedUnits.has(unitKey);
                  const unitName = group.unit?.name || 'Sem unidade atribuída';
                  const unitCount = group.users.length;
                  const activeCount = group.users.filter(u => u.ativo).length;
                  const pendingCount = group.users.filter(u => {
                    const c = u.cargo?.papeis?.toLowerCase();
                    return !c || c === 'sem cargo';
                  }).length;

                  return (
                    <div
                      key={unitKey}
                      className="bg-white rounded-xl border border-[#E5E7EB] overflow-hidden"
                      style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
                    >
                      {/* Unit Header */}
                      <button
                        onClick={() => toggleUnit(unitKey)}
                        className="w-full flex items-center gap-3 px-5 py-3.5 bg-[#F9FAFB] hover:bg-[#F3F4F6] transition-colors border-b border-[#E5E7EB]"
                      >
                        <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ backgroundColor: group.unit ? '#E6EAFF' : '#FEF3C7' }}>
                          <Building className="w-4.5 h-4.5" style={{ color: group.unit ? '#0023D5' : '#D97706' }} />
                        </div>
                        <div className="flex-1 text-left">
                          <span className="text-sm font-semibold text-[#1B1B1B]">{unitName}</span>
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-xs text-[#6B7280]">{unitCount} usuário{unitCount !== 1 ? 's' : ''}</span>
                            <span className="text-xs text-[#059669]">{activeCount} ativo{activeCount !== 1 ? 's' : ''}</span>
                            {pendingCount > 0 && (
                              <span className="text-xs text-[#D97706]">{pendingCount} pendente{pendingCount !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                        </div>
                        {isCollapsed ? (
                          <ChevronRight className="w-5 h-5 text-[#9CA3AF]" />
                        ) : (
                          <ChevronDown className="w-5 h-5 text-[#9CA3AF]" />
                        )}
                      </button>

                      {/* Users List */}
                      {!isCollapsed && (
                        <>
                          {/* Desktop Table */}
                          <div className="hidden md:block overflow-x-auto">
                            <table className="w-full">
                              <thead>
                                <tr className="border-b border-[#F3F4F6]">
                                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Usuário</th>
                                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Email</th>
                                  <th className="text-left px-5 py-2.5 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Cargo</th>
                                  <th className="text-center px-5 py-2.5 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Status</th>
                                  <th className="text-center px-5 py-2.5 text-xs font-semibold text-[#6B7280] uppercase tracking-wider w-24">Ações</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-[#F3F4F6]">
                                {group.users.map(user => {
                                  const badge = getCargoBadge(user.cargo?.papeis);
                                  const BadgeIcon = badge.icon;
                                  const canToggle = canToggleUserStatus(user);
                                  const isToggling = togglingUserId === user.id;
                                  return (
                                    <tr key={user.id} className={`hover:bg-[#FAFBFC] transition-colors ${!user.ativo ? 'opacity-60' : ''}`}>
                                      <td className="px-5 py-3.5">
                                        <div className="flex items-center gap-3">
                                          <div
                                            className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0`}
                                            style={{ backgroundColor: user.ativo ? '#0023D5' : '#9CA3AF' }}
                                          >
                                            {user.nome?.charAt(0).toUpperCase() || '?'}
                                          </div>
                                          <div className="min-w-0">
                                            <span className="text-sm font-semibold text-[#1B1B1B] block truncate">
                                              {user.nome} {user.sobrenome}
                                            </span>
                                            {user.created_at && (
                                              <span className="text-[11px] text-[#9CA3AF]">
                                                Desde {new Date(user.created_at).toLocaleDateString('pt-BR')}
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      </td>
                                      <td className="px-5 py-3.5 text-sm text-[#4B5563]">{user.email}</td>
                                      <td className="px-5 py-3.5">
                                        <Badge
                                          variant="outline"
                                          className={`${badge.color} text-xs font-medium gap-1`}
                                        >
                                          <BadgeIcon className="w-3 h-3" />
                                          {badge.label}
                                        </Badge>
                                      </td>
                                      <td className="px-5 py-3.5">
                                        <div className="flex items-center justify-center gap-2">
                                          {isToggling ? (
                                            <Loader2 className="w-4 h-4 animate-spin text-[#9CA3AF]" />
                                          ) : (
                                            <Switch
                                              checked={user.ativo}
                                              onCheckedChange={() => handleToggleAtivo(user)}
                                              className={`data-[state=checked]:bg-[#059669] data-[state=unchecked]:bg-[#d1d5db] ${!canToggle ? 'opacity-50 cursor-not-allowed' : ''}`}
                                              disabled={!canToggle || isToggling}
                                              title={getToggleDisabledReason(user) || (user.ativo ? 'Clique para desativar' : 'Clique para ativar')}
                                            />
                                          )}
                                          <span className={`text-xs font-medium min-w-[42px] ${user.ativo ? 'text-[#059669]' : 'text-[#DC2626]'}`}>
                                            {user.ativo ? 'Ativo' : 'Inativo'}
                                          </span>
                                        </div>
                                      </td>
                                      <td className="px-5 py-3.5">
                                        <div className="flex justify-center">
                                          <Button
                                            onClick={() => handleEditUser(user)}
                                            variant="outline"
                                            size="sm"
                                            className="h-8 w-8 p-0 border-[#E5E7EB] text-[#0023D5] hover:bg-[#E6EAFF] hover:border-[#0023D5] transition-all"
                                            title="Editar usuário"
                                          >
                                            <Edit2 className="w-3.5 h-3.5" />
                                          </Button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {/* Mobile Cards */}
                          <div className="md:hidden divide-y divide-[#F3F4F6]">
                            {group.users.map(user => {
                              const badge = getCargoBadge(user.cargo?.papeis);
                              const BadgeIcon = badge.icon;
                              const canToggle = canToggleUserStatus(user);
                              const isToggling = togglingUserId === user.id;
                              return (
                                <div key={user.id} className={`p-4 hover:bg-[#FAFBFC] transition-colors ${!user.ativo ? 'opacity-60' : ''}`}>
                                  <div className="flex items-start gap-3">
                                    <div
                                      className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0"
                                      style={{ backgroundColor: user.ativo ? '#0023D5' : '#9CA3AF' }}
                                    >
                                      {user.nome?.charAt(0).toUpperCase() || '?'}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                          <span className="text-sm font-semibold text-[#1B1B1B] block truncate">
                                            {user.nome} {user.sobrenome}
                                          </span>
                                          <span className="text-xs text-[#6B7280] block truncate">{user.email}</span>
                                        </div>
                                        <Button
                                          onClick={() => handleEditUser(user)}
                                          variant="outline"
                                          size="sm"
                                          className="h-8 w-8 p-0 border-[#E5E7EB] text-[#0023D5] hover:bg-[#E6EAFF] flex-shrink-0"
                                        >
                                          <Edit2 className="w-3.5 h-3.5" />
                                        </Button>
                                      </div>
                                      <div className="flex items-center gap-2 mt-2">
                                        <Badge
                                          variant="outline"
                                          className={`${badge.color} text-[11px] font-medium gap-1`}
                                        >
                                          <BadgeIcon className="w-3 h-3" />
                                          {badge.label}
                                        </Badge>
                                      </div>
                                      {/* Toggle de status inline no mobile */}
                                      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-[#F3F4F6]">
                                        <span className="text-xs text-[#6B7280]">Status</span>
                                        <div className="flex items-center gap-2">
                                          {isToggling ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#9CA3AF]" />
                                          ) : (
                                            <Switch
                                              checked={user.ativo}
                                              onCheckedChange={() => handleToggleAtivo(user)}
                                              className={`data-[state=checked]:bg-[#059669] data-[state=unchecked]:bg-[#d1d5db] scale-90 ${!canToggle ? 'opacity-50 cursor-not-allowed' : ''}`}
                                              disabled={!canToggle || isToggling}
                                              title={getToggleDisabledReason(user) || (user.ativo ? 'Clique para desativar' : 'Clique para ativar')}
                                            />
                                          )}
                                          <span className={`text-xs font-medium ${user.ativo ? 'text-[#059669]' : 'text-[#DC2626]'}`}>
                                            {user.ativo ? 'Ativo' : 'Inativo'}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ═══════════ TAB: AUTOMAÇÃO (Gerente+) ═══════════ */}
          <TabsContent value="automation">
            <AutomationPanel />
          </TabsContent>

          {/* ═══════════ TAB: HORÁRIO DE ATENDIMENTO (Admin only) ═══════════ */}
          {isFullAdmin && (
            <TabsContent value="hours">
              <BusinessHours />
            </TabsContent>
          )}

          {/* ═══════════ TAB: PERMISSÕES DE MENU (Admin only) ═══════════ */}
          {isFullAdmin && (
            <TabsContent value="permissions">
              <MenuPermissionsPanel />
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* ═══════════ EDIT USER DIALOG ═══════════ */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-[500px] flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: '#0023D5' }}
              >
                <Edit2 className="w-4 h-4 text-white" />
              </div>
              {isManager ? 'Gerenciar Usuário' : 'Editar Usuário'}
            </DialogTitle>
            <DialogDescription className="text-sm text-[#6B7280]">
              {isManager
                ? 'Altere o cargo e o status do usuário da sua unidade'
                : 'Altere as informações do usuário'
              }
            </DialogDescription>
          </DialogHeader>

          {editingUser && (() => {
              // Detectar se Gerente está editando um Administrador (usa cargo ORIGINAL do join, não o id_cargo editável)
              const isTargetAdmin = editingUser.cargo?.papeis?.toLowerCase().includes('administrador');
              const isManagerEditingAdmin = isManager && !!isTargetAdmin;
              const isSelf = editingUser.id === currentUser.id;
              // Gerente não pode alterar cargo de Admin, nem de si mesmo se for Admin
              const canEditCargo = isFullAdmin || (isManager && !isTargetAdmin);
              // Gerente não pode alterar status de Admin nem de si mesmo
              const canToggleStatus = isFullAdmin || (isManager && !isSelf && !isTargetAdmin);

              return (
            <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-6 py-4">
              {/* Banner de restrição quando Gerente visualiza Admin */}
              {isManagerEditingAdmin && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA]">
                  <ShieldAlert className="w-4 h-4 text-[#DC2626] flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-[#991B1B]">
                      Permissão insuficiente
                    </p>
                    <p className="text-xs text-[#B91C1C] mt-0.5 leading-relaxed">
                      Você não pode alterar o cargo ou status de um Administrador. Apenas outro Administrador tem essa permissão.
                    </p>
                  </div>
                </div>
              )}

              {/* Info do Usuário (sempre visível como readonly) */}
              <div className="flex items-center gap-3 p-3 bg-[#F9FAFB] rounded-lg border border-[#E5E7EB]">
                <div
                  className="w-11 h-11 rounded-full flex items-center justify-center text-white font-semibold"
                  style={{ backgroundColor: '#0023D5' }}
                >
                  {editingUser.nome?.charAt(0).toUpperCase() || '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-[#1B1B1B] block truncate">
                    {editingUser.nome} {editingUser.sobrenome}
                  </span>
                  <span className="text-xs text-[#6B7280] block truncate">{editingUser.email}</span>
                  {editingUser.unit && (
                    <span className="text-xs text-[#0023D5] flex items-center gap-1 mt-0.5">
                      <Building className="w-3 h-3" />
                      {editingUser.unit.name}
                    </span>
                  )}
                </div>
              </div>

              {/* Campos editáveis apenas para Admin */}
              {isFullAdmin && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="nome" className="text-sm font-semibold text-[#4B5563]">
                        Nome
                      </Label>
                      <Input
                        id="nome"
                        value={editingUser.nome}
                        onChange={(e) => setEditingUser({ ...editingUser, nome: e.target.value })}
                        className="bg-white border-[#E5E7EB] focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="sobrenome" className="text-sm font-semibold text-[#4B5563]">
                        Sobrenome
                      </Label>
                      <Input
                        id="sobrenome"
                        value={editingUser.sobrenome}
                        onChange={(e) => setEditingUser({ ...editingUser, sobrenome: e.target.value })}
                        className="bg-white border-[#E5E7EB] focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-sm font-semibold text-[#4B5563]">
                      Email
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={editingUser.email}
                      onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })}
                      className="bg-white border-[#E5E7EB] focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10"
                    />
                  </div>

                  {/* ── Unidades vinculadas (multi-unidade) ── */}
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-[#4B5563] flex items-center gap-2">
                      <Building className="w-4 h-4" />
                      Unidades vinculadas
                      {editingUserUnits.length > 0 && (
                        <Badge variant="outline" className="bg-[#E6EAFF] text-[#0023D5] border-[#C7D2FE] text-[10px] px-1.5 py-0">
                          {editingUserUnits.length}
                        </Badge>
                      )}
                    </Label>
                    <p className="text-xs text-[#9CA3AF]">
                      Marque as unidades que este usuário deve visualizar. A unidade principal define o default ao criar leads.
                    </p>

                    {loadingUserUnits ? (
                      <div className="flex items-center gap-2 py-3">
                        <Loader2 className="w-4 h-4 animate-spin text-[#9CA3AF]" />
                        <span className="text-xs text-[#9CA3AF]">Carregando unidades...</span>
                      </div>
                    ) : (
                      <div className="border border-[#E5E7EB] rounded-lg divide-y divide-[#F3F4F6] max-h-[200px] overflow-y-auto">
                        {units.map((unit) => {
                          const isChecked = editingUserUnits.some(u => u.unit_id === unit.id);
                          const isPrimary = editingUserUnits.find(u => u.unit_id === unit.id)?.is_primary || false;

                          return (
                            <div
                              key={unit.id}
                              className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${isChecked ? 'bg-[#F0F4FF]' : 'bg-white hover:bg-[#FAFBFC]'}`}
                            >
                              <Checkbox
                                checked={isChecked}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    handleAddUnit(unit.id);
                                  } else {
                                    handleRemoveUnit(unit.id);
                                  }
                                }}
                                className="data-[state=checked]:bg-[#0023D5] data-[state=checked]:border-[#0023D5]"
                              />
                              <span className={`text-sm flex-1 ${isChecked ? 'font-medium text-[#1B1B1B]' : 'text-[#4B5563]'}`}>
                                {unit.name}
                              </span>
                              {isChecked && (
                                <button
                                  type="button"
                                  onClick={() => handleTogglePrimary(unit.id)}
                                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors ${
                                    isPrimary
                                      ? 'bg-[#0023D5] text-white border-[#0023D5]'
                                      : 'bg-white text-[#9CA3AF] border-[#E5E7EB] hover:border-[#0023D5] hover:text-[#0023D5]'
                                  }`}
                                  title={isPrimary ? 'Unidade principal' : 'Definir como principal'}
                                >
                                  {isPrimary ? 'Principal' : 'Definir principal'}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Cargo — editável para Admin e Gerente */}
              <div className="space-y-2">
                <Label htmlFor="cargo" className="text-sm font-semibold text-[#4B5563]">
                  Cargo
                </Label>
                {canEditCargo ? (
                  <Select
                    value={editingUser.id_cargo?.toString() || ''}
                    onValueChange={(value) => setEditingUser({ ...editingUser, id_cargo: parseInt(value) })}
                  >
                    <SelectTrigger className="border-[#E5E7EB] focus:border-[#0023D5]">
                      <SelectValue placeholder="Selecione o cargo" />
                    </SelectTrigger>
                    <SelectContent>
                      {allowedCargos.map((cargo) => (
                        <SelectItem key={cargo.id} value={cargo.id.toString()}>
                          {cargo.papeis}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-[#F9FAFB] rounded-lg border border-[#E5E7EB]">
                    <Badge
                      variant="outline"
                      className="bg-[#FEE2E2] text-[#991B1B] border-[#FECACA] text-xs font-medium gap-1"
                    >
                      <ShieldAlert className="w-3 h-3" />
                      {editingUser.cargo?.papeis || 'Sem cargo'}
                    </Badge>
                    <span className="text-xs text-[#9CA3AF]">— protegido</span>
                  </div>
                )}
                {isManager && canEditCargo && (
                  <p className="text-xs text-[#9CA3AF] mt-1">
                    Como gerente, você pode atribuir cargos até o nível de Gerente.
                  </p>
                )}
              </div>

              {/* Status Ativo — Admin e Gerente */}
              <div className="space-y-3">
                <div
                  className={`flex items-center justify-between py-3 px-4 rounded-lg border transition-colors ${
                    !editingUser.ativo
                      ? 'bg-[#FEF2F2] border-[#FECACA]'
                      : 'bg-[#F9FAFB] border-[#E5E7EB]'
                  }`}
                >
                  <div className="space-y-0.5">
                    <Label
                      htmlFor="ativo"
                      className={`text-sm font-semibold cursor-pointer ${
                        !editingUser.ativo ? 'text-[#991B1B]' : 'text-[#4B5563]'
                      }`}
                    >
                      Status do Usuário
                    </Label>
                    <p className={`text-xs ${!editingUser.ativo ? 'text-[#B91C1C]' : 'text-[#9CA3AF]'}`}>
                      {editingUser.ativo
                        ? 'Usuário ativo — pode acessar o sistema'
                        : 'Usuário desativado — não consegue fazer login'
                      }
                    </p>
                  </div>
                  <Switch
                    id="ativo"
                    checked={editingUser.ativo}
                    onCheckedChange={(checked) => setEditingUser({ ...editingUser, ativo: checked })}
                    className={`data-[state=checked]:bg-[#059669] data-[state=unchecked]:bg-[#d1d5db] ${!canToggleStatus ? 'opacity-50 cursor-not-allowed' : ''}`}
                    disabled={!canToggleStatus}
                  />
                </div>

                {/* Alerta ao desativar */}
                {!editingUser.ativo && canToggleStatus && (
                  <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-[#FEF9C3] border border-[#FDE68A]">
                    <AlertTriangle className="w-4 h-4 text-[#D97706] flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-semibold text-[#92400E]">
                        Atenção: Ao desativar este usuário
                      </p>
                      <p className="text-xs text-[#A16207] mt-0.5 leading-relaxed">
                        Ele perderá o acesso ao sistema imediatamente. As conversas atribuídas a ele não serão reatribuídas automaticamente.
                      </p>
                    </div>
                  </div>
                )}

                {/* Explicação quando não pode alterar */}
                {!canToggleStatus && isSelf && (
                  <p className="text-xs text-[#9CA3AF] px-1">
                    Você não pode desativar sua própria conta.
                  </p>
                )}
                {!canToggleStatus && isManagerEditingAdmin && !isSelf && (
                  <p className="text-xs text-[#9CA3AF] px-1">
                    Apenas administradores podem alterar o status de outros administradores.
                  </p>
                )}
              </div>
            </div>
          )})()}

          {/* Dialog Footer — Salvar / Cancelar */}
          {editingUser && (
            <div className="shrink-0 flex items-center justify-end gap-2 border-t border-[#E5E7EB] bg-white px-6 py-4">
              <Button
                onClick={() => {
                  setShowEditDialog(false);
                  setEditingUser(null);
                }}
                variant="outline"
                disabled={saving}
                className="border-[#E5E7EB] text-[#4B5563] hover:bg-[#F3F3F3]"
              >
                <X className="w-4 h-4 mr-1.5" />
                Cancelar
              </Button>
              <Button
                onClick={handleSaveUser}
                disabled={saving}
                className="text-white"
                style={{ backgroundColor: '#0023D5' }}
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    Salvando...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-1.5" />
                    Salvar
                  </>
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Componente auxiliar ────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  bg,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  bg: string;
}) {
  return (
    <div className="bg-white rounded-lg p-4 border border-[#E5E7EB]" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-[#6B7280]">{label}</p>
          <p className="text-2xl font-bold text-[#1B1B1B] mt-1">{value}</p>
        </div>
        <div className={`p-3 rounded-lg ${bg}`}>
          {icon}
        </div>
      </div>
    </div>
  );
}