/**
 * Shared chat-tier lifecycle for every AI tool that runs on the chat
 * model (Ask PDF, Summarize, Detect PII).
 *
 * There is currently a single tier (Qwen 2.5 1.5B), so the hook
 * auto-selects it on first use — consumers don't need to render a
 * picker. The public surface is kept tier-aware so a second tier can
 * be reintroduced without rewiring callers:
 *
 *   - `tier` is the active id (always non-null today).
 *   - `ai` is the `useAiModel` state for that tier — consent dialog,
 *     download progress, ready pipeline.
 *   - `change()` cancels any in-flight load and (with a second tier
 *     re-introduced) would reset `tier` to `null` so the picker
 *     reappears. With only one tier it's effectively a no-op the
 *     `ActiveModelBar` reflects by hiding the "Change model" button.
 *
 * The picker/gate/bar components are still in the codebase
 * unchanged; we just don't render the picker step today.
 */
import { useCallback } from "react";
import type { ChatModelId } from "../utils/ai-models.ts";
import { clearChatModelPreference, setChatModelPreference } from "../utils/ai-runtime.ts";
import { useAiModel, type UseAiModelReturn } from "./useAiModel.ts";

/**
 * The one tier we currently consider production-ready. Re-introduce a
 * union here (and add a registry entry) to bring tier selection back.
 */
const DEFAULT_TIER: ChatModelId = "chat-large";

export interface UseChatTierReturn {
  /** Active tier id. Currently always set to {@link DEFAULT_TIER}. */
  tier: ChatModelId;
  /** `useAiModel` state for the active tier. */
  ai: UseAiModelReturn;
  /**
   * Set the active tier and persist the choice. Today this is a no-op
   * because there's only one tier; kept on the return type so callers
   * don't break when a second tier is reintroduced.
   */
  pick: (tier: ChatModelId) => void;
  /**
   * Cancel any in-flight model load and clear the saved preference.
   * Callers should clear their tool-local state (chat history, etc.)
   * in their own handler — the hook only manages the model side.
   */
  change: () => void;
}

export function useChatTier(): UseChatTierReturn {
  // Always bind to the single working tier. We don't read the saved
  // preference because old values may point at `chat-small` (removed
  // due to LM-head collapse in its ONNX export). Auto-selecting here
  // also means brand-new visitors skip the picker step entirely.
  const ai = useAiModel(DEFAULT_TIER);

  const pick = useCallback((next: ChatModelId) => {
    // Persist for symmetry with the legacy picker flow. Harmless
    // today; useful again once a second tier exists.
    setChatModelPreference(next);
  }, []);

  const change = useCallback(() => {
    // Cancel any in-flight download (rejects pending consumers with
    // `cancelled`) and forget the saved preference. With one tier
    // available the user lands on the same tier next time, but
    // pending callers see a clean cancellation instead of a silent
    // resolution against the old pipeline.
    ai.cancel();
    clearChatModelPreference();
  }, [ai]);

  return { tier: DEFAULT_TIER, ai, pick, change };
}
