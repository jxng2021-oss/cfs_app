import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DropdownMenu } from 'radix-ui';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, MoreHorizontal, Search, X } from 'lucide-react';
import { Badge as StatusBadge } from './components/ui/badge.js';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from './components/ui/alert-dialog.js';
import type { Page, PublicSettings, Qualification } from './api.js';

export function useResource<T>(load: () => Promise<T>, key: string) {
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<{ key: string; revision: number; value?: T; error: string }>();
  const reload = useCallback(() => setRevision(count => count + 1), []);
  useEffect(() => {
    let current = true;
    load().then(result => { if (current) setSettled({ key, revision, value: result, error: '' }); })
      .catch(error => { if (current) setSettled({ key, revision, error: error instanceof Error ? error.message : 'Something went wrong.' }); });
    return () => { current = false; };
    // The key identifies every input needed by load.
  }, [key, revision]);
  const result = settled?.key === key && settled.revision === revision ? settled : undefined;
  return { value: result?.value, error: result?.error ?? '', pending: !result, reload };
}

export function Resource<T>({ state, children }: { state: ReturnType<typeof useResource<T>>; children: (data: T) => ReactNode }) {
  if (state.pending) return <p className="notice" role="status"><span className="loading-dot" aria-hidden="true" />Loading…</p>;
  if (state.error) return <div className="notice" role="alert"><CircleAlert size={17} aria-hidden="true" /><div><p>{state.error}</p><Button variant="outline" onClick={state.reload}>Retry</Button></div></div>;
  return state.value === undefined ? null : children(state.value);
}

export function Heading({ title, detail, action, parent }: { title: string; detail?: ReactNode; action?: ReactNode; parent?: { to: string; label: string } }) {
  return <header className="page-heading">
    <div>{parent && <Link className="back" to={parent.to}><ArrowLeft size={15} aria-hidden="true" />{parent.label}</Link>}<h1>{title}</h1>{detail && <p>{detail}</p>}</div>
    {action && <div className="actions">{action}</div>}
  </header>;
}

// ---- Status vocabulary -------------------------------------------------------------------------------
type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const tones: Record<string, Tone> = {
  // Applications
  DRAFT: 'neutral', SUBMITTED: 'info', UNDER_REVIEW: 'warning', INFO_REQUIRED: 'warning', WAITLISTED: 'warning',
  OFFER_ISSUED: 'success', OFFER_ACCEPTED: 'success', ENROLLED: 'success', OFFER_DECLINED: 'neutral', REJECTED: 'danger', WITHDRAWN: 'neutral',
  // Intakes, programmes, applicants and accounts
  UPCOMING: 'info', OPEN: 'success', CLOSED: 'danger', COMPLETED: 'neutral', CANCELLED: 'danger',
  ACTIVE: 'success', INACTIVE: 'warning', ARCHIVED: 'neutral', ON_HOLD: 'warning', DISABLED: 'danger',
  ADMIN: 'info', OFFICER: 'info', VIEWER: 'info',
};
const labels: Record<string, string> = {
  INFO_REQUIRED: 'Info required', OFFER_ISSUED: 'Offer issued', OFFER_ACCEPTED: 'Offer accepted', OFFER_DECLINED: 'Offer declined',
  UNDER_REVIEW: 'Under review', ON_HOLD: 'On hold', ADMIN: 'Administrator', OFFICER: 'Admissions officer', VIEWER: 'Read-only viewer',
};
/** Status colour: green = positive/open, amber = in progress or needs action, red = closed/negative, blue = informational. */
export function tone(value: string): Tone { return tones[value.toUpperCase()] ?? 'neutral'; }
export function statusText(value: string) { return labels[value] ?? value[0] + value.slice(1).toLowerCase().replaceAll('_', ' '); }

export function Badge({ children }: { children: string }) {
  return <StatusBadge variant="outline" data-tone={tone(children)} className="badge"><span className="badge-dot" aria-hidden="true" />{statusText(children)}</StatusBadge>;
}

