import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { toast, Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { ModelStateEvent, RecordingErrorEvent } from "./lib/types/events";
import "./App.css";
import Onboarding, { AccessibilityOnboarding } from "./components/onboarding";
import { type OnboardingPreviewStep } from "./components/settings/debug/OnboardingPreview";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { QuitConfirm } from "./components/shell/QuitConfirm";
import { TranscriptionPage } from "./components/pages/TranscriptionPage";
import { DictationPage } from "./components/pages/DictationPage";
import { MeetingsPage } from "./components/pages/MeetingsPage";
import { HistoryPage } from "./components/pages/HistoryPage";
import { ModelsPage } from "./components/pages/ModelsPage";
import { LlmPage } from "./components/pages/LlmPage";
import { AppPage } from "./components/pages/AppPage";
import { AboutPage } from "./components/pages/AboutPage";
import { NextPage } from "./components/pages/NextPage";
import { DebugPage } from "./components/pages/DebugPage";
import { useNavigationStore, type SectionId } from "./stores/navigationStore";
import { useLlmStore } from "./stores/llmStore";
import { useFileOptionsStore } from "./stores/fileOptionsStore";
import { useFileTranscriptionStore } from "./stores/fileTranscriptionStore";
import { startQueueSignals } from "./lib/queueSignals";
import { useOnboardingStore } from "./stores/onboardingStore";
import { useFileDrop } from "./hooks/useFileDrop";
import { WhatsNewGate } from "./components/whats-new";
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { commands } from "@/bindings";
import { getLanguageDirection, initializeRTL } from "@/lib/utils/rtl";

type OnboardingStep = "accessibility" | "model" | "done";

// Stable identity so preview effects do not re-run due to callback changes.
const NOOP = () => {};

const renderSection = (
  section: SectionId,
  onPreviewOnboarding: (step: OnboardingPreviewStep) => void,
) => {
  switch (section) {
    case "transcription":
      return <TranscriptionPage />;
    case "dictation":
      return <DictationPage />;
    case "meetings":
      return <MeetingsPage />;
    case "history":
      return <HistoryPage />;
    case "models":
      return <ModelsPage />;
    case "llm":
      return <LlmPage />;
    case "app":
      return <AppPage />;
    case "next":
      return <NextPage />;
    case "about":
      return <AboutPage />;
    case "debug":
      return <DebugPage onPreviewOnboarding={onPreviewOnboarding} />;
  }
};

function App() {
  const { t, i18n } = useTranslation();
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(
    null,
  );
  const [onboardingPreview, setOnboardingPreview] =
    useState<OnboardingPreviewStep | null>(null);
  // Track if this is a returning user who just needs to grant permissions
  // (vs a new user who needs full onboarding including model selection)
  const [isReturningUser, setIsReturningUser] = useState(false);
  const currentSection = useNavigationStore((state) => state.section);
  const openSection = useNavigationStore((state) => state.open);
  const goBack = useNavigationStore((state) => state.goBack);
  const loadLlm = useLlmStore((state) => state.load);
  const loadFileOptions = useFileOptionsStore((state) => state.load);
  const loadResults = useFileTranscriptionStore((state) => state.loadResults);
  const { settings, updateSetting } = useSettings();
  const direction = getLanguageDirection(i18n.language);
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const hasCompletedPostOnboardingInit = useRef(false);
  const isShowingOnboarding =
    onboardingPreview !== null ||
    onboardingStep === "accessibility" ||
    onboardingStep === "model";

  // Classic scrollbars consume layout space. Reserve a matching gutter on the
  // opposite edge while onboarding is visible so its content stays centered in
  // the physical window. Overlay scrollbars ignore scrollbar-gutter.
  useLayoutEffect(() => {
    const attribute = "data-onboarding-active";
    document.documentElement.toggleAttribute(attribute, isShowingOnboarding);
    return () => document.documentElement.removeAttribute(attribute);
  }, [isShowingOnboarding]);

  // Recordings dropped onto the window go to the «Расшифровка» queue.
  useFileDrop(onboardingStep === "done" && onboardingPreview === null);

  // Shared resources read by several pages and the sidebar.
  useEffect(() => {
    void loadLlm();
    void loadFileOptions();
    void loadResults();
    // Tray tooltip and Windows notifications follow the queue.
    startQueueSignals();
  }, [loadLlm, loadFileOptions, loadResults]);

  // «Отладка» hidden again while open: go to «Расшифровка».
  useEffect(() => {
    if (currentSection === "debug" && settings && !settings.debug_mode) {
      openSection("transcription");
    }
  }, [currentSection, settings, openSection]);

  // Alt+← and the mouse back button follow the back row while it is shown.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowLeft") goBack();
    };
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) goBack();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mouseup", onMouse);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mouseup", onMouse);
    };
  }, [goBack]);

  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  // Initialize RTL direction when language changes
  useEffect(() => {
    initializeRTL(i18n.language);
  }, [i18n.language]);

  // Initialize Enigo, shortcuts, and refresh audio devices when main app loads
  useEffect(() => {
    if (onboardingStep === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ]).catch((e) => {
        console.warn("Failed to initialize:", e);
      });
      refreshAudioDevices();
      refreshOutputDevices();
    }
  }, [onboardingStep, refreshAudioDevices, refreshOutputDevices]);

  // Handle keyboard shortcuts for debug mode toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS)
      const isDebugShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        (event.ctrlKey || event.metaKey);

      if (isDebugShortcut) {
        event.preventDefault();
        const currentDebugMode = settings?.debug_mode ?? false;
        updateSetting("debug_mode", !currentDebugMode);
      }
    };

    // Add event listener when component mounts
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup event listener when component unmounts
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settings?.debug_mode, updateSetting]);

  // Listen for recording errors from the backend and show a toast
  useEffect(() => {
    const unlisten = listen<RecordingErrorEvent>("recording-error", (event) => {
      const { error_type, detail } = event.payload;

      if (error_type === "microphone_permission_denied") {
        const currentPlatform = platform();
        const platformKey = `errors.micPermissionDenied.${currentPlatform}`;
        const description = t(platformKey, {
          defaultValue: t("errors.micPermissionDenied.generic"),
        });
        toast.error(t("errors.micPermissionDeniedTitle"), { description });
      } else if (error_type === "no_input_device") {
        toast.error(t("errors.noInputDeviceTitle"), {
          description: t("errors.noInputDevice"),
        });
      } else {
        toast.error(
          t("errors.recordingFailed", { error: detail ?? "Unknown error" }),
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for paste failures and show a toast.
  // The technical error detail is logged to handy.log on the Rust side
  // (see actions.rs `error!("Failed to paste transcription: ...")`),
  // so we show a localized, user-friendly message here instead of the raw error.
  useEffect(() => {
    const unlisten = listen("paste-error", () => {
      toast.error(t("errors.pasteFailedTitle"), {
        description: t("errors.pasteFailed"),
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for transcription failures and show a toast.
  // The payload is the backend error message (also logged to handy.log).
  useEffect(() => {
    const unlisten = listen<string>("transcription-error", (event) => {
      toast.error(t("errors.transcriptionFailedTitle"), {
        description: event.payload,
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  // Listen for model loading failures and show a toast
  useEffect(() => {
    const unlisten = listen<ModelStateEvent>("model-state-changed", (event) => {
      if (event.payload.event_type === "loading_failed") {
        toast.error(
          t("errors.modelLoadFailed", {
            model:
              event.payload.model_name || t("errors.modelLoadFailedUnknown"),
          }),
          {
            description: event.payload.error,
          },
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  const revealMainWindowForPermissions = async () => {
    try {
      await commands.showMainWindowCommand();
    } catch (e) {
      console.warn("Failed to show main window for permission onboarding:", e);
    }
  };

  const checkOnboardingStatus = async () => {
    try {
      const settingsResult = await commands.getAppSettings();
      const hasCompletedOnboarding =
        settingsResult.status === "ok" &&
        settingsResult.data.onboarding_completed === true;
      const currentPlatform = platform();

      if (hasCompletedOnboarding) {
        // Returning user - check if they need to grant permissions first
        setIsReturningUser(true);

        if (currentPlatform === "macos") {
          try {
            const [hasAccessibility, hasMicrophone] = await Promise.all([
              checkAccessibilityPermission(),
              checkMicrophonePermission(),
            ]);
            if (!hasAccessibility || !hasMicrophone) {
              await revealMainWindowForPermissions();
              setOnboardingStep("accessibility");
              return;
            }
          } catch (e) {
            console.warn("Failed to check macOS permissions:", e);
            // If we can't check, proceed to main app and let them fix it there
          }
        }

        if (currentPlatform === "windows") {
          try {
            const microphoneStatus =
              await commands.getWindowsMicrophonePermissionStatus();
            if (
              microphoneStatus.supported &&
              microphoneStatus.overall_access === "denied"
            ) {
              await revealMainWindowForPermissions();
              setOnboardingStep("accessibility");
              return;
            }
          } catch (e) {
            console.warn("Failed to check Windows microphone permissions:", e);
            // If we can't check, proceed to main app and let them fix it there
          }
        }

        setOnboardingStep("done");
      } else {
        // New user - start full onboarding
        setIsReturningUser(false);
        setOnboardingStep("accessibility");
      }
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
      setOnboardingStep("accessibility");
    }
  };

  const handleAccessibilityComplete = () => {
    // Returning users already have models, skip to main app
    // New users need to select a model
    setOnboardingStep(isReturningUser ? "done" : "model");
  };

  const handleModelSelected = () => {
    // The model is ready: «Расшифровка» with «Быстрый старт» (VD-87).
    setOnboardingStep("done");
    useOnboardingStore.getState().openQuickStart();
    openSection("transcription");
  };

  // «Открыть Tishe» while the model downloads: the download goes on and
  // «Быстрый старт» shows its progress; the status bar makes the model active
  // when it completes.
  const handleContinueWhileDownloading = () => {
    setOnboardingStep("done");
    useOnboardingStore.getState().openQuickStart();
    openSection("transcription");
  };

  // Rendered once around every step below (including onboarding) so
  // toast.error() calls surface to the user. sonner renders via a portal, so
  // its position in the tree doesn't affect layout. Without this, errors during
  // onboarding (e.g. a model download failing because blob.handy.computer is
  // unreachable) are silently swallowed and the wizard just appears to "blink".
  // Toasts (VISUAL_DESIGN_SYSTEM §12.22): right edge of the field, 64 px from
  // the top so they never cover the page title or the launch panel.
  const toaster = (
    <Toaster
      theme="system"
      position="top-right"
      offset={{ top: 64, right: 12 }}
      gap={8}
      visibleToasts={3}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "t-toast",
          title: "t-toast-title",
          description: "t-toast-desc",
          actionButton: "t-btn t-btn-quiet t-btn-sm",
          cancelButton: "t-btn t-btn-quiet t-btn-sm",
          closeButton: "t-btn t-btn-quiet t-btn-sm t-btn-icon",
        },
      }}
    />
  );

  // Still checking onboarding status
  if (onboardingStep === null) {
    return null;
  }

  // Select the content for the current step. The Toaster is rendered once, in a
  // stable wrapper around this node, so crossing between onboarding steps and
  // the main app never remounts it (which would drop any in-flight toast).
  let content: ReactNode;
  if (onboardingPreview) {
    // Render previews in the same top-level slot as real onboarding. Keeping
    // the settings layout unmounted ensures viewport overflow behaves exactly
    // as it does during first-run onboarding.
    content = (
      <>
        {onboardingPreview === "accessibility" ? (
          <AccessibilityOnboarding onComplete={NOOP} preview />
        ) : (
          <Onboarding onModelSelected={NOOP} preview />
        )}
        <button
          type="button"
          onClick={() => setOnboardingPreview(null)}
          className="t-btn t-btn-secondary fixed top-4 end-4"
          style={{ zIndex: "var(--t-z-toast)" }}
        >
          {t("settings.debug.onboardingPreview.exitButton")}
        </button>
      </>
    );
  } else if (onboardingStep === "accessibility") {
    content = (
      <AccessibilityOnboarding
        onComplete={handleAccessibilityComplete}
        showStep={!isReturningUser}
      />
    );
  } else if (onboardingStep === "model") {
    content = (
      <Onboarding
        onModelSelected={handleModelSelected}
        onContinue={handleContinueWhileDownloading}
      />
    );
  } else {
    content = (
      <div dir={direction} className="t-window">
        <ErrorBoundary context="What's New">
          <WhatsNewGate />
        </ErrorBoundary>
        <Sidebar />
        <ErrorBoundary key={currentSection} context={currentSection}>
          {renderSection(currentSection, setOnboardingPreview)}
        </ErrorBoundary>
        <StatusBar />
        <QuitConfirm />
      </div>
    );
  }

  return (
    <>
      {toaster}
      {content}
    </>
  );
}

export default App;
