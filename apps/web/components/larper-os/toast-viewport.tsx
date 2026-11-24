"use client";

// The toast windows themselves. Loaded only when the first toast is shown (toaster.tsx),
// so motion's animation code stays out of every page's first load.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import "./toaster.css";

export type Toast = { id: number; title: string; message: string };

export default function ToastViewport({ toasts }: { toasts: Toast[] }) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {toasts.map((t) => (
        <motion.section
          key={t.id}
          className="larper-toast larper-os-window"
          initial={reduced ? false : { opacity: 0, scale: 0.94, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
          transition={{ duration: 0.16, ease: "easeOut" }}
        >
          <div className="larper-os-titlebar">
            <span className="larper-os-grille" aria-hidden="true" />
            <span>{t.title}</span>
            <span className="larper-os-grille" aria-hidden="true" />
          </div>
          <p className="larper-toast-message">{t.message}</p>
        </motion.section>
      ))}
    </AnimatePresence>
  );
}
