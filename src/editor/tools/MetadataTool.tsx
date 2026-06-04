// MetadataTool.tsx — Edit or scrub the document's standard metadata. Loads the
// current Info-dictionary fields when the tool opens, lets the user edit them
// (or clear them all for privacy), and writes them back via setPdfMetadata.
// Panel-only — no canvas interaction, so it's identical on desktop + mobile.

import { useEffect, useState } from "react";
import { getPdfMetadata, setPdfMetadata } from "../../utils/pdf-operations.ts";
import type { PdfMetadata } from "../../types.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead } from "../EditorContext.tsx";

const EMPTY: PdfMetadata = {
  title: "",
  author: "",
  subject: "",
  keywords: "",
  creator: "",
  producer: "",
  creationDate: "",
  modificationDate: "",
};

const TEXT_FIELDS: { key: keyof PdfMetadata; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "subject", label: "Subject" },
  { key: "keywords", label: "Keywords" },
  { key: "creator", label: "Creator" },
  { key: "producer", label: "Producer" },
];

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-dark-text-muted">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-2.5 py-1.5 text-sm text-slate-800 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      />
    </label>
  );
}

export function Panel() {
  const { doc, busyLabel } = useEditorRead();
  const { applyTransform } = useEditorActions();
  const [fields, setFields] = useState<PdfMetadata | null>(null);

  // (Re)load the current metadata whenever the document changes. The `live`
  // flag ignores a stale result — and is StrictMode-safe (a ref guard here
  // would bail on the second mount and never load).
  useEffect(() => {
    if (!doc) return;
    let live = true;
    void getPdfMetadata(docToFile(doc)).then(
      (m) => {
        if (live) setFields(m);
      },
      () => {
        if (live) setFields({ ...EMPTY });
      },
    );
    return () => {
      live = false;
    };
  }, [doc]);

  if (!fields) {
    return <p className="text-sm text-slate-400 dark:text-dark-text-muted">Reading metadata…</p>;
  }

  const set = (key: keyof PdfMetadata, value: string) => setFields({ ...fields, [key]: value });
  const busy = busyLabel !== null;

  const apply = () =>
    void applyTransform(async (d) => ({
      bytes: await setPdfMetadata(docToFile(d), fields),
      label: "Edit metadata",
    }));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">
        Edit the document properties, or clear them all to strip identifying metadata.
      </p>
      {TEXT_FIELDS.map((f) => (
        <Field key={f.key} label={f.label} value={fields[f.key]} onChange={(v) => set(f.key, v)} />
      ))}
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Created"
          type="datetime-local"
          value={fields.creationDate}
          onChange={(v) => set("creationDate", v)}
        />
        <Field
          label="Modified"
          type="datetime-local"
          value={fields.modificationDate}
          onChange={(v) => set("modificationDate", v)}
        />
      </div>

      <div className="mt-1 flex flex-col gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40"
        >
          {busy ? "Working…" : "Save metadata"}
        </button>
        <button
          type="button"
          onClick={() => setFields({ ...EMPTY })}
          className="text-xs text-slate-500 hover:text-red-600 dark:text-dark-text-muted"
        >
          Clear all fields
        </button>
      </div>
    </div>
  );
}
