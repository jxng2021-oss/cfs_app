import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, get, mutate, type Session } from './api.js';
import { AdminAudit, AdminEnrolments, AdminModules, AdminUsers } from './admin.js';
import { ModuleDetail, ModuleList, ModuleRoster } from './modules.js';
import { MaterialDetail, TopicDetail, TopicList } from './learning.js';
import { ErrorMessage, Heading, Resource, field, submit, useAction, useResource } from './ui.js';
import './styles.css';

const roleNames = { ADMIN: 'Administrator', LECTURER: 'Lecturer', STUDENT: 'Student' };
const landing = (session: Session) => session.user.role === 'ADMIN' ? '/admin/modules' : '/modules';

function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true">m.</span><span>Mini LMS</span></div>;
}

function AccountForm({ session, setSession, expired, signOut }: { session?: Session; setSession: (session: Session) => void; expired: boolean; signOut?: () => Promise<void> }) {
  const action = useAction();
  const navigate = useNavigate();
  const changing = Boolean(session);
  return <main className="auth-layout">
    <section className="auth-panel">
      <Brand />
      <div className="auth-copy">
        <h1>{changing ? 'Change your password' : 'Sign in'}</h1>
        <p>{expired ? 'Your session expired. Sign in again to continue.' : session?.mustChangePassword ? 'Choose a new password to access your learning workspace.' : changing ? 'Use at least 12 characters.' : 'Access your modules, learning materials and assessments.'}</p>
      </div>
      <form className="stack" onSubmit={submit(form => void action.run(async () => {
        const updated = changing
          ? await mutate<Session>('/auth/change-password', 'POST', { currentPassword: field(form, 'currentPassword'), newPassword: field(form, 'newPassword') }, session?.csrfToken)
          : await mutate<Session>('/auth/login', 'POST', { email: field(form, 'email'), password: field(form, 'password') });
        setSession(updated);
        navigate(updated.mustChangePassword ? '/change-password' : landing(updated), { replace: true });
      }))}>
        {changing ? <>
          <label>Current password<input type="password" name="currentPassword" autoComplete="current-password" required /></label>
          <label>New password<input type="password" name="newPassword" autoComplete="new-password" minLength={12} required /></label>
        </> : <>
          <label>Email<input type="email" name="email" autoComplete="username" required /></label>
          <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
        </>}
        <ErrorMessage message={action.error} />
        <button disabled={action.pending}>{action.pending ? 'Please wait…' : changing ? 'Change password' : 'Sign in'}</button>
        {session && !session.mustChangePassword && <Link to="/profile" className="back">Back to profile</Link>}
        {signOut && <button type="button" className="secondary" disabled={action.pending} onClick={() => void action.run(signOut)}>Sign out</button>}
      </form>
    </section>
    <div className="auth-art" aria-hidden="true"><div className="art-ring"/><div className="art-ring ring-two"/><div className="art-ring ring-three"/><div className="art-dot"/></div>
  </main>;
}

function Layout({ session, children, signOut }: { session: Session; children: ReactNode; signOut: () => Promise<void> }) {
  const action = useAction();
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="shell">
    <a href="#main-content" className="skip">Skip to content</a>
    <aside className="sidebar">
      <div className="sidebar-header">
        <Link to={landing(session)} aria-label="Mini LMS home"><Brand /></Link>
        <button className="secondary mobile-menu" aria-controls="main-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>Menu</button>
      </div>
      <nav id="main-navigation" className={menuOpen ? 'open' : undefined} aria-label="Main navigation" onClick={event => {
        if (event.target instanceof Element && event.target.closest('a')) setMenuOpen(false);
      }}>
        {session.user.role === 'ADMIN' ? <>
          <NavLink to="/admin/modules">Modules</NavLink><NavLink to="/admin/users">User accounts</NavLink><NavLink to="/admin/audit">Audit log</NavLink>
        </> : <NavLink to="/modules">My modules</NavLink>}
        <NavLink to="/profile">Profile</NavLink>
      </nav>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="identity"><span className="avatar" aria-hidden="true">{session.user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{session.user.displayName}</strong><span>{roleNames[session.user.role]}</span></div></div>
        <button className="secondary" disabled={action.pending} onClick={() => void action.run(signOut)}>Sign out</button></header>
      <main id="main-content" className="content"><ErrorMessage message={action.error} />{children}</main>
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
