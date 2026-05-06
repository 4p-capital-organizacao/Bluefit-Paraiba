import {
  Home, Users, LogOut, Menu, X, Settings, UserPlus, MessagesSquare,
  BarChart3, ChevronLeft, ChevronRight, ChevronDown, Headset, User, Bell, UsersRound,
  FileText,
} from 'lucide-react';
import { useState, useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { NotificationCenter } from './NotificationCenter';
import blueDeskLogo from '../../assets/d1f7bbbdb5465392ff878250337517f331699beb.png';
import { colors } from './ModernDesignSystem';
import { usePresence, PresenceStatus } from '../hooks/usePresence';
import { useUserProfile } from '../hooks/useUserProfile';
import { useModulePermissions } from '../hooks/useModulePermissions';
import { useAuth } from '../contexts/AuthContext';
import { Badge } from './ui/badge';

type ModuleId = 'home' | 'contacts' | 'conversations' | 'dashboard' | 'team-dashboard' | 'crm' | 'templates' | 'config' | 'profile' | 'notifications';

interface MenuItem {
  id: ModuleId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  path?: string;
  children?: { id: ModuleId; label: string; icon: React.ComponentType<{ className?: string }>; path: string }[];
}

/** Mapeia pathname para module id */
function getActiveModule(pathname: string): ModuleId {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/team-dashboard')) return 'team-dashboard';
  if (pathname.startsWith('/dashboard')) return 'dashboard';
  if (pathname.startsWith('/contacts')) return 'contacts';
  if (pathname.startsWith('/conversations')) return 'conversations';
  if (pathname.startsWith('/crm')) return 'crm';
  if (pathname.startsWith('/templates')) return 'templates';
  if (pathname.startsWith('/config')) return 'config';
  if (pathname.startsWith('/profile')) return 'profile';
  if (pathname.startsWith('/notifications')) return 'notifications';
  return 'home';
}

export function Sidebar() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);

  const location = useLocation();
  const navigate = useNavigate();
  const { authUser, logout } = useAuth();
  const { profile: userProfile } = useUserProfile();
  const { canAccess: canAccessModule } = useModulePermissions();
  const { myStatus } = usePresence();

  const currentModule = getActiveModule(location.pathname);

  // 🎨 Mapeamento de status para cor da bolinha no avatar
  const statusColorMap: Record<PresenceStatus, string> = {
    online: 'bg-green-500',
    away: 'bg-yellow-500',
    busy: 'bg-red-500',
    offline: 'bg-gray-400',
  };
  const statusLabelMap: Record<PresenceStatus, string> = {
    online: 'Online',
    away: 'Ausente',
    busy: 'Ocupado',
    offline: 'Offline',
  };
  const presenceDotColor = statusColorMap[myStatus] || 'bg-gray-400';
  const presenceDotLabel = statusLabelMap[myStatus] || 'Offline';

  // 🔐 Menu filtrado por cargo
  const menuItems: MenuItem[] = useMemo(() => {
    const items: MenuItem[] = [
      { id: 'home', label: 'Início', icon: Home, path: '/' },
    ];

    // Dashboard geral: Administrador apenas
    if (userProfile.isFullAdmin) {
      items.push({ id: 'dashboard', label: 'Dashboard', icon: BarChart3, path: '/dashboard' });
    }

    // Dashboard da Unidade: Supervisor+ (isAdmin = Supervisor, Gerente, Administrador)
    if (userProfile.isAdmin) {
      items.push({ id: 'team-dashboard', label: 'Dashboard da Unidade', icon: UsersRound, path: '/team-dashboard' });
    }

    // Chat ao vivo: Atendente+ (qualquer cargo válido)
    const cargoLower = userProfile.cargoName?.toLowerCase() || '';
    const hasCargo = userProfile.isLoaded && cargoLower !== 'sem cargo' && cargoLower !== '';

    if (hasCargo) {
      items.push({
        id: 'conversations' as ModuleId,
        label: 'Chat ao vivo',
        icon: Headset,
        children: [
          { id: 'contacts', label: 'Contatos', icon: UserPlus, path: '/contacts' },
          { id: 'conversations', label: 'Conversas', icon: MessagesSquare, path: '/conversations' },
        ],
      });

      // CRM: Atendente+
      items.push({ id: 'crm', label: 'CRM', icon: Users, path: '/crm' });
    }

    // Templates: gated por menu_item_permissions (admin escolhe quais cargos veem)
    if (canAccessModule('templates')) {
      items.push({ id: 'templates', label: 'Templates', icon: FileText, path: '/templates' });
    }

    // Configurações: Gerente+ (isManager) — Gerente vê apenas usuários da sua unidade
    if (userProfile.isManager) {
      items.push({ id: 'config', label: 'Configurações', icon: Settings, path: '/config' });
    }

    return items;
  }, [userProfile.isManager, userProfile.isFullAdmin, userProfile.isLoaded, userProfile.cargoName, canAccessModule]);

  function handleLogout() {
    logout();
    setMobileOpen(false);
    navigate('/login');
  }

  function toggleSidebar() {
    setIsExpanded(!isExpanded);
  }

  function isChildActive(item: MenuItem): boolean {
    if (item.children) {
      return item.children.some(child => child.id === currentModule);
    }
    return currentModule === item.id;
  }

  return (
    <>
      {/* Mobile Menu Button */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 p-3 bg-white rounded-lg shadow-lg border border-[#E5E7EB] hover:bg-[#F3F3F3] transition-all duration-150"
      >
        {mobileOpen ? <X className="w-6 h-6 text-[#1B1B1B]" /> : <Menu className="w-6 h-6 text-[#1B1B1B]" />}
      </button>

      {/* Mobile Backdrop */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        initial={false}
        animate={{
          width: isExpanded ? 280 : 80,
          x: mobileOpen ? 0 : (typeof window !== 'undefined' && window.innerWidth < 1024 ? -280 : 0),
        }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="fixed top-0 left-0 h-screen bg-white border-r border-[#E5E7EB] z-40 flex flex-col lg:relative lg:translate-x-0"
        style={{ width: isExpanded ? 280 : 80 }}
      >
        {/* Logo & Toggle */}
        <div className={`p-4 border-b border-[#E5E7EB] flex items-center ${isExpanded ? 'justify-between' : 'justify-center'}`}>
          {isExpanded ? (
            <Link to="/" className="flex items-center gap-3 hover:opacity-90 transition-opacity" onClick={() => setMobileOpen(false)}>
              <img src={blueDeskLogo} alt="Blue Desk" className="w-14 h-14 object-contain" />
              <div>
                <h1 className="text-lg font-bold text-[#1B1B1B]" style={{ fontFamily: 'var(--font-display)' }}>
                  Blue Desk
                </h1>
                <p className="text-xs text-[#9CA3AF]">WhatsApp Business</p>
              </div>
            </Link>
          ) : (
            <Link to="/" onClick={() => setMobileOpen(false)}>
              <img src={blueDeskLogo} alt="Blue Desk" className="w-12 h-12 object-contain" />
            </Link>
          )}

          <button
            onClick={toggleSidebar}
            className="hidden lg:flex items-center justify-center w-8 h-8 rounded-lg hover:bg-[#F3F3F3] transition-all duration-150"
          >
            {isExpanded ? (
              <ChevronLeft className="w-5 h-5 text-[#4B5563]" />
            ) : (
              <ChevronRight className="w-5 h-5 text-[#4B5563]" />
            )}
          </button>
        </div>

        {/* User Profile (clicável → /profile) */}
        <Link
          to="/profile"
          onClick={() => setMobileOpen(false)}
          className={`p-4 border-b border-[#E5E7EB] hover:bg-[#F9FAFB] transition-colors ${isExpanded ? '' : 'flex justify-center'}`}
        >
          {isExpanded ? (
            <div className="flex items-center gap-3">
              <div className="relative flex-shrink-0">
                <div
                  className="flex items-center justify-center w-10 h-10 rounded-full text-white font-semibold text-sm"
                  style={{ backgroundColor: colors.primary }}
                >
                  {authUser?.profile?.nome?.[0]?.toUpperCase() || 'U'}
                </div>
                <span
                  className={`absolute bottom-0 right-0 w-3 h-3 ${presenceDotColor} border-2 border-white rounded-full transition-colors duration-300`}
                  title={presenceDotLabel}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[#1B1B1B] truncate">
                  {authUser?.profile?.nome || 'Usuário'}
                </div>
                <div className="text-xs text-[#9CA3AF] truncate">
                  {authUser?.profile?.cargo || userProfile.cargoName || 'Sem cargo'}
                </div>
              </div>
            </div>
          ) : (
            <div className="relative">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-full text-white font-semibold text-sm"
                style={{ backgroundColor: colors.primary }}
                title={`Meu Perfil — ${presenceDotLabel}`}
              >
                {authUser?.profile?.nome?.[0]?.toUpperCase() || 'U'}
              </div>
              <span
                className={`absolute bottom-0 right-0 w-3 h-3 ${presenceDotColor} border-2 border-white rounded-full transition-colors duration-300`}
                title={presenceDotLabel}
              />
            </div>
          )}
        </Link>

        {/* Navigation Menu */}
        <nav className="flex-1 overflow-y-auto p-4">
          <div className="space-y-1">
            {isExpanded && (
              <div className="text-[11px] font-semibold text-[#9CA3AF] uppercase tracking-wider mb-3 px-3">
                Navegação
              </div>
            )}
            {menuItems.map((item) => {
              const Icon = item.icon;

              // Item com sub-menu (Chat ao vivo)
              if (item.children) {
                const parentActive = isChildActive(item);

                return (
                  <div key={item.label}>
                    {/* Parent button */}
                    <button
                      onClick={() => {
                        if (isExpanded) {
                          setChatOpen(!chatOpen);
                        } else {
                          // Collapsed: navigate to first child
                          navigate(item.children![0].path);
                          setMobileOpen(false);
                        }
                      }}
                      className={`
                        w-full flex items-center gap-3 px-3 py-3 rounded-lg font-medium transition-all duration-150
                        ${parentActive && !isExpanded
                          ? 'bg-[#0023D5] text-white'
                          : parentActive && isExpanded
                            ? 'bg-[#E6EAFF] text-[#0023D5]'
                            : 'text-[#1B1B1B] hover:bg-[#F3F3F3]'
                        }
                        ${isExpanded ? 'justify-start' : 'justify-center'}
                      `}
                      title={!isExpanded ? item.label : undefined}
                    >
                      <Icon className={`w-5 h-5 flex-shrink-0 ${
                        parentActive && !isExpanded ? 'text-white' :
                        parentActive && isExpanded ? 'text-[#0023D5]' :
                        'text-[#4B5563]'
                      }`} />
                      {isExpanded && (
                        <>
                          <span className="text-sm flex-1 text-left">{item.label}</span>
                          <motion.div
                            animate={{ rotate: chatOpen ? 180 : 0 }}
                            transition={{ duration: 0.2 }}
                          >
                            <ChevronDown className="w-4 h-4 opacity-60" />
                          </motion.div>
                        </>
                      )}
                    </button>

                    {/* Children */}
                    {isExpanded && (
                      <AnimatePresence initial={false}>
                        {chatOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: 'easeInOut' }}
                            className="overflow-hidden"
                          >
                            <div className="ml-4 pl-4 border-l-2 border-[#E5E7EB] mt-1 space-y-1">
                              {item.children!.map((child) => {
                                const isActive = currentModule === child.id;
                                const ChildIcon = child.icon;

                                return (
                                  <Link
                                    key={child.id}
                                    to={child.path}
                                    onClick={() => setMobileOpen(false)}
                                    className={`
                                      w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-medium transition-all duration-150 text-sm
                                      ${isActive
                                        ? 'bg-[#0023D5] text-white'
                                        : 'text-[#4B5563] hover:bg-[#F3F3F3] hover:text-[#1B1B1B]'
                                      }
                                    `}
                                  >
                                    <ChildIcon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-white' : ''}`} />
                                    <span>{child.label}</span>
                                  </Link>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    )}
                  </div>
                );
              }

              // Item simples (sem sub-menu)
              const isActive = currentModule === item.id;

              return (
                <Link
                  key={item.id}
                  to={item.path || '/'}
                  onClick={() => setMobileOpen(false)}
                  className={`
                    w-full flex items-center gap-3 px-3 py-3 rounded-lg font-medium transition-all duration-150
                    ${isActive
                      ? 'bg-[#0023D5] text-white'
                      : 'text-[#1B1B1B] hover:bg-[#F3F3F3]'
                    }
                    ${isExpanded ? 'justify-start' : 'justify-center'}
                  `}
                  title={!isExpanded ? item.label : undefined}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-white' : 'text-[#4B5563]'}`} />
                  {isExpanded && <span className="text-sm">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Bottom Section */}
        <div className={`p-4 border-t border-[#E5E7EB] space-y-2 ${isExpanded ? '' : 'flex flex-col items-center'}`}>
          {/* Notification Center */}
          <div className={isExpanded ? '' : 'mb-2'}>
            <NotificationCenter />
          </div>

          {/* Notifications Page Link */}
          {isExpanded && (
            <Link
              to="/notifications"
              onClick={() => setMobileOpen(false)}
              className={`
                w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-medium transition-all duration-150 text-sm
                ${currentModule === 'notifications'
                  ? 'bg-[#0023D5] text-white'
                  : 'text-[#4B5563] hover:bg-[#F3F3F3] hover:text-[#1B1B1B]'
                }
              `}
            >
              <Bell className={`w-4 h-4 flex-shrink-0 ${currentModule === 'notifications' ? 'text-white' : ''}`} />
              <span>Ver todas notificações</span>
            </Link>
          )}

          {/* Logout Button */}
          <button
            onClick={handleLogout}
            className={`
              w-full flex items-center gap-3 px-3 py-3 rounded-lg font-medium transition-all duration-150
              text-[#EF4444] hover:bg-red-50
              ${isExpanded ? 'justify-start' : 'justify-center'}
            `}
            title={!isExpanded ? 'Sair' : undefined}
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            {isExpanded && <span className="text-sm">Sair</span>}
          </button>
        </div>
      </motion.aside>
    </>
  );
}