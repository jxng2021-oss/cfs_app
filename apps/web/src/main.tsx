import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, BookOpen, ChevronRight, ClipboardList, Eye, EyeOff, GraduationCap, LayoutGrid, LogOut, Menu, Shield, UserRound, UsersRound } from 'lucide-react';
import { ApiError, get, mutate, type Session } from './api.js';
import { AdminAudit, AdminEnrolments, AdminModules, AdminUsers } from './admin.js';
import { ModuleDetail, ModuleList, ModuleRoster } from './modules.js';
import { MaterialDetail, TopicDetail, TopicList } from './learning.js';
import { ErrorMessage, Heading, Resource, field, submit, useAction, useResource } from './ui.js';
import './theme.css';
import './styles.css';

const roleNames = { ADMIN: 'Administrator', LECTURER: 'Lecturer', STUDENT: 'Student' };
const landing = (session: Session) => session.user.role === 'ADMIN' ? '/admin/modules' : '/modules';

function Brand() {
  return <span className="brand"><span className="brand-mark"><GraduationCap aria-hidden="true" strokeWidth={1.9} /></span><span>CFS<span className="brand-separator" />Learn</span></span>;
}

function AccountForm({ session, setSession, expired, signOut }: { session?: Session; setSession: (session: Session) => void; expired: boolean; signOut?: () => Promise<void> }) {
  const action = useAction();
  const navigate = useNavigate();
  const changing = Boolean(session);
  const [showPassword, setShowPassword] = useState(false);
  return <main className="auth-layout">
    <section className="auth-panel">
      <div className="auth-header"><Brand /></div>
      <div className="auth-inner">
        <div className="auth-copy">
          <h1>{changing ? 'Change your password' : 'Sign in'}</h1>
          <p>{expired ? 'Your session expired. Sign in again to continue.' : session?.mustChangePassword ? 'Set a new password to finish activating your account.' : changing ? 'Use at least 12 characters.' : 'Use your learning account to access your modules.'}</p>
        </div>
        <form className="stack" onSubmit={submit(form => void action.run(async () => {
          const updated = changing
            ? await mutate<Session>('/auth/change-password', 'POST', { currentPassword: field(form, 'currentPassword'), newPassword: field(form, 'newPassword') }, session?.csrfToken)
            : await mutate<Session>('/auth/login', 'POST', { email: field(form, 'email'), password: field(form, 'password') });
          setSession(updated);
          navigate(updated.mustChangePassword ? '/change-password' : landing(updated), { replace: true });
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
          {session && !session.mustChangePassword && <Link to="/profile" className="back">Back to profile</Link>}
          {signOut && <Button type="button" variant="outline" disabled={action.pending} onClick={() => void action.run(signOut)}>Sign out</Button>}
        </form>
        {!changing && <div className="auth-help"><Shield size={16} aria-hidden="true"/><p>For account or password help, contact your LMS administrator.</p></div>}
      </div>
    </section>
    <div className="auth-art" aria-hidden="true" />
  </main>;
}

function Layout({ session, children, signOut }: { session: Session; children: ReactNode; signOut: () => Promise<void> }) {
  const action = useAction();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const admin = session.user.role === 'ADMIN';
  const context = pathname.startsWith('/admin/users') ? 'User accounts' : pathname.startsWith('/admin/audit') ? 'Audit log' : pathname.startsWith('/profile') ? 'Profile' : admin ? 'Modules' : 'My modules';
  const moduleId = matchPath('/modules/:moduleId/*', pathname)?.params.moduleId;
  const modulePath = '/modules/' + moduleId;
  const initials = session.user.displayName.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0] ?? '').join('').toUpperCase();
  return <div className="shell">
    <a href="#main-content" className="skip">Skip to content</a>
    <aside className="sidebar">
      <div className="sidebar-header">
        <Link to={landing(session)} aria-label="Mini LMS home"><Brand /></Link>
        <Button variant="outline" size="sm" className="mobile-menu" aria-controls="main-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}><Menu size={17} aria-hidden="true"/>Menu</Button>
      </div>
      <nav id="main-navigation" className={menuOpen ? 'open' : undefined} aria-label="Main navigation" onClick={event => {
        if (event.target instanceof Element && event.target.closest('a')) setMenuOpen(false);
      }}>
        <p className="nav-title">{admin ? 'Administration' : 'Workspace'}</p>
        {admin ? <>
          <NavLink to="/admin/modules"><LayoutGrid size={18} aria-hidden="true"/>Modules</NavLink>
          <NavLink to="/admin/users"><UsersRound size={18} aria-hidden="true"/>User accounts</NavLink>
          <NavLink to="/admin/audit"><ClipboardList size={18} aria-hidden="true"/>Audit log</NavLink>
        </> : <NavLink to="/modules"><BookOpen size={18} aria-hidden="true"/>My modules</NavLink>}
        <p className="nav-title">Account</p>
        <NavLink to="/profile"><UserRound size={18} aria-hidden="true"/>Profile</NavLink>
      </nav>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="workspace-path" aria-hidden="true"><span>{admin ? 'Administration' : 'Workspace'}</span><ChevronRight size={14}/><strong>{context}</strong></div>
        <div className="topbar-account">
          <div className="identity"><span className="avatar" aria-hidden="true">{initials}</span><div><strong>{session.user.displayName}</strong><span>{roleNames[session.user.role]}</span></div></div>
          <Button variant="outline" size="sm" className="sign-out" disabled={action.pending} onClick={() => void action.run(signOut)}><LogOut size={16} aria-hidden="true"/>Sign out</Button>
        </div>
      </header>
      {moduleId && <nav className="course-nav" aria-label="Module navigation">
        <NavLink end to={modulePath}>Overview</NavLink>
        <NavLink to={modulePath + '/content'}>Content</NavLink>
        {session.user.role === 'LECTURER' && <NavLink to={modulePath + '/roster'}>Roster</NavLink>}
      </nav>}
      <main id="main-content" className="content" tabIndex={-1}><ErrorMessage message={action.error} />{children}</main>
    </div>
  </div>;
}

function Profile({ session }: { session: Session }) {
  return <><Heading title="Profile" /><section className="panel profile"><dl><dt>Name</dt><dd>{session.user.displayName}</dd><dt>Email</dt><dd>{session.user.email}</dd><dt>Role</dt><dd>{roleNames[session.user.role]}</dd></dl><Link className="button secondary" to="/change-password">Change password</Link></section></>;
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
    window.addEventListener('lms-session-expired', expire);
    return () => window.removeEventListener('lms-session-expired', expire);
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
  const fallback = landing(userSession);
  return <Routes>
    <Route path="/change-password" element={<AccountForm key="change" session={userSession} expired={false} setSession={update} />} />
    <Route path="*" element={<Layout session={userSession} signOut={signOut}><Routes>
      <Route path="/profile" element={<Profile session={userSession} />} />
      {userSession.user.role === 'ADMIN' ? <>
        <Route path="/admin/users" element={<AdminUsers csrf={userSession.csrfToken} />} />
        <Route path="/admin/modules" element={<AdminModules csrf={userSession.csrfToken} />} />
        <Route path="/admin/modules/:moduleId/enrolments" element={<AdminEnrolments csrf={userSession.csrfToken} />} />
        <Route path="/admin/audit" element={<AdminAudit />} />
      </> : <>
        <Route path="/modules" element={<ModuleList session={userSession} />} />
        <Route path="/modules/:moduleId" element={<ModuleDetail session={userSession} />} />
        <Route path="/modules/:moduleId/content" element={<TopicList session={userSession} />} />
        <Route path="/modules/:moduleId/content/:topicId" element={<TopicDetail session={userSession} />} />
        <Route path="/modules/:moduleId/content/:topicId/materials/:materialId" element={<MaterialDetail session={userSession} />} />
        {userSession.user.role === 'LECTURER' && <Route path="/modules/:moduleId/roster" element={<ModuleRoster />} />}
      </>}
      <Route path="*" element={<Navigate to={fallback} replace />} />
    </Routes></Layout>} />
  </Routes>;
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><App /></BrowserRouter>);
