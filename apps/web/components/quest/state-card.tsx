import type { Ref } from "react";

export interface StateAction {
  text: string;
  onClick: () => void;
  disabled?: boolean;
}

interface StateCardProps {
  /** The field label on top: what this state is. */
  label: string;
  body?: string;
  /** "alert" for a failure, "status" for the rest (loading, surveying, nothing here). */
  role: "alert" | "status";
  action?: StateAction;
  /** While loading: an outline of the peek where the quest will be. */
  placeholder?: boolean;
  ref?: Ref<HTMLDivElement>;
}

// The bottom card for every state that isn't a quest: loading, errors, surveying, nothing
// nearby, outside the area. The quest sheet's shell (handle, border, shadow, width), so
// the quest takes its place without the bottom of the screen changing shape. The handle
// is drawn only: there's nothing to expand.
export function StateCard({ label, body, role, action, placeholder, ref }: StateCardProps) {
  return (
    <div
      ref={ref}
      role={role}
      data-testid="state-card"
      className="absolute inset-x-0 bottom-0 z-10 mx-auto flex max-w-xl flex-col rounded-t-2xl border-x border-t border-paper-edge bg-paper shadow-[0_-6px_24px_color-mix(in_srgb,var(--ink)_12%,transparent)] lg:w-[60vw] lg:max-w-[960px]"
    >
      <div aria-hidden className="flex h-11 shrink-0 items-center justify-center">
        <span className="h-1 w-10 rounded-full bg-rule" />
      </div>
      <div className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <p className="field-label">{label}</p>
        {placeholder && <PeekOutline />}
        {body && <p className="mt-1 text-ink-soft">{body}</p>}
        {action && (
          <button
            onClick={action.onClick}
            disabled={action.disabled}
            className="stamp-btn mt-3 min-h-11 rounded-md bg-oxblood px-4 py-2 text-paper disabled:opacity-50"
          >
            {action.text}
          </button>
        )}
      </div>
    </div>
  );
}

// The peek's shape, in faint rules: the place's name, then its distance beside the action.
function PeekOutline() {
  return (
    <div aria-hidden data-testid="peek-outline" className="motion-safe:animate-pulse">
      <div className="mt-2 h-7 w-3/4 rounded bg-rule/50" />
      <div className="mt-2 flex items-center gap-3">
        <div className="h-4 flex-1 rounded bg-rule/40" />
        <div className="h-11 w-24 shrink-0 rounded-md border-2 border-dashed border-rule" />
      </div>
    </div>
  );
}
