// controls.tsx — Small shared form controls for the option-bearing overlay
// tools (page numbers, header/footer, bates, watermark). Designed to read well
// in the narrow right panel AND the mobile bottom sheet: large tap targets,
// one accent, no cramped rows.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const PRESET_COLORS: { name: string; rgb: Rgb }[] = [
  { name: "Black", rgb: { r: 30, g: 41, b: 59 } },
  { name: "Grey", rgb: { r: 100, g: 116, b: 139 } },
  { name: "Blue", rgb: { r: 29, g: 78, b: 216 } },
  { name: "Red", rgb: { r: 220, g: 38, b: 38 } },
];

const sameColor = (a: Rgb, b: Rgb) => a.r === b.r && a.g === b.g && a.b === b.b;

export function ColorRow({ value, onChange }: { value: Rgb; onChange: (c: Rgb) => void }) {
  return (
    <Labeled label="Colour">
      <div className="flex gap-2">
        {PRESET_COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            onClick={() => onChange(c.rgb)}
            aria-label={c.name}
            aria-pressed={sameColor(value, c.rgb)}
            className={`h-7 w-7 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${
              sameColor(value, c.rgb)
                ? "scale-110 border-slate-800 dark:border-white"
                : "border-transparent"
            }`}
            style={{ backgroundColor: `rgb(${c.rgb.r}, ${c.rgb.g}, ${c.rgb.b})` }}
          />
        ))}
      </div>
    </Labeled>
  );
}

// 3 columns × 2 rows — the cells map spatially to the page corners, so the
// layout itself communicates the position.
const POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export function PositionGrid<T extends string>({
  value,
  onChange,
}: {
  value: T;
  onChange: (p: T) => void;
}) {
  return (
    <Labeled label="Position">
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-200 dark:border-dark-border p-1">
        {POSITIONS.map((pos) => {
          const on = value === (pos as string);
          return (
            <button
              key={pos}
              type="button"
              onClick={() => onChange(pos as T)}
              aria-label={pos.replace("-", " ")}
              aria-pressed={on}
              className={`flex h-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                on
                  ? "bg-primary-600"
                  : "bg-slate-100 dark:bg-dark-bg hover:bg-slate-200 dark:hover:bg-dark-surface-alt"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${on ? "bg-white" : "bg-slate-400 dark:bg-dark-text-muted"}`}
              />
            </button>
          );
        })}
      </div>
    </Labeled>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-slate-500 dark:text-dark-text-muted">
        <span>{label}</span>
        <span className="tabular-nums text-slate-700 dark:text-dark-text">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary-600"
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Labeled label={label}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-2.5 py-1.5 text-sm text-slate-800 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      />
    </Labeled>
  );
}

export function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-[0.12em] text-slate-400 dark:text-dark-text-muted">
        {label}
      </p>
      {children}
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-dark-text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-primary-600 focus-visible:ring-primary-500"
      />
      {label}
    </label>
  );
}
