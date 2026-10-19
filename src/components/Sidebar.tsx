import React from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  Compass,
  FileAudio,
  FlaskConical,
  History,
  Info,
  Mic,
  Settings,
  Users,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { useNavigationStore, type SectionId } from "@/stores/navigationStore";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { useModelStore } from "@/stores/modelStore";
import { useLlmStore } from "@/stores/llmStore";
import { Spinner } from "./ui/Spinner";
import { WithTooltip } from "./ui/Tooltip";
import { RAIL_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { SECTION_TITLE_KEY } from "./shell/Page";
import logoUrl from "@/assets/tishe-logo.png";

/**
 * Sidebar (VISUAL_DESIGN_SYSTEM §12.11, UX_INTERACTION_ARCHITECTURE Global
 * Navigation): «Tishe», then work sections, resources and the program, and
 * «О программе». «Отладка» appears after Ctrl+Shift+D. The selected item is a
 * neutral fill plus weight 600; items show only «идёт» and «готово, не
 * просмотрено», never counters or red dots. In a narrow work area (zoom,
 * small window) it is a rail of icons with the names in tooltips.
 */

type Item = {
  id: SectionId;
  icon: LucideIcon;
  soon?: boolean;
};

const GROUPS: Item[][] = [
  [
    { id: "transcription", icon: FileAudio },
    { id: "dictation", icon: Mic },
    { id: "meetings", icon: Users, soon: true },
    { id: "history", icon: History },
  ],
  [
    // Named by what they do (2026-10-18): speech → text, text → better text.
    { id: "models", icon: AudioLines },
    { id: "llm", icon: WandSparkles },
    { id: "app", icon: Settings },
  ],
  [
    { id: "next", icon: Compass },
    { id: "about", icon: Info },
  ],
];

export const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const section = useNavigationStore((s) => s.section);
  const open = useNavigationStore((s) => s.open);
  const unseen = useNavigationStore((s) => s.unseenResults);
  const running = useFileTranscriptionStore((s) => s.running);
  const asrBusy = useModelStore(
    (s) =>
      Object.keys(s.downloadingModels).length > 0 ||
      Object.keys(s.extractingModels).length > 0,
  );
  const llmBusy = useLlmStore((s) => s.models.some((m) => m.downloading));
  const debug = settings?.debug_mode ?? false;
  const rail = useMediaQuery(RAIL_QUERY);

  const groups = debug
    ? [
        ...GROUPS.slice(0, 2),
        [...GROUPS[2], { id: "debug", icon: FlaskConical } as Item],
      ]
    : GROUPS;

  const indicator = (id: SectionId): React.ReactNode => {
    if (id === "transcription") {
      if (running)
        return (
          <span className="t-nav-end" title={t("sidebar.state.running")}>
            <Spinner size={12} />
          </span>
        );
      if (unseen)
        return (
          <span className="t-nav-end">
            <span className="t-nav-dot" />
          </span>
        );
    }
    if ((id === "models" && asrBusy) || (id === "llm" && llmBusy))
      return (
        <span className="t-nav-end" title={t("sidebar.state.downloading")}>
          <Spinner size={12} />
        </span>
      );
    return null;
  };

  const stateLabel = (id: SectionId): string => {
    if (id === "transcription" && running) return t("sidebar.state.running");
    if (id === "transcription" && unseen) return t("sidebar.state.new");
    if ((id === "models" && asrBusy) || (id === "llm" && llmBusy))
      return t("sidebar.state.downloading");
    return "";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(".t-nav"),
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    e.preventDefault();
    const next =
      e.key === "ArrowDown"
        ? items[(index + 1) % items.length]
        : items[(index - 1 + items.length) % items.length];
    next.focus();
  };

  return (
    <nav
      className="t-side"
      aria-label={t("sidebar.label")}
      onKeyDown={onKeyDown}
    >
      <div className="t-mark">
        <img className="t-mark-logo" src={logoUrl} alt="" />
        <span className="t-mark-text">{t("ui.productName")}</span>
      </div>
      {groups.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <div className="t-nav-sep" role="separator" />}
          {group.map(({ id, icon: Icon, soon }) => {
            const label = t(SECTION_TITLE_KEY[id]);
            const state = stateLabel(id);
            const item = (
              <button
                type="button"
                className="t-nav"
                aria-current={section === id ? "page" : undefined}
                aria-label={
                  [label, soon ? t("sidebar.soon") : "", state]
                    .filter(Boolean)
                    .join(", ") || undefined
                }
                onClick={() => open(id)}
              >
                <Icon width={18} height={18} />
                <span className={`t-nav-label ${soon ? "t-nav-soon" : ""}`}>
                  {label}
                </span>
                {soon && <span className="t-tag">{t("sidebar.soon")}</span>}
                {indicator(id)}
              </button>
            );
            return (
              <React.Fragment key={id}>
                {rail ? (
                  <WithTooltip
                    text={[label, soon ? t("sidebar.soon") : "", state]
                      .filter(Boolean)
                      .join(" · ")}
                    position="right"
                    block
                  >
                    {item}
                  </WithTooltip>
                ) : (
                  item
                )}
              </React.Fragment>
            );
          })}
        </React.Fragment>
      ))}
    </nav>
  );
};
