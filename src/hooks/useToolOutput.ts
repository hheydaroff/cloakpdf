/**
 * Tool-output hook — where a tool "delivers" its result.
 *
 * Tools call `output.deliver(bytes, "_suffix", sourceFile)` exactly where they
 * would otherwise call `downloadPdf(bytes, pdfFilename(file, suffix))`. Every
 * tool runs standalone now (the chained-workflow runner was removed in favour
 * of the unified editor), so delivery is always a browser download.
 *
 * The `ToolOutput` shape is kept intact — `inWorkflow` / `isLastStep` resolve
 * to constants and `skip` is a no-op — so the ~20 tools that read these fields
 * (e.g. `` `Apply… & ${output.deliveryWord}` ``) keep compiling and behave
 * exactly as the standalone path always did.
 */

import { downloadPdf, pdfFilename } from "../utils/file-helpers.ts";

export interface ToolOutput {
  /** Always false — tools are no longer rendered as workflow steps. */
  inWorkflow: boolean;
  /** Always false — kept for the stable interface. */
  isLastStep: boolean;
  /** Always "Download" — drops straight into an action-button label. */
  deliveryWord: "Download" | "Continue";
  /** Deliver the produced PDF as a browser download named `<source>${suffix}.pdf`. */
  deliver: (bytes: Uint8Array, suffix: string, sourceFile: File) => void;
  /** No-op — the tool's own UI handles "nothing to do" messaging. */
  skip: (reason: string) => void;
}

export function useToolOutput(): ToolOutput {
  return {
    inWorkflow: false,
    isLastStep: false,
    deliveryWord: "Download",
    deliver(bytes, suffix, sourceFile) {
      downloadPdf(bytes, pdfFilename(sourceFile, suffix));
    },
    skip() {},
  };
}
