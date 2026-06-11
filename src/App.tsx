/**
 * Root application module.
 *
 * Manages which view is active (home / tool / editor / privacy) and delegates
 * rendering to the matching child component. The home page is editor-first:
 * dropping a PDF opens the unified editor; only multi-input + special tools
 * remain as standalone cards.
 *
 * Tool metadata and lazy components live in `config/tool-registry.ts`.
 */

import {
  Code2,
  Cpu,
  GitFork,
  Lock,
  MonitorSmartphone,
  Rocket,
  LayoutGrid,
  Search,
  ShieldCheck,
  UserRoundCheck,
  WifiOff,
  EyeOff,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDropZone } from "./components/FileDropZone.tsx";
import { Layout } from "./components/Layout.tsx";
import { useRevealOnScroll } from "./hooks/useRevealOnScroll.ts";
import { OrientationLock } from "./components/OrientationLock.tsx";
import { PrivacyPolicy } from "./components/PrivacyPolicy.tsx";
import { ReloadPrompt } from "./components/ReloadPrompt.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { categoryAccent, categoryGlow } from "./config/theme.ts";
import {
  categories,
  findTool,
  findToolComponent,
  HOME_CARD_TOOLS,
  tools,
  type ToolId,
} from "./config/tool-registry.ts";
// Plain id set (no editor component graph) — safe on the home critical path.
import { EDITOR_TOOL_IDS } from "./editor/tools.ts";
import type { Tool } from "./types.ts";
import { isMobileDevice } from "./utils/device-memory.ts";
import { NAVIGATE_TOOL_EVENT, OPEN_EDITOR_EVENT } from "./utils/nav.ts";
// The canvas editor is the primary single-PDF surface (editor-first redesign).
// Lazy-loaded so its pdf-lib / PDF.js graph stays off the home critical path,
// and rendered full-screen outside <Layout> (it owns its own chrome).
const EditorView = lazy(() => import("./editor/EditorView.tsx"));

// ── Platform detection (module-level, computed once) ──────────────

/** `true` when the client runs on an Apple platform (used for ⌘ vs Ctrl hints). */
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

// ═══════════════════════════════════════════════════════════════════
//  Sub-components (defined at module level per rerender-no-inline-
//  components best practice)
// ═══════════════════════════════════════════════════════════════════

/** Full-screen centred spinner shown while a tool chunk is loading. */
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-3 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
    </div>
  );
}

// ── ToolView ─────────────────────────────────────────────────────

interface ToolViewProps {
  /** Metadata for the currently active tool. */
  tool: Tool;
  /** The lazy-loaded component to render. */
  Component: React.LazyExoticComponent<React.ComponentType>;
}

/**
 * Renders the active tool's header (title + description) and its
 * lazily-loaded component wrapped in a `Suspense` boundary. For
 * `desktopOnly` tools on a mobile UA, renders a placeholder explaining
 * why the tool isn't available instead of mounting it — the home grid
 * already hides the card, but a saved URL / shared link could still
 * land a phone user here directly.
 */
function ToolView({ tool, Component }: ToolViewProps) {
  const Icon = tool.icon;
  const blockedOnMobile = tool.desktopOnly && isMobileDevice();
  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 bg-slate-100 dark:bg-dark-surface-alt rounded-xl flex items-center justify-center shrink-0">
          <Icon className="w-6 h-6 text-slate-700 dark:text-dark-text" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.015em] text-slate-800 dark:text-dark-text">
            {tool.title}
          </h1>
          <p className="text-slate-500 dark:text-dark-text-muted mt-0.5">{tool.description}</p>
        </div>
      </div>
      {blockedOnMobile ? (
        <DesktopOnlyNotice tool={tool} />
      ) : (
        <Suspense fallback={<LoadingSpinner />}>
          <Component />
        </Suspense>
      )}
    </div>
  );
}

