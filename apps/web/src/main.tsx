import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, ArrowRight, BarChart3, CalendarRange, ChevronRight, ClipboardList, Eye, EyeOff, GraduationCap, LayoutDashboard, LogOut, Menu,
  Server, Settings as SettingsIcon, Shield, UsersRound,
} from 'lucide-react';
import { ApiError, get, mutate, type PublicSettings, type Session } from './api.js';
import { ErrorMessage, Resource, Toaster, field, setDateStyle, statusText, submit, useAction, useResource } from './ui.js';
import { Overview } from './overview.js';
import { ApplicantDetail, ApplicantForm, ApplicantList } from './applicants.js';
import { ApplicationCreate, ApplicationDetail, ApplicationList } from './applications.js';
import { ProgrammeDetail, ProgrammeForm, ProgrammeList } from './programmes.js';
import { IntakeDetail, IntakeForm, IntakeList } from './intakes.js';
import { Analytics } from './analytics.js';
import { ActivityLog } from './activity.js';
import { Infrastructure } from './infrastructure.js';
import { SettingsPage } from './settings.js';
import { BrandingContext, defaultBranding, useBranding } from './branding.js';
import './theme.css';
import './styles.css';


function Brand({ settings }: { settings: PublicSettings }) {
  return <span className="brand">
    {settings.institutionLogo
      ? <img className="brand-logo" src={settings.institutionLogo} alt="" />
      : <span className="brand-mark"><GraduationCap aria-hidden="true" strokeWidth={1.9} /></span>}
    <span className="brand-text"><span>Admissions</span><small>{settings.institutionName}</small></span>
  </span>;
}

function AccountForm({ session, setSession, expired, signOut }: { session?: Session; setSession: (session: Session) => void; expired: boolean; signOut?: () => Promise<void> }) {
  const action = useAction();
  const navigate = useNavigate();
  const { settings } = useBranding();
  const changing = Boolean(session);
  const [showPassword, setShowPassword] = useState(false);
  return <main className="auth-layout">
    <section className="auth-panel">
      <div className="auth-header"><Brand settings={settings} /></div>
      <div className="auth-inner">
        <div className="auth-copy">
          <h1>{changing ? 'Change your password' : 'Sign in'}</h1>
          <p>{expired ? 'Your session expired. Sign in again to continue.' : session?.mustChangePassword ? 'Set a new password to finish activating your account.' : changing ? 'Use at least 12 characters.' : 'Sign in to manage applicants, applications and admission intakes.'}</p>
        </div>
        <form className="stack" onSubmit={submit(form => void action.run(async () => {
          const updated = changing
            ? await mutate<Session>('/auth/change-password', 'POST', { currentPassword: field(form, 'currentPassword'), newPassword: String(form.get('newPassword') ?? '') }, session?.csrfToken)
            : await mutate<Session>('/auth/login', 'POST', { email: field(form, 'email'), password: String(form.get('password') ?? '') });
          setSession(updated);
          navigate(updated.mustChangePassword ? '/change-password' : '/', { replace: true });
        }))}>
          {changing ? <>
            <label>Current password<Input type="password" name="currentPassword" autoComplete="current-password" required /></label>
            <label>New password<Input type="password" name="newPassword" autoComplete="new-password" minLength={12} required /></label>
          </> : <>
            <label>Email<Input type="email" name="email" autoComplete="username" required /></label>
            <div className="password-field">
              <label>Password<Input type={showPassword ? 'text' : 'password'} name="password" autoComplete="current-password" required /></label>
              <Button type="button" variant="ghost" size="icon" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(visible => !visible)}>
                {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
              </Button>
            </div>
          </>}
          <ErrorMessage message={action.error} />
          <Button className="auth-submit" disabled={action.pending}>{action.pending ? 'Please wait…' : changing ? 'Change password' : 'Sign in'}<ArrowRight size={18} aria-hidden="true" /></Button>
          {session && !session.mustChangePassword && <Button type="button" variant="outline" onClick={() => navigate('/settings?tab=account')}>Back to settings</Button>}
          {signOut && <Button type="button" variant="outline" disabled={action.pending} onClick={() => void action.run(signOut)}>Sign out</Button>}
        </form>
        {!changing && <div className="auth-help"><Shield size={16} aria-hidden="true" /><p>For account or password help, contact your admissions system administrator.</p></div>}
      </div>
    </section>
    <div className="auth-art" aria-hidden="true" />
  </main>;
}

