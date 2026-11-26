import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ImageUp, KeyRound, Mail, Plus, Shield, Trash2, UserRound } from 'lucide-react';
import { get, list, mutate, query, type AdminUser, type Session, type Settings } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { useBranding } from './branding.js';
import { Badge, Empty, ErrorMessage, Heading, Pagination, Resource, RowMenu, SearchField, field, statusText, submit, toast, useAction, useConfirmation, useResource } from './ui.js';

type Tab = { id: string; label: string; content: ReactNode };

export function SettingsPage({ session }: { session: Session }) {
  const admin = session.user.role === 'ADMIN';
  const [params, setParams] = useSearchParams();
  const tabs: Tab[] = [
    ...(admin ? [
      { id: 'general', label: 'General', content: <InstitutionSettings session={session} /> },
      { id: 'admissions', label: 'Admissions', content: <AdmissionSettings session={session} /> },
      { id: 'display', label: 'Display', content: <DisplaySettings session={session} /> },
      { id: 'users', label: 'Users and roles', content: <UserAccounts session={session} /> },
    ] : [{ id: 'display', label: 'Display', content: <DisplaySettings session={session} /> }]),
    { id: 'account', label: 'My account', content: <Account session={session} /> },
  ];
  const current = tabs.find(tab => tab.id === params.get('tab')) ?? tabs[0];
  return <>
    <Heading title="Settings" detail={admin ? 'Institution, admissions workflow, display and user access.' : 'Your account and display preferences.'} />
    <div className="tab-bar" role="tablist" aria-label="Settings sections">
      {tabs.map(tab => <button key={tab.id} type="button" role="tab" id={'tab-' + tab.id} aria-selected={tab === current} aria-controls={'panel-' + tab.id}
        tabIndex={tab === current ? 0 : -1} onClick={() => setParams({ tab: tab.id }, { replace: true })}>{tab.label}</button>)}
    </div>
    <div role="tabpanel" id={'panel-' + current.id} aria-labelledby={'tab-' + current.id}>{current.content}</div>
  </>;
}

/** Loads settings and saves a partial update; refreshes branding everywhere on success. */
function useSettingsForm(session: Session) {
  const state = useResource(() => get<Settings>('/settings'), 'settings');
  const action = useAction();
  const { refresh } = useBranding();
  const save = (changes: Partial<Settings>, message = 'Settings saved') => void action.run(async () => {
    await mutate('/settings', 'PATCH', changes, session.csrfToken);
    toast(message); state.reload(); refresh();
  });
  return { state, action, save };
}

function InstitutionSettings({ session }: { session: Session }) {
  const { state, action, save } = useSettingsForm(session);
  const [logoError, setLogoError] = useState('');
  return <Resource state={state}>{settings => <div className="settings-stack">
    <Card className="panel form-section"><div><h2>Institution</h2><p>Shown in the sidebar, on the sign-in page and in browser tab titles.</p></div>
      <form className="form-grid" onSubmit={submit(form => save({ institutionName: field(form, 'institutionName'), adminNumber: field(form, 'adminNumber'), defaultAcademicYear: field(form, 'defaultAcademicYear') }))}>
        <label>Institution name<Input name="institutionName" required maxLength={120} defaultValue={settings.institutionName} /></label>
        <label>Default academic year<Input name="defaultAcademicYear" required pattern="[0-9]{4}/[0-9]{4}" title="Format: 2026/2027" defaultValue={settings.defaultAcademicYear} />
          <small>Pre-selected on Analytics and Admission Intakes, and pre-filled for new intakes.</small></label>
        <label>Student admin number<Input name="adminNumber" maxLength={20} pattern="[A-Za-z0-9\-]*" defaultValue={settings.adminNumber} />
          <small>Shown in the sidebar footer and on Infrastructure Status.</small></label>
        <div className="span-2 actions"><Button disabled={action.pending}>Save</Button></div>
      </form></Card>
    <Card className="panel form-section"><div><h2>Logo</h2><p>PNG, JPEG or WebP up to 200 KB. Stored in the shared database so every server shows it.</p></div>
      <div className="logo-row">
        {settings.institutionLogo ? <img className="logo-preview" src={settings.institutionLogo} alt="Current institution logo" /> : <span className="logo-preview empty">No logo</span>}
        <label className="button secondary file-button"><ImageUp size={16} aria-hidden="true" />Upload logo
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            setLogoError('');
            if (!file) return;
            if (file.size > 200 * 1024) { setLogoError('Choose an image of 200 KB or less.'); return; }
            const reader = new FileReader();
            reader.onload = () => save({ institutionLogo: String(reader.result) }, 'Logo updated');
            reader.readAsDataURL(file);
          }} /></label>
        {settings.institutionLogo && <Button variant="outline" onClick={() => save({ institutionLogo: null }, 'Logo removed')}><Trash2 aria-hidden="true" />Remove</Button>}
      </div>
      <ErrorMessage message={logoError} /></Card>
    <ErrorMessage message={action.error} />
  </div>}</Resource>;
}

