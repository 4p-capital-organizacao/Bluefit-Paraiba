import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, useNavigate, useLocation } from 'react-router';
import { AppLayout } from './components/layouts/AppLayout';
import { RoleGuard } from './components/guards/RoleGuard';
import { useAuth } from './contexts/AuthContext';
import { Loader2, Waves } from 'lucide-react';

// Auth pages (eagerly loaded - first screen)
import { LoginForm } from './components/LoginForm';
import { SignupForm } from './components/SignupForm';
import { ResetPasswordForm } from './components/ResetPasswordForm';
import { UpdatePasswordForm } from './components/UpdatePasswordForm';

// Lazy-loaded pages (loaded on demand)
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage').then(m => ({ default: m.AuthCallbackPage })));
const HomePage = lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const ContactsModule = lazy(() => import('./pages/ContactsModule').then(m => ({ default: m.ContactsModule })));
const ConversationsModule = lazy(() => import('./pages/ConversationsModule').then(m => ({ default: m.ConversationsModule })));
const DashboardModule = lazy(() => import('./pages/DashboardModule').then(m => ({ default: m.DashboardModule })));
const TeamDashboardModule = lazy(() => import('./pages/TeamDashboardModule').then(m => ({ default: m.TeamDashboardModule })));
const CRMModule = lazy(() => import('./pages/CRMModule').then(m => ({ default: m.CRMModule })));
const ConfigModule = lazy(() => import('./pages/ConfigModule').then(m => ({ default: m.ConfigModule })));
const TemplatesModule = lazy(() => import('./pages/TemplatesModule').then(m => ({ default: m.TemplatesModule })));
const ProfilePage = lazy(() => import('./pages/ProfilePage').then(m => ({ default: m.ProfilePage })));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage').then(m => ({ default: m.NotificationsPage })));
const ErrorBoundary = lazy(() => import('./components/ErrorBoundary').then(m => ({ default: m.ErrorBoundary })));

// --- Loading fallback ---

function PageLoader() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-[#0023D5]" />
    </div>
  );
}

function LazyPage({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

// --- Wrapper Pages para rotas publicas ---

function LoginPage() {
  const { login, isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as any)?.from?.pathname || '/';

  if (!isLoading && isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  async function handleLoginSuccess(accessToken: string) {
    await login(accessToken);
    navigate(from, { replace: true });
  }

  return (
    <LoginForm
      onLoginSuccess={handleLoginSuccess}
      onSwitchToSignup={() => navigate('/signup')}
      onSwitchToResetPassword={() => navigate('/reset-password')}
    />
  );
}

function SignupPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  if (!isLoading && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <SignupForm
      onSignupSuccess={() => navigate('/login')}
      onSwitchToLogin={() => navigate('/login')}
    />
  );
}

function ResetPasswordPage() {
  const navigate = useNavigate();

  return (
    <ResetPasswordForm
      onSwitchToLogin={() => navigate('/login')}
    />
  );
}

function UpdatePasswordPage() {
  const navigate = useNavigate();

  return (
    <UpdatePasswordForm
      onSuccess={() => navigate('/login', { replace: true })}
    />
  );
}

// --- Wrapper Pages para rotas com RoleGuard ---

function DashboardPage() {
  return (
    <RoleGuard requiredRole="admin">
      <LazyPage>
        <ErrorBoundary>
          <DashboardModule />
        </ErrorBoundary>
      </LazyPage>
    </RoleGuard>
  );
}

function ContactsPage() {
  return (
    <RoleGuard requiredRole="attendant">
      <LazyPage>
        <ErrorBoundary>
          <ContactsModule />
        </ErrorBoundary>
      </LazyPage>
    </RoleGuard>
  );
}

function ConversationsPage() {
  return (
    <RoleGuard requiredRole="attendant">
      <LazyPage>
        <ErrorBoundary>
          <ConversationsModule />
        </ErrorBoundary>
      </LazyPage>
    </RoleGuard>
  );
}

function CRMPage() {
  return (
    <RoleGuard requiredRole="attendant">
      <LazyPage>
        <CRMModule />
      </LazyPage>
    </RoleGuard>
  );
}

function TeamDashboardPage() {
  return (
    <RoleGuard requiredRole="supervisor">
      <LazyPage>
        <ErrorBoundary>
          <TeamDashboardModule />
        </ErrorBoundary>
      </LazyPage>
    </RoleGuard>
  );
}

function ConfigPage() {
  return (
    <RoleGuard requiredRole="manager">
      <LazyPage>
        <ConfigModule />
      </LazyPage>
    </RoleGuard>
  );
}

function TemplatesPage() {
  // Guard via menu_item_permissions (em runtime). RoleGuard "attendant" como
  // baseline: usuário precisa ter algum cargo válido. O check fino é o backend
  // (POST templates) e o Sidebar (esconde o item de menu se não puder).
  return (
    <RoleGuard requiredRole="attendant">
      <LazyPage>
        <ErrorBoundary>
          <TemplatesModule />
        </ErrorBoundary>
      </LazyPage>
    </RoleGuard>
  );
}

// --- Pagina 404 ---

function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="h-full flex items-center justify-center bg-[#F9FAFB]">
      <div className="text-center max-w-md px-6">
        <div
          className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6"
          style={{ backgroundColor: '#0023D5', boxShadow: '0 8px 32px rgba(0,35,213,0.2)' }}
        >
          <Waves className="w-10 h-10 text-white" />
        </div>
        <h1 className="text-3xl font-bold text-[#1B1B1B] mb-2">404</h1>
        <p className="text-[#6B7280] mb-6">Pagina nao encontrada</p>
        <button
          onClick={() => navigate('/')}
          className="px-6 py-3 rounded-lg text-white font-medium transition-all"
          style={{ backgroundColor: '#0023D5' }}
        >
          Voltar ao Inicio
        </button>
      </div>
    </div>
  );
}

// --- Router ---

export const router = createBrowserRouter([
  // Rotas publicas (auth)
  { path: '/login', Component: LoginPage },
  { path: '/signup', Component: SignupPage },
  { path: '/reset-password', Component: ResetPasswordPage },
  { path: '/update-password', Component: UpdatePasswordPage },
  {
    path: '/auth/callback',
    element: <LazyPage><AuthCallbackPage /></LazyPage>,
  },

  // Rotas autenticadas (AppLayout cuida de auth guard + sidebar)
  {
    path: '/',
    Component: AppLayout,
    children: [
      {
        index: true,
        element: <LazyPage><HomePage /></LazyPage>,
      },
      { path: 'dashboard', Component: DashboardPage },
      { path: 'team-dashboard', Component: TeamDashboardPage },
      { path: 'contacts', Component: ContactsPage },
      { path: 'contacts/:contactId', Component: ContactsPage },
      { path: 'conversations', Component: ConversationsPage },
      { path: 'conversations/:conversationId', Component: ConversationsPage },
      { path: 'crm', Component: CRMPage },
      { path: 'templates', Component: TemplatesPage },
      { path: 'config', Component: ConfigPage },
      {
        path: 'profile',
        element: <LazyPage><ProfilePage /></LazyPage>,
      },
      {
        path: 'notifications',
        element: <LazyPage><NotificationsPage /></LazyPage>,
      },
      { path: '*', Component: NotFound },
    ],
  },
]);