type NavItem = { to: string; label: string; icon: typeof Activity; end?: boolean; admin?: boolean };
const sections: { title: string; links: NavItem[] }[] = [
  { title: 'Workspace', links: [
    { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/applicants', label: 'Applicants', icon: UsersRound },
    { to: '/applications', label: 'Applications', icon: ClipboardList },
    { to: '/programmes', label: 'Programmes', icon: GraduationCap },
    { to: '/intakes', label: 'Admission Intakes', icon: CalendarRange },
  ] },
  { title: 'Insights', links: [
    { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    { to: '/activity', label: 'Activity Logs', icon: Activity, admin: true },
  ] },
  { title: 'System', links: [
    { to: '/infrastructure', label: 'Infrastructure Status', icon: Server },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ] },
];

function Layout({ session, children, signOut }: { session: Session; children: ReactNode; signOut: () => Promise<void> }) {
  const action = useAction();
  const { settings } = useBranding();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const admin = session.user.role === 'ADMIN';
  const current = sections.flatMap(section => section.links.map(link => ({ ...link, section: section.title })))
    .filter(link => link.end ? pathname === link.to : pathname.startsWith(link.to))[0];
  const initials = session.user.displayName.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0] ?? '').join('').toUpperCase();
  useEffect(() => { document.title = (current ? current.label + ' · ' : '') + settings.institutionName + ' Admissions'; }, [current, settings.institutionName]);
  return <div className="shell">
    <a href="#main-content" className="skip">Skip to content</a>
    <aside className="sidebar">
      <div className="sidebar-header">
        <NavLink to="/" aria-label="Admissions overview"><Brand settings={settings} /></NavLink>
        <Button variant="outline" size="sm" className="mobile-menu" aria-controls="main-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}><Menu size={17} aria-hidden="true" />Menu</Button>
      </div>
      <nav id="main-navigation" className={menuOpen ? 'open' : undefined} aria-label="Main navigation" onClick={event => {
        if (event.target instanceof Element && event.target.closest('a')) setMenuOpen(false);
      }}>
        {sections.map(section => <div key={section.title} className="nav-section">
          <p className="nav-title">{section.title}</p>
          {section.links.filter(link => !link.admin || admin).map(link => {
            const Icon = link.icon;
            return <NavLink key={link.to} to={link.to} end={link.end}><Icon size={18} aria-hidden="true" />{link.label}</NavLink>;
          })}
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <span>Admin number</span>
        <strong>{settings.adminNumber || 'Not set'}</strong>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="workspace-path" aria-hidden="true"><span>{current?.section ?? 'Workspace'}</span><ChevronRight size={14} /><strong>{current?.label ?? 'Overview'}</strong></div>
        <div className="topbar-account">
          <div className="identity"><span className="avatar" aria-hidden="true">{initials}</span><div><strong>{session.user.displayName}</strong><span>{statusText(session.user.role)}</span></div></div>
          <Button variant="outline" size="sm" className="sign-out" disabled={action.pending} onClick={() => void action.run(signOut)}><LogOut size={16} aria-hidden="true" />Sign out</Button>
        </div>
      </header>
      <main id="main-content" className="content" tabIndex={-1}><ErrorMessage message={action.error} />{children}</main>
    </div>
    <Toaster />
  </div>;
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [expired, setExpired] = useState(false);
  const navigate = useNavigate();
  const restore = useResource(async () => {
    try { return await get<Session>('/auth/me'); }
    catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
  }, 'session');
  useEffect(() => {
    function expire() { setExpired(true); setSession(null); }
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, []);
  const userSession = session === undefined ? restore.value : session;
  const update = (current: Session) => { setExpired(false); setSession(current); };
  if (userSession === undefined) return <main className="content"><Resource state={restore}>{() => null}</Resource></main>;
  if (!userSession) return <Routes><Route path="/login" element={<AccountForm expired={expired} setSession={update} />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes>;
  const signOut = async () => {
    await mutate('/auth/logout', 'POST', {}, userSession.csrfToken);
    setSession(null);
    navigate('/login', { replace: true });
  };
  if (userSession.mustChangePassword) {
    return <Routes><Route path="/change-password" element={<AccountForm key="temporary" session={userSession} expired={false} setSession={update} signOut={signOut} />} /><Route path="*" element={<Navigate to="/change-password" replace />} /></Routes>;
  }
  const s = userSession;
  return <Routes>
    <Route path="/change-password" element={<AccountForm key="change" session={s} expired={false} setSession={update} />} />
    <Route path="*" element={<Layout session={s} signOut={signOut}><Routes>
      <Route path="/" element={<Overview session={s} />} />
      <Route path="/applicants" element={<ApplicantList session={s} />} />
      <Route path="/applicants/new" element={<ApplicantForm session={s} />} />
      <Route path="/applicants/:applicantId" element={<ApplicantDetail session={s} />} />
      <Route path="/applicants/:applicantId/edit" element={<ApplicantForm session={s} />} />
      <Route path="/applications" element={<ApplicationList session={s} />} />
      <Route path="/applications/new" element={<ApplicationCreate session={s} />} />
      <Route path="/applications/:applicationId" element={<ApplicationDetail session={s} />} />
      <Route path="/programmes" element={<ProgrammeList session={s} />} />
      <Route path="/programmes/new" element={<ProgrammeForm session={s} />} />
      <Route path="/programmes/:programmeId" element={<ProgrammeDetail session={s} />} />
      <Route path="/programmes/:programmeId/edit" element={<ProgrammeForm session={s} />} />
      <Route path="/intakes" element={<IntakeList session={s} />} />
      <Route path="/intakes/new" element={<IntakeForm session={s} />} />
      <Route path="/intakes/:intakeId" element={<IntakeDetail session={s} />} />
      <Route path="/intakes/:intakeId/edit" element={<IntakeForm session={s} />} />
      <Route path="/analytics" element={<Analytics />} />
      {s.user.role === 'ADMIN' && <Route path="/activity" element={<ActivityLog />} />}
      <Route path="/infrastructure" element={<Infrastructure />} />
      <Route path="/settings" element={<SettingsPage session={s} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></Layout>} />
  </Routes>;
}

function Root() {
  const [settings, setSettings] = useState<PublicSettings>(defaultBranding);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    get<PublicSettings>('/settings/public').then(value => { setDateStyle(value.dateFormat); setSettings(value); }).catch(() => undefined);
  }, [revision]);
  return <BrandingContext.Provider value={{ settings, refresh: () => setRevision(value => value + 1) }}>
    <BrowserRouter><App key={settings.dateFormat} /></BrowserRouter>
  </BrandingContext.Provider>;
}

document.documentElement.dataset.density = localStorage.getItem('table-density') ?? 'comfortable';
createRoot(document.getElementById('root')!).render(<Root />);