function AdmissionSettings({ session }: { session: Session }) {
  const { state, action, save } = useSettingsForm(session);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [withYear, setWithYear] = useState<boolean | null>(null);
  return <Resource state={state}>{settings => {
    const shownPrefix = prefix ?? settings.referencePrefix;
    const shownYear = withYear ?? settings.referenceIncludeYear;
    return <div className="settings-stack">
      <Card className="panel form-section"><div><h2>Review workflow</h2><p>Applied when officers issue offers, reject applications and triage the queue.</p></div>
        <form className="form-grid" onSubmit={submit(form => save({ offerResponseDays: Number(field(form, 'offerResponseDays')), reviewTargetDays: Number(field(form, 'reviewTargetDays')), requireRejectionReason: form.has('requireRejectionReason') }))}>
          <label>Default offer response window (days)<Input name="offerResponseDays" type="number" min={1} max={120} required defaultValue={settings.offerResponseDays} />
            <small>Pre-fills the response deadline when an offer is issued.</small></label>
          <label>Review target (days)<Input name="reviewTargetDays" type="number" min={1} max={90} required defaultValue={settings.reviewTargetDays} />
            <small>Submitted applications waiting longer are flagged as needing attention.</small></label>
          <label className="checkbox span-2"><input type="checkbox" name="requireRejectionReason" defaultChecked={settings.requireRejectionReason} />Require a written reason when rejecting an application</label>
          <div className="span-2 actions"><Button disabled={action.pending}>Save</Button></div>
        </form></Card>
      <Card className="panel form-section"><div><h2>Application reference numbers</h2><p>Applies to new applications only; existing references never change.</p></div>
        <form className="form-grid" onSubmit={submit(form => save({ referencePrefix: field(form, 'referencePrefix').toUpperCase(), referenceIncludeYear: form.has('referenceIncludeYear') }))}>
          <label>Prefix<Input name="referencePrefix" required pattern="[A-Za-z]{2,6}" title="2–6 letters" className="upper" defaultValue={settings.referencePrefix} onChange={event => setPrefix(event.target.value.toUpperCase())} /></label>
          <label className="checkbox"><input type="checkbox" name="referenceIncludeYear" defaultChecked={settings.referenceIncludeYear} onChange={event => setWithYear(event.target.checked)} />Include the year</label>
          <p className="field-note span-2">Example: <span className="mono">{(shownPrefix || 'ADM') + '-' + (shownYear ? new Date().getFullYear() + '-' : '') + '000123'}</span></p>
          <div className="span-2 actions"><Button disabled={action.pending}>Save</Button></div>
        </form></Card>
      <ErrorMessage message={action.error} />
    </div>;
  }}</Resource>;
}

