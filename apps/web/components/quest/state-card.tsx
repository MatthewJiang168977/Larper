import { useId, type Ref } from "react";

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
  const titleId = useId();
  return (
    <div
      ref={ref}
      aria-labelledby={titleId}
      role={role}
      data-testid="state-card"
      className="larper-quest-dock larper-quest-state"
    >
      <div className="larper-quest-titlebar" aria-hidden>
        <span className="larper-quest-grille" />
        <span>today’s quest</span>
        <span className="larper-quest-grille" />
      </div>
      <div className="px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <h2 id={titleId} className="larper-quest-state-title">{label}</h2>
        {placeholder && <PeekOutline />}
        {body && <p className="mt-1 text-ink-soft">{body}</p>}
        {action && (
          <button
            onClick={action.onClick}
            disabled={action.disabled}
            className="larper-os-button larper-os-button-primary mt-3"
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
