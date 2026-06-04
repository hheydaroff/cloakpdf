// WholeDocPanel.tsx — Shared right-panel layout for "whole-document" tools that
// have no canvas interaction: a blurb, optional controls, and one Apply button.
// Identical in the desktop right panel and the mobile bottom sheet (it's just a
// column of controls), so these tools are mobile-clean for free. Apply is
// disabled + relabelled while a transform is running so the user can't
// double-fire it.

import type { ReactNode } from "react";
import { useEditorRead } from "../EditorContext.tsx";

interface Props {
  /** One-line explanation of what Apply does. */
  blurb: string;
  /** Optional controls (segmented options, etc.) shown above the button. */
  children?: ReactNode;
  /** Label for the primary action. */
  applyLabel: string;
  onApply: () => void;
  /** Extra caveat shown under the button (e.g. "text is rasterised"). */
  note?: string;
  /** Render the action in the destructive (red) treatment. */
  danger?: boolean;
  disabled?: boolean;
}

export function WholeDocPanel({
  blurb,
  children,
  applyLabel,
  onApply,
  note,
  danger,
  disabled,
}: Props) {
  const { busyLabel } = useEditorRead();
  const busy = busyLabel !== null;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">{blurb}</p>
      {children}
      <button
        type="button"
        onClick={onApply}
        disabled={busy || disabled}
        className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
          danger
            ? "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500"
            : "bg-primary-600 hover:bg-primary-700 focus-visible:ring-primary-500"
        }`}
      >
        {busy ? "Working…" : applyLabel}
      </button>
      {note && <p className="text-xs text-slate-400 dark:text-dark-text-muted">{note}</p>}
    </div>
  );
}

/** Compact segmented control shared by the option-bearing whole-doc tools. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; sub?: string }[];
}) {
  return (
    <div className="grid grid-flow-col gap-1 rounded-lg border border-slate-200 dark:border-dark-border p-0.5">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            className={`flex flex-col items-center rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
              on
                ? "bg-primary-600 text-white"
                : "text-slate-600 dark:text-dark-text-muted hover:bg-slate-50 dark:hover:bg-dark-surface-alt"
            }`}
          >
            {o.label}
            {o.sub && (
              <span
                className={`text-[10px] ${on ? "text-white/80" : "text-slate-400 dark:text-dark-text-muted"}`}
              >
                {o.sub}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
