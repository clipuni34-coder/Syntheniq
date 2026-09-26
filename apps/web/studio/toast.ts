// Tiny toast bus — any view can notify without prop drilling.

export interface Toast {
  id: number;
  msg: string;
  kind: 'error' | 'ok';
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn);
  fn([...toasts]);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  const snap = [...toasts];
  listeners.forEach((fn) => fn(snap));
}

export function notify(msg: string, kind: 'error' | 'ok' = 'error'): void {
  const t: Toast = { id: nextId++, msg, kind };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, 5200);
}
