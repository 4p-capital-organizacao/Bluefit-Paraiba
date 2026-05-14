import { useState, useEffect } from 'react';
import { Mail, Lock, User, Building, AlertCircle, Eye, EyeOff, ArrowRight, CheckCircle2, Loader2, RefreshCw, Phone } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { validatePassword } from '@/app/lib/passwordValidation';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import blueDeskLogo from '../../assets/d1f7bbbdb5465392ff878250337517f331699beb.png';

const API_BASE = `https://${projectId}.supabase.co/functions/v1/make-server-844b77a1`;

interface SignupFormProps {
  onSignupSuccess: () => void;
  onSwitchToLogin: () => void;
}

interface Unit {
  id: number;
  name: string;
}

export function SignupForm({ onSignupSuccess, onSwitchToLogin }: SignupFormProps) {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    nome: '',
    sobrenome: '',
    id_unidade: '',
    telefone: '',
  });
  const [units, setUnits] = useState<Unit[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(true);
  const [unitsError, setUnitsError] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [autoConfirmedMsg, setAutoConfirmedMsg] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    loadUnits();
  }, []);

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function loadUnits() {
    try {
      setLoadingUnits(true);
      setUnitsError(false);

      // Endpoint público — o formulário roda sem autenticação, e a RLS de
      // `units` só libera SELECT para usuários autenticados. A query direta
      // pelo client anon volta vazia, então buscamos pela edge function.
      const response = await fetch(`${API_BASE}/api/units`, {
        headers: { 'Authorization': `Bearer ${publicAnonKey}` },
      });
      const result = await response.json();

      if (!result.success) {
        setUnitsError(true);
        return;
      }

      setUnits(result.units || []);
    } catch (err) {
      setUnitsError(true);
    } finally {
      setLoadingUnits(false);
    }
  }

  function handleChange(field: string, value: string) {
    setFormData(prev => ({ ...prev, [field]: value }));
  }

  /**
   * Aplica máscara de telefone brasileiro: (XX) XXXXX-XXXX ou (XX) XXXX-XXXX
   * Aceita apenas dígitos, máximo 11 (DDD + número)
   */
  function handlePhoneChange(rawValue: string) {
    // Remove tudo que não é dígito
    const digits = rawValue.replace(/\D/g, '').slice(0, 11);

    let masked = '';
    if (digits.length === 0) {
      masked = '';
    } else if (digits.length <= 2) {
      masked = `(${digits}`;
    } else if (digits.length <= 6) {
      masked = `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
    } else if (digits.length <= 10) {
      // Fixo: (XX) XXXX-XXXX
      masked = `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    } else {
      // Celular: (XX) XXXXX-XXXX
      masked = `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
    }

    setFormData(prev => ({ ...prev, telefone: masked }));
  }

  /**
   * Retorna o telefone completo com código do país: 55XXXXXXXXXXX
   */
  function getFullPhone(): string {
    const digits = formData.telefone.replace(/\D/g, '');
    if (digits.length < 10) return '';
    return `55${digits}`;
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (formData.password !== formData.confirmPassword) {
        throw new Error('As senhas não coincidem');
      }

      const pwValidation = validatePassword(formData.password);
      if (!pwValidation.isValid) {
        throw new Error('Senha fraca: ' + pwValidation.errors[0]);
      }

      if (!formData.id_unidade) {
        throw new Error('Selecione uma unidade');
      }

      const phoneDigits = formData.telefone.replace(/\D/g, '');
      if (phoneDigits.length < 10 || phoneDigits.length > 11) {
        throw new Error('Informe um telefone válido com DDD (10 ou 11 dígitos)');
      }

      const response = await fetch(`${API_BASE}/api/auth/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${publicAnonKey}`,
        },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          nome: formData.nome,
          sobrenome: formData.sobrenome,
          id_unidade: formData.id_unidade,
          telefone: getFullPhone() || null,
          redirectTo: `${window.location.origin}/auth/callback`,
        }),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Erro ao criar conta');
      }

      setRegisteredEmail(formData.email);
      setSuccess(true);

      if (result.confirmationError === 'rate_limited') {
        // Rate limited — iniciar cooldown maior e não mostrar "email enviado"
        setCooldown(120);
      } else {
        // Email enviado com sucesso — cooldown normal
        setCooldown(60);
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar conta');
    } finally {
      setLoading(false);
    }
  }

  async function handleResendEmail() {
    if (cooldown > 0) return;
    setResending(true);
    setResendSuccess(false);

    try {
      const response = await fetch(`${API_BASE}/api/auth/resend-confirmation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${publicAnonKey}`,
        },
        body: JSON.stringify({
          email: registeredEmail,
          redirectTo: `${window.location.origin}/auth/callback`,
        }),
      });

      const result = await response.json();

      if (result.success) {
        if (result.autoConfirmed) {
          // Email já estava confirmado previamente — informar o usuário
          setResendSuccess(true);
          setAutoConfirmedMsg('Seu email já está confirmado! Faça login normalmente.');
        } else {
          setResendSuccess(true);
          setAutoConfirmedMsg('');
          setCooldown(60);
          setTimeout(() => setResendSuccess(false), 5000);
        }
      } else if (result.rateLimited) {
        setCooldown(result.waitSeconds || 60);
        setError(result.error || 'Limite de envio atingido. Aguarde e tente novamente.');
        setTimeout(() => setError(''), 8000);
      } else {
        setError(result.error || 'Erro ao reenviar email.');
        setTimeout(() => setError(''), 8000);
      }
    } catch (err) {
      // Resend error - silently continue
    } finally {
      setResending(false);
    }
  }

  // Tela de sucesso — verificação de email
  if (success) {
    return (
      <div className="min-h-screen bg-[#F9FAFB] flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full opacity-[0.04]" style={{ backgroundColor: '#0023D5' }}></div>
          <div className="absolute -bottom-48 -left-48 w-[600px] h-[600px] rounded-full opacity-[0.03]" style={{ backgroundColor: '#0023D5' }}></div>
        </div>

        <div className="w-full max-w-md relative z-10">
          <div className="bg-white rounded-2xl p-10 text-center" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
            {/* Animated Mail Icon */}
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full mb-6" style={{ backgroundColor: '#E6EAFF' }}>
              <Mail className="w-10 h-10" style={{ color: '#0023D5' }} />
            </div>

            <h2 className="text-2xl font-semibold text-[#1B1B1B] mb-3">
              Verifique seu email
            </h2>

            <p className="text-[#6B7280] mb-2">
              Enviamos um link de confirmação para:
            </p>

            <p className="text-[#0023D5] font-semibold text-lg mb-6 break-all">
              {registeredEmail}
            </p>

            <div className="bg-[#F3F4F6] rounded-xl p-5 mb-6 text-left">
              <p className="text-sm text-[#4B5563] leading-relaxed">
                <strong className="text-[#1B1B1B]">Próximos passos:</strong>
              </p>
              <ol className="text-sm text-[#4B5563] mt-2 space-y-2">
                <li className="flex items-start gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-white flex-shrink-0 mt-0.5" style={{ backgroundColor: '#0023D5' }}>1</span>
                  <span>Abra seu email e clique no link de confirmação</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-white flex-shrink-0 mt-0.5" style={{ backgroundColor: '#0023D5' }}>2</span>
                  <span>Após confirmar, faça login no Blue Desk</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-white flex-shrink-0 mt-0.5" style={{ backgroundColor: '#0023D5' }}>3</span>
                  <span>Aguarde um administrador aprovar seu acesso</span>
                </li>
              </ol>
            </div>

            {/* Resend button */}
            <div className="space-y-3">
              <button
                onClick={handleResendEmail}
                disabled={resending || cooldown > 0}
                className="inline-flex items-center gap-2 text-sm text-[#0023D5] hover:text-[#001AAA] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {resending
                  ? 'Reenviando...'
                  : cooldown > 0
                    ? `Reenviar em ${cooldown}s`
                    : 'Reenviar email de confirmação'}
              </button>

              {resendSuccess && (
                <div className="flex items-center justify-center gap-1.5 text-sm text-[#10B981]">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{autoConfirmedMsg || 'Email reenviado com sucesso!'}</span>
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#E5E7EB]"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-4 bg-white text-[#9CA3AF]">ou</span>
              </div>
            </div>

            {/* Login Link */}
            <Button
              onClick={onSwitchToLogin}
              variant="outline"
              className="w-full h-11 font-semibold rounded-lg border-[#E5E7EB] text-[#4B5563] hover:bg-[#F9FAFB]"
            >
              Ir para Login
            </Button>

            {/* Spam tip */}
            <div className="mt-5 px-4 py-3 rounded-lg border-l-[3px]" style={{ backgroundColor: '#FEF9C3', borderLeftColor: '#EAB308' }}>
              <p className="text-xs text-[#713F12] leading-relaxed">
                <strong>Dica:</strong> Verifique sua caixa de spam se não encontrar o email em alguns minutos.
              </p>
            </div>
          </div>

          <div className="text-center mt-6">
            <p className="text-[#9CA3AF] text-xs">
              © 2026 Blue Desk by Bluefit
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F9FAFB] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background Decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full opacity-[0.04]" style={{ backgroundColor: '#0023D5' }}></div>
        <div className="absolute -bottom-48 -left-48 w-[600px] h-[600px] rounded-full opacity-[0.03]" style={{ backgroundColor: '#0023D5' }}></div>
      </div>

      {/* Signup Card */}
      <div className="w-full max-w-lg relative z-10">
        <div className="bg-white rounded-2xl p-8 md:p-10" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)' }}>
          {/* Logo & Branding */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-24 h-24 mb-5">
              <img src={blueDeskLogo} alt="Blue Desk" className="w-24 h-24 object-contain" />
            </div>
            <h1 className="text-2xl font-semibold text-[#1B1B1B] mb-1" style={{ fontFamily: 'var(--font-display)' }}>
              Criar Conta
            </h1>
            <p className="text-[14px] text-[#6B7280]">
              Comece a usar o Blue Desk
            </p>
          </div>

          {/* Error Alert */}
          {error && (
            <div className="mb-6 flex items-center gap-2 px-4 py-3 rounded-lg border-l-[3px]" style={{ backgroundColor: '#FEF2F2', borderLeftColor: '#EF4444' }}>
              <AlertCircle className="h-4 w-4 text-[#EF4444] flex-shrink-0" />
              <p className="text-sm text-[#EF4444]">{error}</p>
            </div>
          )}

          {/* Signup Form */}
          <form onSubmit={handleSignup} className="space-y-5">
            {/* Name Fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="nome" className="text-[#4B5563] font-medium text-sm">
                  Nome
                </Label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9CA3AF] pointer-events-none z-10" />
                  <Input
                    id="nome"
                    type="text"
                    value={formData.nome}
                    onChange={(e) => handleChange('nome', e.target.value)}
                    placeholder="João"
                    className="pl-11 h-12 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
                    required
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sobrenome" className="text-[#4B5563] font-medium text-sm">
                  Sobrenome
                </Label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9CA3AF] pointer-events-none z-10" />
                  <Input
                    id="sobrenome"
                    type="text"
                    value={formData.sobrenome}
                    onChange={(e) => handleChange('sobrenome', e.target.value)}
                    placeholder="Silva"
                    className="pl-11 h-12 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
                    required
                    disabled={loading}
                  />
                </div>
              </div>
            </div>

            {/* Email Field */}
            <div className="space-y-2">
              <Label htmlFor="email" className="text-[#4B5563] font-medium text-sm">
                Email
              </Label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9CA3AF] pointer-events-none z-10" />
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  placeholder="seu@email.com"
                  className="pl-11 h-12 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
                  required
                  autoComplete="email"
                  disabled={loading}
                />
              </div>
            </div>

            {/* Unidade */}
            <div className="space-y-2">
              <Label htmlFor="unidade" className="text-[#4B5563] font-medium text-sm">
                Unidade
              </Label>
              <div className="relative">
                <Building className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9CA3AF] pointer-events-none z-10" />
                <Select
                  value={formData.id_unidade}
                  onValueChange={(value) => handleChange('id_unidade', value)}
                  disabled={loading || loadingUnits}
                >
                  <SelectTrigger
                    id="unidade"
                    className="pl-11 h-12 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
                  >
                    <SelectValue
                      placeholder={
                        loadingUnits
                          ? 'Carregando unidades...'
                          : unitsError
                            ? 'Erro ao carregar unidades'
                            : units.length === 0
                              ? 'Nenhuma unidade disponível'
                              : 'Selecione sua unidade'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={String(unit.id)}>
                        {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(unitsError || (!loadingUnits && units.length === 0)) && (
                <div className="flex items-center justify-between gap-2 text-sm text-[#EF4444]">
                  <span className="flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    {unitsError
                      ? 'Não foi possível carregar as unidades.'
                      : 'Nenhuma unidade cadastrada.'}
                  </span>
                  {unitsError && (
                    <button
                      type="button"
                      onClick={loadUnits}
                      disabled={loadingUnits}
                      className="inline-flex items-center gap-1 font-medium text-[#0023D5] hover:text-[#001AAA] transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${loadingUnits ? 'animate-spin' : ''}`} />
                      Tentar novamente
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Telefone */}
            <div className="space-y-2">
              <Label htmlFor="telefone" className="text-[#4B5563] font-medium text-sm">
                Telefone
              </Label>
              <div className="relative flex">
                {/* Prefixo +55 fixo */}
                <div className="flex items-center gap-1.5 px-3 h-12 bg-[#E5E7EB] border border-r-0 border-[#E5E7EB] rounded-l-lg select-none">
                  <Phone className="w-[16px] h-[16px] text-[#6B7280]" />
                  <span className="text-sm font-semibold text-[#4B5563] whitespace-nowrap">+55</span>
                </div>
                <Input
                  id="telefone"
                  type="tel"
                  value={formData.telefone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  placeholder="(11) 99999-9999"
                  className="h-12 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-l-none rounded-r-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
                  required
                  disabled={loading}
                />
              </div>
            </div>

            {/* Password Fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="password" className="text-[#4B5563] font-medium text-sm">
                  Senha
                </Label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9CA3AF] pointer-events-none z-10" />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={formData.password}
                    onChange={(e) => handleChange('password', e.target.value)}
                    placeholder="Min. 6 caracteres"
                    className="pl-11 pr-12 h-12 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
                    required
                    autoComplete="new-password"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#4B5563] transition-colors duration-150"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-[#4B5563] font-medium text-sm">
                  Confirmar Senha
                </Label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-[18px] h-[18px] text-[#9CA3AF] pointer-events-none z-10" />
                  <Input
                    id="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={formData.confirmPassword}
                    onChange={(e) => handleChange('confirmPassword', e.target.value)}
                    placeholder="Repita a senha"
                    className="pl-11 pr-12 h-12 bg-[#F3F3F3] border-[#E5E7EB] text-[#1B1B1B] placeholder:text-[#9CA3AF] rounded-lg focus:border-[#0023D5] focus:ring-2 focus:ring-[#0023D5]/10 transition-all duration-150"
                    required
                    autoComplete="new-password"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#4B5563] transition-colors duration-150"
                    tabIndex={-1}
                  >
                    {showConfirmPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              disabled={loading}
              className="w-full h-12 text-white font-semibold rounded-lg transition-all duration-150 group mt-2"
              style={{ 
                backgroundColor: '#0023D5',
                boxShadow: '0 2px 4px rgba(0,35,213,0.2)',
              }}
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Criando conta...</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span>Criar Conta</span>
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </div>
              )}
            </Button>
          </form>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#E5E7EB]"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-white text-[#9CA3AF]">ou</span>
            </div>
          </div>

          {/* Login Link */}
          <div className="text-center">
            <p className="text-[14px] text-[#6B7280]">
              Já tem uma conta?{' '}
              <button
                type="button"
                onClick={onSwitchToLogin}
                className="text-[#0023D5] hover:text-[#001AAA] font-semibold transition-colors duration-150"
              >
                Fazer login
              </button>
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-6">
          <p className="text-[#9CA3AF] text-xs">
            © 2026 Blue Desk by Bluefit
          </p>
        </div>
      </div>
    </div>
  );
}