export const qualificationNames: Record<Qualification, string> = {
  SECONDARY: 'Secondary', PRE_UNIVERSITY: 'Pre-university', DIPLOMA: 'Diploma', BACHELOR: "Bachelor's", MASTER: "Master's", DOCTORATE: 'Doctorate',
};
export const qualificationOptions = Object.entries(qualificationNames) as [Qualification, string][];
export const qualificationTypeNames: Record<string, string> = { CERTIFICATE: 'Certificate', DIPLOMA: 'Diploma', BACHELOR: "Bachelor's degree", MASTER: "Master's degree", DOCTORATE: 'Doctorate' };
export const applicationStatusOrder = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'WAITLISTED', 'OFFER_ISSUED', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'REJECTED', 'WITHDRAWN', 'ENROLLED'] as const;

export function Empty({ children }: { children: ReactNode }) { return <div className="notice">{children}</div>; }

export function SearchField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="filter-search">{label}<span className="search-input"><Search size={16} aria-hidden="true" />
    <Input type="search" value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
  </span></label>;
}

export function Pagination<T>({ page, onPage }: { page: Page<T>; onPage: (value: number) => void }) {
  const { page: current, totalPages, total } = page.pagination;
  if (totalPages <= 1 && current === 1) return total ? <div className="pagination"><span>{total} result{total === 1 ? '' : 's'}</span></div> : null;
  return <div className="pagination"><span>{total} results</span><Button variant="outline" disabled={current <= 1} onClick={() => onPage(current - 1)}><ChevronLeft aria-hidden="true" />Previous</Button>
    <span>Page {current} of {Math.max(1, totalPages)}</span><Button variant="outline" disabled={current >= totalPages} onClick={() => onPage(current + 1)}>Next<ChevronRight aria-hidden="true" /></Button></div>;
}

/** Clickable column header that toggles sort direction and announces it with aria-sort. */
export function SortHeader<K extends string>({ label, column, sort, onSort }: { label: string; column: K; sort: { key: K; dir: 'asc' | 'desc' }; onSort: (key: K, dir: 'asc' | 'desc') => void }) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} data-slot="table-head">
    <button type="button" data-slot="sort" className="sort-button" onClick={() => onSort(column, active && sort.dir === 'asc' ? 'desc' : 'asc')}>
      {label}<Icon size={13} aria-hidden="true" />
    </button>
  </th>;
}

/** Row-level action menu ("…"). Items with `danger` render in red. */
export function RowMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void; danger?: boolean; hidden?: boolean }[] }) {
  const shown = items.filter(item => !item.hidden);
  if (!shown.length) return null;
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><Button variant="ghost" size="icon" className="row-menu-trigger" aria-label={label}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
        {shown.map(item => <DropdownMenu.Item key={item.label} className="menu-item" data-danger={item.danger || undefined} onSelect={item.onSelect}>{item.label}</DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

export function submit(run: (body: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(new FormData(event.currentTarget));
  };
}
export const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
export function ErrorMessage({ message }: { message: string }) { return message ? <p role="alert" className="error">{message}</p> : null; }

// ---- Dates (always Singapore time; format follows the institution setting) -------------------------------
let dateStyle: PublicSettings['dateFormat'] = 'DAY_MONTH_YEAR';
export function setDateStyle(style: PublicSettings['dateFormat']) { dateStyle = style; }
const parts = (value: string | Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', ...options }).format(new Date(value));
const isoDate = (value: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(value));
export function dateTime(value: string | Date) {
  return dateStyle === 'ISO' ? isoDate(value) + ' ' + parts(value, { hour: '2-digit', minute: '2-digit', hour12: false }) : parts(value, { dateStyle: 'medium', timeStyle: 'short' });
}
export function dateOnly(value: string | Date) {
  return dateStyle === 'ISO' ? isoDate(value) : parts(value, { day: 'numeric', month: 'short', year: 'numeric' });
}
/** A calendar date (YYYY-MM-DD) with no time zone shift. */
export function calendarDate(value: string | null | undefined) {
  if (!value) return '—';
  return dateStyle === 'ISO' ? value : new Intl.DateTimeFormat('en-SG', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value + 'T00:00:00Z'));
}
export function timeOnly(value: string) { return parts(value, { timeStyle: 'short' }); }
/** "in 3 days", "2 hours ago". */
export function relative(value: string | Date, now = Date.now()) {
  const minutes = Math.round((new Date(value).getTime() - now) / 60000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  if (Math.abs(minutes) < 60 * 24) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / (60 * 24)), 'day');
}
/** Value for <input type="datetime-local"> in Singapore time. */
export function localInput(value: string | undefined) {
  if (!value) return '';
  return new Date(new Date(value).getTime() + 8 * 3_600_000).toISOString().slice(0, 16);
}
/** ISO timestamp from a datetime-local value entered in Singapore time. */
export function fromLocalInput(value: string) { return value ? value + ':00+08:00' : ''; }
export const percent = (value: number | null | undefined) => value === null || value === undefined ? '—' : value.toFixed(value % 1 === 0 ? 0 : 1) + '%';

// ---- Actions, confirmations and toasts --------------------------------------------------------------
export function useAction() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function run(action: () => Promise<void>) {
    setError('');
    setPending(true);
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : 'The request failed.'); }
    finally { setPending(false); }
  }
  return { error, pending, run, clear: () => setError('') };
}