/** Table density is a personal, per-browser preference; the date format is institution-wide. */
function DisplaySettings({ session }: { session: Session }) {
  const admin = session.user.role === 'ADMIN';
  const { settings } = useBranding();
  const { action, save } = useSettingsForm(session);
  const [density, setDensity] = useState(() => localStorage.getItem('table-density') ?? 'comfortable');
  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem('table-density', density);
  }, [density]);
  const sample = new Date();
  return <div className="settings-stack">
    {admin && <Card className="panel form-section"><div><h2>Date format</h2><p>How dates appear for everyone. Times are always Singapore time.</p></div>
      <div className="choice-list">
        {([['DAY_MONTH_YEAR', new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }).format(sample)],
          ['ISO', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(sample) + ' ' + new Intl.DateTimeFormat('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Singapore' }).format(sample)]] as const)
          .map(([value, example]) => <label key={value} className="choice"><input type="radio" name="dateFormat" checked={settings.dateFormat === value} disabled={action.pending}
            onChange={() => save({ dateFormat: value }, 'Date format updated')} /><span><strong>{value === 'ISO' ? 'ISO (year first)' : 'Day month year'}</strong><small>{example}</small></span></label>)}
      </div><ErrorMessage message={action.error} /></Card>}
    <Card className="panel form-section"><div><h2>Table density</h2><p>Saved in this browser only.</p></div>
      <div className="choice-list">
        {[['comfortable', 'Comfortable', 'More space between rows'], ['compact', 'Compact', 'Fit more rows on screen']].map(([value, label, hint]) =>
          <label key={value} className="choice"><input type="radio" name="density" checked={density === value} onChange={() => setDensity(value)} /><span><strong>{label}</strong><small>{hint}</small></span></label>)}
      </div></Card>
  </div>;
}

function Account({ session }: { session: Session }) {
  const { displayName, email, role } = session.user;
  const initials = displayName.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0] ?? '').join('').toUpperCase();
  return <div className="profile">
    <section className="panel profile-hero">
      <span className="avatar profile-avatar" aria-hidden="true">{initials}</span>
      <div><h2>{displayName}</h2><p>{email}</p><Badge>{role}</Badge></div>
    </section>
    <section className="panel">
      <h2>Account details</h2>
      <dl className="detail-list">
        <div><dt><UserRound size={16} aria-hidden="true" />Name</dt><dd>{displayName}</dd></div>
        <div><dt><Mail size={16} aria-hidden="true" />Email</dt><dd>{email}</dd></div>
        <div><dt><Shield size={16} aria-hidden="true" />Role</dt><dd>{statusText(role)}</dd></div>
      </dl>
      <p className="field-note">To change your name, email or role, ask an administrator.</p>
    </section>
    <section className="panel security">
      <div><h2><KeyRound size={17} aria-hidden="true" /> Password</h2><p>Changing your password signs you out of your other sessions.</p></div>
      <Link className="button secondary" to="/change-password">Change password</Link>
    </section>
  </div>;
}