/**
 * Calm placeholder shown when a `desktopOnly` tool is opened on a
 * mobile device. Says *why* (mobile WebGPU / RAM ceilings make the
 * on-device AI tools unreliable) so the user understands this isn't
 * a generic "feature unavailable" message but a deliberate gate.
 */
function DesktopOnlyNotice({ tool }: { tool: Tool }) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface p-6 sm:p-8 text-slate-700 dark:text-dark-text">
      <h2 className="text-lg font-semibold tracking-[-0.01em] mb-2">
        {tool.title} runs only on desktop
      </h2>
      <p className="text-slate-600 dark:text-dark-text-muted leading-relaxed">
        On-device AI loads large model files into memory and pushes the GPU hard during inference.
        On phones this reliably causes the browser tab to crash or the GPU device to be lost
        mid-question, so we've disabled the tool on mobile rather than ship a broken experience.
      </p>
      <p className="text-slate-600 dark:text-dark-text-muted leading-relaxed mt-3">
        Open this page on a laptop or desktop with at least 16 GB of RAM to use it. Every other
        CloakPDF tool runs fine on this device.
      </p>
    </div>
  );
}

// ── HomeScreen ───────────────────────────────────────────────────

interface HomeScreenProps {
  /** Stable callback invoked with a tool ID when the user picks a tool. */
  onSelectTool: (id: ToolId) => void;
  /** Open the canvas editor (optionally with a file). The primary entry. */
  onOpenEditor: (file?: File | null) => void;
}

/**
 * Landing page showing the hero headline, an editor drop zone, a live-search
 * bar with ⌘K / Ctrl+K shortcut, and a categorised grid of the standalone
 * tool cards (multi-input + special tools; everything else opens via the
 * editor).
 *
 * Search state is local to this component so that typing never
 * re-renders the parent `App` or the `Layout` shell. When the user
 * navigates to a tool this component unmounts, naturally discarding
 * the query; returning to the home screen starts with a fresh search.
 */
