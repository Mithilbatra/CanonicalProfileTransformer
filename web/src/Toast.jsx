import { createContext, useCallback, useContext, useRef, useState } from 'react';

// Lightweight toast system: a provider holds a queue, useToast() pushes onto
// it, and each toast auto-dismisses. No dependencies, presentational only.

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback((message, tone = 'ok', ttl = 3200) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => dismiss(id), ttl);
  }, [dismiss]);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
            <span className="toast-mark">{t.tone === 'bad' ? '✕' : t.tone === 'info' ? 'ℹ' : '✓'}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
