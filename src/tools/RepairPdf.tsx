/**
 * Repair PDF tool.
 *
 * Re-loads a PDF through pdf-lib with lenient parsing (throwOnInvalidObject:false)
 * and re-saves it. This rebuilds the cross-reference table, removes redundant or
 * corrupt objects, and produces a structurally clean file without touching the
 * visible content.
 */

import { CheckCircle2 } from "lucide-react";
import { useCallback, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { InfoCallout } from "../components/InfoCallout.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { useToolOutput } from "../hooks/useToolOutput.ts";
import { formatFileSize } from "../utils/file-helpers.ts";
import { repairPdf } from "../utils/pdf-operations.ts";

export default function RepairPdf() {
  const [sizeAfter, setSizeAfter] = useState(0);
  const [done, setDone] = useState(false);

  const pdf = usePdfFile({
    onReset: () => {
      setSizeAfter(0);
      setDone(false);
    },
  });
  const task = useAsyncProcess();
  const output = useToolOutput();

  const handleRepair = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    setDone(false);
    const ok = await task.run(async () => {
      const result = await repairPdf(file);
      setSizeAfter(result.byteLength);
      output.deliver(result, "_repaired", file);
    }, "Failed to repair PDF. The file may be severely corrupted.");
    if (ok) setDone(true);
  }, [pdf.file, task, output]);

  return (
    <div className="space-y-6">
      <FileDropZone
        glowColor={categoryGlow.transform}
        iconColor={categoryAccent.transform}
        accept=".pdf,application/pdf"
        onFiles={pdf.onFiles}
        encryptedFile={pdf.encryptedFile}
        onClearEncrypted={pdf.reset}
        label="Drop a PDF file here"
        hint="Re-save the PDF through pdf-lib to fix structural issues"
      />

      {pdf.file && (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={formatFileSize(pdf.file.size)}
            onChangeFile={pdf.reset}
          />

          <ActionButton
            onClick={handleRepair}
            processing={task.processing}
            label={`Repair & ${output.deliveryWord} PDF`}
            processingLabel="Repairing…"
          />

          {task.processing && (
            <p
              role="status"
              aria-live="polite"
              className="text-center text-xs text-slate-500 dark:text-dark-text-muted"
            >
              Rebuilding the document — this can take a few seconds on large or damaged files, and
              the page may briefly freeze.
            </p>
          )}

          {done && (
            <InfoCallout icon={CheckCircle2} accent="transform">
              {output.inWorkflow && !output.isLastStep
                ? `PDF repaired successfully${sizeAfter > 0 ? ` — ${formatFileSize(sizeAfter)}` : ""}. Passed to the next step.`
                : `PDF repaired successfully${sizeAfter > 0 ? ` — ${formatFileSize(sizeAfter)}` : ""}. The file has been downloaded.`}
            </InfoCallout>
          )}
        </>
      )}

      {(pdf.loadError || task.error) && <AlertBox message={pdf.loadError ?? task.error ?? ""} />}
    </div>
  );
}