function HomeScreen({ onSelectTool, onOpenEditor }: HomeScreenProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K → focus search; Escape → clear search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "Escape" && searchQuery) {
        setSearchQuery("");
        searchInputRef.current?.blur();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [searchQuery]);

  /**
   * Standalone cards whose title or description matches the query
   * (case-insensitive). Starts from {@link HOME_CARD_TOOLS} (the editor-first
   * card set), not every tool. `desktopOnly` tools (currently just Ask PDF)
   * are also dropped on mobile so phones don't see cards for features that
   * crash their tabs — see the `desktopOnly` rationale in `tool-registry.ts`.
   */
  const filteredTools = useMemo(() => {
    const mobile = isMobileDevice();
    const visible = mobile ? HOME_CARD_TOOLS.filter((t) => !t.desktopOnly) : HOME_CARD_TOOLS;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter(
      (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [searchQuery]);

  return (
    <div>
      {/* ── Hero — editor-first, asymmetric two-column. Copy + trust features
          anchor the left; one large drop zone on the right is the single entry
          point (dropping a PDF lands straight in the canvas editor). On mobile
          the columns stack copy → drop zone → features so the primary action
          stays high. The whole hero collapses during search so results lead. ── */}
      {!searchQuery && (
        <section className="pt-4 sm:pt-8 lg:pt-10 pb-10 sm:pb-12">
          <div className="grid items-center gap-y-9 lg:grid-cols-2 lg:grid-rows-[auto_auto] lg:gap-x-12 xl:gap-x-16">
            {/* Copy */}
            <div className="order-1 max-w-xl lg:col-start-1 lg:row-start-1">
              <h1 className="text-[32px] sm:text-[40px] lg:text-[46px] xl:text-[52px] font-semibold text-slate-900 dark:text-dark-text tracking-[-0.03em] leading-[1.05] m-0 text-balance animate-fade-in-up">
                PDF tools that{" "}
                <em className="font-serif italic font-normal text-primary-600 dark:text-primary-400">
                  stay on your device
                </em>
                .
              </h1>

              <p
                className="mt-5 max-w-lg text-slate-500 dark:text-dark-text-muted text-card-title sm:text-[17px] leading-[1.55] text-pretty animate-fade-in-up"
                style={{ animationDelay: "120ms" }}
              >
                Edit, merge, sign, secure &amp; convert PDFs entirely in your browser — no uploads,
                no accounts, no tracking.
              </p>
            </div>

            {/* Drop zone — the single editor-first entry point. Vertically
                centered beside the copy on desktop; second in the flow on mobile. */}
            <div
              className="order-2 animate-fade-in-up lg:col-start-2 lg:row-span-2 lg:row-start-1"
              style={{ animationDelay: "160ms" }}
            >
              <FileDropZone
                size="hero"
                accept="application/pdf,.pdf"
                onFiles={(files) => files[0] && onOpenEditor(files[0])}
                glowColor={categoryGlow.organise}
                iconColor={categoryAccent.organise}
                label="Drop a PDF to start editing"
                hint="or click to browse — opens in the editor"
              />
            </div>

            {/* Trust features — under the copy on desktop, after the drop zone
                on mobile. Stack on phones, three across from sm up. */}
            <div
              className="order-3 grid grid-cols-1 gap-x-5 gap-y-4 animate-fade-in-up sm:grid-cols-3 lg:col-start-1 lg:row-start-2"
              style={{ animationDelay: "200ms" }}
            >
              <HeroFeature
                icon={Lock}
                title="100% Private"
                description="Everything stays on your device."
              />
              <HeroFeature icon={Zap} title="Blazing Fast" description="No servers, no waiting." />
              <HeroFeature
                icon={Code2}
                title="Open Source"
                description="Transparent & community-driven."
              />
            </div>
          </div>
        </section>
      )}

      {/* ── Search Bar ──────────────────────────────────── */}
      <div className="mb-10 sm:mb-12 animate-fade-in-up" style={{ animationDelay: "160ms" }}>
        <div className="relative group">
          {/* Soft primary glow that intensifies on focus — gives the
              field presence without leaning on a heavy border. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-px rounded-2xl bg-linear-to-r from-primary-500/0 via-primary-500/0 to-primary-500/0 opacity-0 blur-md transition-opacity duration-300 group-focus-within:opacity-100 group-focus-within:from-primary-500/20 group-focus-within:via-primary-400/15 group-focus-within:to-primary-500/20"
          />

          {/* Flex shell — leading icon tile gives the search a clear
              visual anchor; the input fills the remaining space; the
              trailing slot holds either the clear button (when active)
              or the ⌘K affordance. */}
          <div className="relative flex items-center w-full rounded-2xl bg-white/90 dark:bg-dark-surface/90 backdrop-blur-sm border border-slate-200 dark:border-dark-border hover:border-slate-300 dark:hover:border-dark-border focus-within:border-primary-300 dark:focus-within:border-primary-600 focus-within:shadow-md transition-[border-color,box-shadow] duration-200">
            <span
              aria-hidden="true"
              className="shrink-0 ml-2 my-2 w-10 h-10 flex items-center justify-center text-slate-700 dark:text-dark-text"
            >
              <Search className="w-5 h-5" strokeWidth={2.25} />
            </span>

            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tools…"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent pl-3 pr-2 py-4 text-slate-800 dark:text-dark-text placeholder-slate-400 dark:placeholder-dark-text-muted focus-visible:outline-none text-[15.5px]"
              aria-label="Search PDF tools"
            />

            <div className="shrink-0 flex items-center gap-1.5 mr-3">
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-dark-surface-alt text-slate-400 dark:text-dark-text-muted hover:text-slate-600 dark:hover:text-dark-text transition-colors"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : (
                <kbd className="hidden sm:inline-flex items-center gap-0.5 px-2 py-1 rounded-md bg-slate-50 dark:bg-dark-surface-alt border border-slate-200 dark:border-dark-border text-tag font-medium text-slate-500 dark:text-dark-text-muted font-mono tabular-nums tracking-tight select-none">
                  {isMac ? "⌘ K" : "Ctrl K"}
                </kbd>
              )}
            </div>
          </div>
        </div>

        {searchQuery && (
          <p
            className="text-center text-sm text-slate-600 dark:text-dark-text-muted mt-3 animate-fade-in-up"
            aria-live="polite"
          >
            {filteredTools.length} {filteredTools.length === 1 ? "tool" : "tools"} found
          </p>
        )}
      </div>

      {/* ── Tool Grid / Empty State ─────────────────────── */}
      {filteredTools.length === 0 ? (
        <div className="text-center py-16 animate-fade-in-up">
          <div className="w-16 h-16 bg-slate-100 dark:bg-dark-surface rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Search className="w-8 h-8 text-slate-400 dark:text-dark-text-muted" />
          </div>
          <h3 className="text-lg font-semibold text-slate-600 dark:text-dark-text mb-2">
            No tools found
          </h3>
          <p className="text-sm text-slate-600 dark:text-dark-text-muted max-w-md mx-auto">
            Try a different search term like &ldquo;merge&rdquo;, &ldquo;sign&rdquo;, or
            &ldquo;compare&rdquo;
          </p>
        </div>
      ) : (
        <div className="space-y-10 sm:space-y-12">
          {categories.map((cat, catIdx) => {
            const catTools = filteredTools.filter((t) => t.category === cat.key);
            if (catTools.length === 0) return null;
            return (
              <section
                key={cat.key}
                className="grid gap-x-8 gap-y-5 animate-fade-in-up lg:grid-cols-12 lg:items-start lg:gap-x-10"
                style={{ animationDelay: `${catIdx * 80}ms` }}
              >
                {/* Heading column — sits left of its cards on desktop, stacks
                    above them on mobile/tablet. This asymmetric, left-aligned
                    rhythm is the spine of the redesign. */}
                <div className="lg:col-span-4 xl:col-span-3">
                  <div className="text-tag font-semibold uppercase tracking-[0.12em] text-primary-600 dark:text-primary-400 mb-2">
                    {cat.label}
                    <span className="ml-2 text-slate-400 dark:text-dark-text-muted font-medium tracking-normal normal-case">
                      · {catTools.length}
                    </span>
                  </div>
                  <h2 className="text-[22px] sm:text-[26px] font-semibold tracking-[-0.02em] leading-[1.2] text-slate-900 dark:text-dark-text m-0 text-balance">
                    {cat.description}.
                  </h2>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-8 xl:col-span-9">
                  {catTools.map((tool) => (
                    <ToolCard key={tool.id} tool={tool} onSelect={onSelectTool} />
                  ))}
                </div>
              </section>
            );
          })}

          {/* ── Why CloakPDF — feature grid ── */}
          {!searchQuery && <WhyCloakPdfSection />}
        </div>
      )}
    </div>
  );
}

