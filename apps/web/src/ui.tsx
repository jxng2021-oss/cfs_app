import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
  if (state.pending) return <p className="notice" role="status">Loading…</p>;
  if (state.error) return <div className="notice" role="alert"><p>{state.error}</p><button className="secondary" onClick={state.reload}>Retry</button></div>;
  return state.value === undefined ? null : children(state.value);
}

export function Heading({ title, detail, action, parent }: { title: string; detail?: string; action?: ReactNode; parent?: { to: string; label: string } }) {
  return <header className="page-heading">
    <div>{parent && <Link className="back" to={parent.to}>← {parent.label}</Link>}<h1>{title}</h1>{detail && <p>{detail}</p>}</div>{action}
  </header>;
}

export function Badge({ children }: { children: string }) {
  return <span className={'badge ' + children.toLowerCase()}>{children[0] + children.slice(1).toLowerCase()}</span>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="notice">{children}</div>; }

export function Pagination<T>({ page, onPage }: { page: Page<T>; onPage: (value: number) => void }) {
  if (page.pagination.totalPages <= 1 && page.pagination.page === 1) return null;
  const { page: current, totalPages } = page.pagination;
  return <div className="pagination"><button className="secondary" disabled={current <= 1} onClick={() => onPage(current - 1)}>Previous</button>
    <span>Page {current} of {Math.max(1, totalPages)}</span><button className="secondary" disabled={current >= totalPages} onClick={() => onPage(current + 1)}>Next</button></div>;
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
