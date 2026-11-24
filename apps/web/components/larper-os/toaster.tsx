"use client";

// Toasts as small OS alert windows. One polite live region holds them, so a screen
// reader hears each message once without being interrupted. The windows and their motion
// (toast-viewport.tsx) load on the first toast, not with the page.
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Toast } from "./toast-viewport";
import "./toaster.css";

type Show = (message: string, title?: string) => void;

const ToastViewport = lazy(() => import("./toast-viewport"));
const TOAST_MS = 4000;
const ToastContext = createContext<Show | null>(null);

/** Shows a toast. Does nothing outside a ToastProvider (tests, isolated pages). */
export function useToast(): Show {
  return useContext(ToastContext) ?? noop;
}
const noop: Show = () => {};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [everShown, setEverShown] = useState(false);
  const next = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback<Show>((message, title = "saved") => {
    const id = ++next.current;
    setEverShown(true);
    setToasts((all) => [...all.slice(-2), { id, title, message }]);
    setTimeout(() => dismiss(id), TOAST_MS);
  }, [dismiss]);
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="larper-os larper-toasts" role="status" aria-live="polite" aria-atomic="false">
        {everShown && (
          <Suspense fallback={null}>
            <ToastViewport toasts={toasts} />
          </Suspense>
        )}
      </div>
    </ToastContext.Provider>
  );
}