function WhyCloakPdfSection() {
  const { ref, revealed } = useRevealOnScroll<HTMLElement>();
  return (
    <section
      ref={ref}
      className={`pt-6 sm:pt-10 motion-safe:transition-[opacity,transform] motion-safe:duration-700 ${
        revealed ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      }`}
    >
      <div className="text-center mb-8 sm:mb-12">
        <div className="text-tag font-semibold uppercase tracking-[0.12em] text-primary-600 dark:text-primary-400 mb-2.5">
          Why CloakPDF
        </div>
        <h2 className="text-[24px] sm:text-[30px] md:text-[36px] font-semibold tracking-[-0.02em] leading-[1.15] text-slate-900 dark:text-dark-text m-0 text-balance">
          Everything you need, nothing you don&rsquo;t.
        </h2>
        <p className="text-slate-500 dark:text-dark-text-muted text-[14px] sm:text-[15.5px] leading-[1.55] max-w-140 mx-auto mt-3">
          A modern PDF toolkit that respects your privacy — built for people who care about their
          data and their craft.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-7 sm:gap-y-8">
        <FeatureItem
          icon={<UserRoundCheck className="w-5 h-5" />}
          title="No sign-up"
          description="No accounts, no email, no passwords. Start using the moment the page loads."
        />
        <FeatureItem
          icon={<EyeOff className="w-5 h-5" />}
          title="No tracking"
          description="Zero analytics, zero telemetry, zero third-party scripts. You stay anonymous."
        />
        <FeatureItem
          icon={<ShieldCheck className="w-5 h-5" />}
          title="Local-first"
          description="Every byte stays in your browser. Nothing is ever uploaded to any server."
        />
        <FeatureItem
          icon={<WifiOff className="w-5 h-5" />}
          title="Works offline"
          description="Once cached, keep editing and exporting without a connection — flights, trains, anywhere."
        />
        <FeatureItem
          icon={<Rocket className="w-5 h-5" />}
          title="Installable as a PWA"
          description="Add CloakPDF to your home screen for a full-screen, app-like experience that launches in one tap."
        />
        <FeatureItem
          icon={<MonitorSmartphone className="w-5 h-5" />}
          title="Mobile, tablet & desktop"
          description="Every tool adapts fluidly across screen sizes — edit on the go, finalise at your desk."
        />
        <FeatureItem
          icon={<LayoutGrid className="w-5 h-5" />}
          title={`${tools.length} tools + a unified editor`}
          description="Seven focused utilities for multi-file and signing jobs, plus an intuitive all-in-one editor — redact, annotate, sign, OCR, organise and far more in one workspace."
        />
        <FeatureItem
          icon={<Cpu className="w-5 h-5" />}
          title="On-device AI"
          description="Ask questions about your PDF with a chat model that runs entirely in your browser — no API key, no server round-trip."
        />
        <FeatureItem
          icon={<GitFork className="w-5 h-5" />}
          title="Free & open source"
          description="MIT-licensed and on GitHub. Fork it, self-host it, or audit every byte — every line is public."
        />
      </div>
    </section>
  );
}