type Confirmation = {
  title: string; detail: string; label: string; destructive?: boolean;
  reason?: { label: string; required: boolean; placeholder?: string };
  extra?: ReactNode;
  run: (reason: string) => void;
};

export function useConfirmation() {
  const [pending, setPending] = useState<(Confirmation & { returnFocus: HTMLElement | null }) | null>(null);
  const [reason, setReason] = useState('');
  function ask(confirmation: Confirmation) {
    setReason('');
    setPending({ ...confirmation, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }
  function close() {
    if (!pending) return;
    const target = pending.returnFocus;
    setPending(null);
    requestAnimationFrame(() => { if (target?.isConnected) target.focus(); });
  }
  const blocked = Boolean(pending?.reason?.required && !reason.trim());
  const dialog = pending && <AlertDialog open onOpenChange={open => { if (!open) close(); }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{pending.title}</AlertDialogTitle><AlertDialogDescription>{pending.detail}</AlertDialogDescription></AlertDialogHeader>
      {pending.extra}
      {pending.reason && <label className="dialog-field">{pending.reason.label}{pending.reason.required ? '' : ' (optional)'}
        <Textarea value={reason} maxLength={1000} rows={3} placeholder={pending.reason.placeholder} onChange={event => setReason(event.target.value)} /></label>}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={pending.destructive ? 'destructive' : 'default'} disabled={blocked} onClick={() => pending.run(reason.trim())}>{pending.label}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
  return { ask, dialog };
}

type Toast = { id: number; message: string };
const toastEvent = 'app-toast';
/** Brief success message shown at the bottom of the screen. */
export function toast(message: string) { window.dispatchEvent(new CustomEvent(toastEvent, { detail: message })); }
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let next = 0;
    const show = (event: Event) => {
      const item = { id: next += 1, message: String((event as CustomEvent).detail) };
      setItems(current => [...current.slice(-2), item]);
      setTimeout(() => setItems(current => current.filter(entry => entry.id !== item.id)), 4000);
    };
    window.addEventListener(toastEvent, show);
    return () => window.removeEventListener(toastEvent, show);
  }, []);
  return <div className="toasts" role="status" aria-live="polite">
    {items.map(item => <div key={item.id} className="toast"><CheckCircle2 size={17} aria-hidden="true" /><span>{item.message}</span>
      <button type="button" data-slot="toast-close" aria-label="Dismiss" onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}><X size={15} aria-hidden="true" /></button></div>)}
  </div>;
}

/** Summary tile: a label, a value and an optional hint, with an icon. */
export function Metric({ label, value, hint, icon: Icon, tone: toneName, to }: { label: string; value: ReactNode; hint?: string; icon: typeof Search; tone?: Tone; to?: string }) {
  const body = <><span className="metric-icon" data-tone={toneName} aria-hidden="true"><Icon size={18} /></span>
    <span><span className="metric-label">{label}</span><span className="metric-value">{value}</span>{hint && <small>{hint}</small>}</span></>;
  return to ? <Link className="metric metric-link" to={to}>{body}</Link> : <div className="metric">{body}</div>;
}

/** Labelled value pairs for detail pages. */
export function Details({ items }: { items: [string, ReactNode][] }) {
  return <dl className="detail-list">{items.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value || '—'}</dd></div>)}</dl>;
}
