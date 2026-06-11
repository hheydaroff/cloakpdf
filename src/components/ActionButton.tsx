import { Download, Loader2 } from "lucide-react";

interface ActionButtonProps {
  onClick: () => void;
  processing: boolean;
  label: string;
  processingLabel: string;
  disabled?: boolean;
  color?: string;
}

export function ActionButton({
  onClick,
  processing,
  label,
  processingLabel,
  disabled,
  color = "bg-primary-600 hover:bg-primary-700",
}: ActionButtonProps) {
  // Tools whose label explicitly says "Download" (e.g. "Apply Signature &
  // Download") get a trailing download glyph; tools that show a result panel
  // first (e.g. CompressPdf) use a different label and stay icon-less.
  const showDownload = !processing && /download/i.test(label);

  return (
    <div className="pt-6 sm:flex sm:justify-center sm:pt-8">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled ?? processing}
        aria-busy={processing}
        className={`inline-flex items-center justify-center gap-1.5 w-full sm:w-auto sm:min-w-55 ${color} text-white py-3 px-5 sm:px-8 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg`}
      >
        {/* nowrap: a primary CTA must never wrap to two lines (320px guard). */}
        <span className="whitespace-nowrap">{processing ? processingLabel : label}</span>
        {processing && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
        {showDownload && <Download className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  );
}