function TemporaryPassword({ password, close }: { password: string; close: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Temporary password</DialogTitle>
        <DialogDescription>Share this password privately with the account holder. It is shown once, and they must change it at first sign-in.</DialogDescription></DialogHeader>
      <code className="temporary-password">{password}</code>
      <DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function UserAccounts({ session }: { session: Session }) {
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const action = useAction();
  const confirmation = useConfirmation();
  const path = '/users' + query({ page, q: search, role });
  const state = useResource(() => list<AdminUser>(path), path);
  const roleOptions = [['OFFICER', 'Admissions officer'], ['VIEWER', 'Read-only viewer'], ['ADMIN', 'Administrator']];
  return <>
    <div className="section-head"><div><h2>Users and roles</h2><p>Officers manage applicants and applications. Viewers can only read. Administrators also manage programmes, intakes, settings and users.</p></div>
      <Button onClick={() => { action.clear(); setCreating(true); }}><Plus aria-hidden="true" />New user</Button></div>
    {creating && <Card className="panel"><form className="form-grid" onSubmit={submit(form => void action.run(async () => {
      const created = await mutate<{ temporaryPassword: string }>('/users', 'POST', { displayName: field(form, 'displayName'), email: field(form, 'email'), role: field(form, 'role') }, session.csrfToken);
      setPassword(created.temporaryPassword); setCreating(false); toast('User created'); state.reload();
    }))}>
      <label>Display name<Input name="displayName" required maxLength={120} /></label>
      <label>Email<Input name="email" type="email" required maxLength={254} /></label>
      <label>Role<NativeSelect name="role" defaultValue="OFFICER">{roleOptions.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></label>
      <div className="span-2 actions"><Button disabled={action.pending}>Create user</Button><Button type="button" variant="outline" onClick={() => setCreating(false)}>Cancel</Button></div>
    </form></Card>}
    <ErrorMessage message={action.error} />
    <section className="directory" aria-label="User accounts">
      <div className="filters">
        <SearchField label="Search users" placeholder="Name or email" value={search} onChange={value => { setSearch(value); setPage(1); }} />
        <label>Role<NativeSelect value={role} onChange={event => { setRole(event.target.value); setPage(1); }}>
          <NativeSelectOption value="">All roles</NativeSelectOption>{roleOptions.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect></label>
      </div>
      <Resource state={state}>{result => <>
        {!result.data.length ? <Empty>No users match this search.</Empty> : <div className="table-wrap"><Table>
          <TableHeader><TableRow><TableHead scope="col">Name</TableHead><TableHead scope="col">Role</TableHead><TableHead scope="col">Status</TableHead><TableHead scope="col"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{result.data.map(user => {
            const self = user.id === session.user.id;
            return <TableRow key={user.id}>
              <TableHead scope="row"><div className="table-item"><span className="avatar person-avatar" aria-hidden="true">{user.displayName.slice(0, 1)}</span><span>{user.displayName}{self && ' (you)'}<small>{user.email}</small></span></div></TableHead>
              <TableCell>{self ? <Badge>{user.role}</Badge> : <NativeSelect aria-label={'Role for ' + user.displayName} value={user.role} disabled={action.pending}
                onChange={event => { const next = event.target.value; confirmation.ask({
                  title: 'Change ' + user.displayName + '’s role?', detail: 'They become a ' + statusText(next).toLowerCase() + '. Their current sessions end so the new permissions apply immediately.', label: 'Change role',
                  run: () => void action.run(async () => { await mutate('/users/' + user.id, 'PATCH', { role: next }, session.csrfToken); toast('Role updated'); state.reload(); }),
                }); }}>{roleOptions.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect>}</TableCell>
              <TableCell><Badge>{user.isActive ? 'ACTIVE' : 'DISABLED'}</Badge>{user.mustChangePassword && <small>Must change password</small>}</TableCell>
              <TableCell className="menu-cell">{!self && <RowMenu label={'Actions for ' + user.displayName} items={[
                { label: user.isActive ? 'Deactivate' : 'Reactivate', danger: user.isActive, onSelect: () => confirmation.ask({
                  title: (user.isActive ? 'Deactivate ' : 'Reactivate ') + user.displayName + '?', label: user.isActive ? 'Deactivate account' : 'Reactivate account', destructive: user.isActive,
                  detail: user.isActive ? 'They are signed out immediately and cannot sign in.' : 'They can sign in again.',
                  run: () => void action.run(async () => { await mutate('/users/' + user.id, 'PATCH', { isActive: !user.isActive }, session.csrfToken); toast('Account updated'); state.reload(); }),
                }) },
                { label: 'Reset password', onSelect: () => confirmation.ask({
                  title: 'Reset password for ' + user.displayName + '?', label: 'Reset password', detail: 'Their sessions end and a temporary password is generated for their next sign-in.',
                  run: () => void action.run(async () => { const reset = await mutate<{ temporaryPassword: string }>('/users/' + user.id + '/reset-password', 'POST', {}, session.csrfToken); setPassword(reset.temporaryPassword); state.reload(); }),
                }) },
              ]} />}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table></div>}
        <div className="directory-foot"><span /><Pagination page={result} onPage={setPage} /></div>
      </>}</Resource>
    </section>
    {password && <TemporaryPassword password={password} close={() => setPassword('')} />}
    {confirmation.dialog}
  </>;
}
