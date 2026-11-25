import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, CircleAlert, Search } from 'lucide-react';
import { Badge as StatusBadge } from './components/ui/badge.js';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from './components/ui/alert-dialog.js';
import type { Page } from './api.js';

export function useResource<T>(load: () => Promise<T>, key: string) {
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<T>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let current = true;
    setPending(true);
    setError('');
    load().then(result => { if (current) setValue(result); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : 'Something went wrong.'); })
      .finally(() => { if (current) setPending(false); });
    return () => { current = false; };
    // The key identifies every input needed by load.
  }, [key, revision]);
  return { value, error, pending, reload: () => setRevision(count => count + 1) };
}

export function Resource<T>({ state, children }: { state: ReturnType<typeof useResource<T>>; children: (data: T) => ReactNode }) {
  if (state.pending) return <p className="notice" role="status"><span className="loading-dot" aria-hidden="true"/>Loading…</p>;
  if (state.error) return <div className="notice" role="alert"><CircleAlert size={17} aria-hidden="true"/><div><p>{state.error}</p><Button variant="outline" onClick={state.reload}>Retry</Button></div></div>;
  return state.value === undefined ? null : children(state.value);
}

export function Heading({ title, detail, action, parent }: { title: string; detail?: string; action?: ReactNode; parent?: { to: string; label: string } }) {
  return <header className="page-heading">
    <div>{parent && <Link className="back" to={parent.to}><ArrowLeft size={15} aria-hidden="true"/>{parent.label}</Link>}<h1>{title}</h1>{detail && <p>{detail}</p>}</div>{action}
  </header>;
}

export function Badge({ children }: { children: string }) {
  return <StatusBadge variant="outline" className={'badge ' + children.toLowerCase()}><span className="badge-dot" aria-hidden="true"/>{children[0] + children.slice(1).toLowerCase().replaceAll('_', ' ')}</StatusBadge>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="notice">{children}</div>; }

export function SearchField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="filter-search">{label}<span className="search-input"><Search size={16} aria-hidden="true"/>
    <Input type="search" value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
  </span></label>;
}

export function Pagination<T>({ page, onPage }: { page: Page<T>; onPage: (value: number) => void }) {
  if (page.pagination.totalPages <= 1 && page.pagination.page === 1) return null;
  const { page: current, totalPages } = page.pagination;
  return <div className="pagination"><Button variant="outline" disabled={current <= 1} onClick={() => onPage(current - 1)}><ChevronLeft aria-hidden="true"/>Previous</Button>
    <span>Page {current} of {Math.max(1, totalPages)}</span><Button variant="outline" disabled={current >= totalPages} onClick={() => onPage(current + 1)}>Next<ChevronRight aria-hidden="true"/></Button></div>;
}

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

type Confirmation = { title: string; detail: string; label: string; destructive?: boolean; run: () => void };

export function useConfirmation() {
  const [pending, setPending] = useState<(Confirmation & { returnFocus: HTMLElement | null }) | null>(null);
  function ask(confirmation: Confirmation) {
    setPending({ ...confirmation, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }
  function close() {
    if (!pending) return;
    const target = pending.returnFocus;
    setPending(null);
    requestAnimationFrame(() => { if (target?.isConnected) target.focus(); });
  }
  const dialog = pending && <AlertDialog open onOpenChange={open => { if (!open) close(); }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{pending.title}</AlertDialogTitle><AlertDialogDescription>{pending.detail}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={pending.destructive ? 'destructive' : 'default'} onClick={pending.run}>{pending.label}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
  return { ask, dialog };
}

export function submit(run: (body: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(new FormData(event.currentTarget));
  };
}
export const field = (form: FormData, name: string) => String(form.get(name) ?? '');
export function ErrorMessage({ message }: { message: string }) { return message ? <p role="alert" className="error">{message}</p> : null; }
export function dateTime(value: string) {
  return new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' }).format(new Date(value)) + ' SGT';
}
