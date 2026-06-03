import { Undo2 } from "lucide-react";
import type { ComponentType } from "react";

interface ResetButtonProps {
  onClick: () => void;
  label?: string;
  /** Leading glyph. Defaults to Undo2. */
  icon?: ComponentType<{ className?: string }>;
  /** Extra classes appended to the button (e.g. positioning utilities). */
  className?: string;
}

export function ResetButton({
  onClick,
  label = "Reset",
  icon: Icon = Undo2,
  className,
}: ResetButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded text-sm text-slate-500 hover:text-slate-700 dark:text-dark-text-muted dark:hover:text-dark-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500${className ? ` ${className}` : ""}`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}