// ── HomeScreen sub-components ────────────────────────────────────

interface FeatureItemProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureItem({ icon, title, description }: FeatureItemProps) {
  return (
    <div className="flex items-start gap-3.5">
      <span
        className="shrink-0 w-10 h-10 rounded-lg grid place-items-center bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:text-primary-400"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[14.5px] font-semibold tracking-[-0.005em] text-slate-800 dark:text-dark-text mb-1">
          {title}
        </div>
        <div className="text-[13.5px] leading-[1.55] text-slate-500 dark:text-dark-text-muted">
          {description}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact trust feature shown in the hero's left column (icon tile + title +
 * one-line description). Smaller and denser than {@link FeatureItem} so three
 * sit comfortably in the narrower hero column.
 */
function HeroFeature({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="shrink-0 w-9 h-9 rounded-xl grid place-items-center bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:text-primary-400"
        aria-hidden="true"
      >
        <Icon className="w-4.5 h-4.5" />
      </span>
      <div className="min-w-0">
        <div className="text-card-desc font-semibold tracking-[-0.005em] text-slate-800 dark:text-dark-text leading-tight">
          {title}
        </div>
        <div className="mt-0.5 text-meta leading-snug text-slate-500 dark:text-dark-text-muted">
          {description}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Root component
// ═══════════════════════════════════════════════════════════════════

/**
 * View state for the app — discriminated union so the active payload
 * (active tool id, edited file) lives next to the view tag.
 *
 * Kept here at module scope rather than as a `type View = ...` inside
 * `App` so the union is easier to read in isolation.
 */
type View =
  | { kind: "home" }
  | { kind: "tool"; toolId: ToolId }
  | { kind: "editor"; file: File | null; tool?: string | null }
  | { kind: "privacy" };

/**
 * Root application component.
 *
 * Manages which view is active and delegates rendering to the matching
 * child component. Keeps its own state minimal so that child-local
 * state (e.g. search) doesn't bubble up unnecessarily.
 */
export function App() {
  const [view, setView] = useState<View>({ kind: "home" });

  const goHome = useCallback(() => setView({ kind: "home" }), []);

  // Editor-first routing: single-PDF tools that live in the editor open it (with
  // that tool preselected); multi-file / terminal / AI surfaces stay standalone.
  const handleSelectTool = useCallback((id: ToolId) => {
    if (EDITOR_TOOL_IDS.has(id)) setView({ kind: "editor", file: null, tool: id });
    else setView({ kind: "tool", toolId: id });
  }, []);

  const openEditor = useCallback((file: File | null = null, tool: string | null = null) => {
    setView({ kind: "editor", file, tool });
  }, []);

  const handlePrivacy = useCallback(() => {
    setView({ kind: "privacy" });
  }, []);

  /** Scroll to top whenever the view changes. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- view is intentionally the trigger; identity changes per setView call
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  // Cross-component deep-link: a tool fires `navigateToTool(id)` and we
  // route to it. Currently used by the encrypted-PDF notice in
  // `usePdfFile` to deep-link into the PDF Password tool.
  useEffect(() => {
    function onNavigate(event: Event) {
      const id = (event as CustomEvent<ToolId>).detail;
      if (findTool(id)) setView({ kind: "tool", toolId: id });
    }
    // A multi-file constructor (Merge / Images-to-PDF) finished and handed its
    // output PDF to the editor.
    function onOpenEditor(event: Event) {
      const file = (event as CustomEvent<File>).detail;
      setView({ kind: "editor", file, tool: null });
    }
    window.addEventListener(NAVIGATE_TOOL_EVENT, onNavigate);
    window.addEventListener(OPEN_EDITOR_EVENT, onOpenEditor);
    return () => {
      window.removeEventListener(NAVIGATE_TOOL_EVENT, onNavigate);
      window.removeEventListener(OPEN_EDITOR_EVENT, onOpenEditor);
    };
  }, []);

  // The editor owns the full viewport and its own chrome, so it renders
  // outside <Layout> (no centered max-width, no app header/footer). Orientation
  // is intentionally unlocked here — the editor adapts to landscape the way
  // CloakIMG's does, rather than forcing portrait like the standalone tools.
  if (view.kind === "editor") {
    return (
      <>
        <Suspense fallback={<LoadingSpinner />}>
          <EditorView initialFile={view.file} initialTool={view.tool ?? null} onExit={goHome} />
        </Suspense>
        <ReloadPrompt />
      </>
    );
  }

  const showBack = view.kind !== "home";

  return (
    <>
      <Layout onHome={goHome} showBack={showBack} onPrivacy={handlePrivacy}>
        <ViewContent
          view={view}
          onSelectTool={handleSelectTool}
          onOpenEditor={openEditor}
          onGoHome={goHome}
        />
      </Layout>
      <ReloadPrompt />
      <OrientationLock />
    </>
  );
}

interface ViewContentProps {
  view: View;
  onSelectTool: (id: ToolId) => void;
  onOpenEditor: (file?: File | null) => void;
  onGoHome: () => void;
}

function ViewContent({ view, onSelectTool, onOpenEditor, onGoHome }: ViewContentProps) {
  switch (view.kind) {
    case "home":
      return <HomeScreen onSelectTool={onSelectTool} onOpenEditor={onOpenEditor} />;
    case "tool": {
      const meta = findTool(view.toolId);
      const Component = findToolComponent(view.toolId);
      if (!meta || !Component)
        return <HomeScreen onSelectTool={onSelectTool} onOpenEditor={onOpenEditor} />;
      return <ToolView tool={meta} Component={Component} />;
    }
    case "editor":
      // Rendered full-screen in App before <Layout>; never reached here. The
      // case satisfies the exhaustiveness check below.
      return null;
    case "privacy":
      return <PrivacyPolicy />;
    default: {
      // Exhaustiveness check — TypeScript will flag missing cases.
      const _exhaustive: never = view;
      void _exhaustive;
      void onGoHome;
      return null;
    }
  }
}
