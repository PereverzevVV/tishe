import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  Check,
  Languages,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
} from "lucide-react";
import type { TFunction } from "i18next";
import type { ModelInfo } from "@/bindings";
import { useModelStore } from "@/stores/modelStore";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { useSettings } from "@/hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  getUniqueCapabilityLanguages,
  MODEL_CAPABILITY_LANGUAGES,
  supportsLanguageCode,
} from "@/lib/constants/languages";
import {
  getTranslatedModelDescription,
  getTranslatedModelName,
} from "@/lib/utils/modelTranslation";
import { formatMb, languageName } from "@/lib/utils/humanize";
import { countChanged } from "@/lib/changedSettings";
import { Page } from "../shell/Page";
import { useAsrModelStatus } from "../shell/StatusBar";
import { SettingsGroup } from "../ui/SettingsGroup";
import { SettingContainer } from "../ui/SettingContainer";
import { Fold } from "../ui/Fold";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { Input } from "../ui/Input";
import { Tag } from "../ui/Badge";
import { Menu, useMenu } from "../ui/Menu";
import { ProgressLine } from "../ui/ProgressLine";
import { Spinner } from "../ui/Spinner";
import { TextLink } from "../ui/TextLink";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { LanguageSelector } from "../settings/LanguageSelector";
import { TranslateToEnglish } from "../settings/TranslateToEnglish";
import { CustomWords } from "../settings/CustomWords";
import { ChineseScriptSetting } from "../settings/ChineseScript";
import { ModelUnloadTimeoutSetting } from "../settings/ModelUnloadTimeout";
import { WordCorrectionThreshold } from "../settings/debug/WordCorrectionThreshold";
import { AsrModelSettingsDialog } from "../settings/models/AsrModelSettingsDialog";
import { AsrSetupCard } from "../setup/AsrSetupCard";
import { isLegacySource } from "../onboarding/ModelCard";

/**
 * «Модели» — speech recognition for the whole program (UX_INTERACTION_
 * ARCHITECTURE S5): the active model and its language first, rare cleanup and
 * memory settings in «Дополнительно», then the catalog. «Скачать» and
 * «Использовать» are separate buttons — clicking a card no longer downloads
 * and switches at once.
 */

const MORE_FOLD = "models-more";

/** Catalog size as onboarding shows it (`formatMb`); empty when unknown. */
const sizeText = (sizeMb: number, t: TFunction, locale: string) =>
  sizeMb > 0 ? formatMb(sizeMb, t, locale) : "";

export const ModelsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const {
    models,
    currentModel,
    downloadingModels,
    downloadProgress,
    downloadStats,
    verifyingModels,
    extractingModels,
    loading,
    isRescanning,
    downloadModel,
    cancelDownload,
    selectModel,
    deleteModel,
    rescanLocalModels,
  } = useModelStore();
  const { settings } = useSettings();
  const defaults = useSettingsStore((s) => s.defaultSettings);
  const running = useFileTranscriptionStore((s) => s.running);
  const link = useNavigationStore((s) => s.link);
  const { status } = useAsrModelStatus(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [paramsModelId, setParamsModelId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModelInfo | null>(null);
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("all");
  const [onlyStreaming, setOnlyStreaming] = useState(false);
  const [onlyTranslation, setOnlyTranslation] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);

  const active = models.find((m) => m.id === currentModel && m.is_downloaded);
  const downloaded = models.filter((m) => m.is_downloaded);

  const languageText = (m: ModelInfo) => {
    const langs = getUniqueCapabilityLanguages(m.supported_languages);
    if (langs.length === 1)
      return t("models.onlyLanguage", {
        language: languageName(langs[0], i18n.language),
      });
    if (langs.length > 1)
      return t("models.languageCount", { count: langs.length });
    return "";
  };

  const use = async (id: string) => {
    setSwitching(id);
    try {
      await selectModel(id);
    } finally {
      setSwitching(null);
    }
  };

  // Filters apply to the whole catalog.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (isLegacySource(m) && !m.is_downloaded) return false;
      if (
        language !== "all" &&
        !supportsLanguageCode(m.supported_languages, language)
      )
        return false;
      if (onlyStreaming && !m.supports_streaming) return false;
      if (onlyTranslation && !m.supports_translation) return false;
      if (q && !`${m.name} ${m.description}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [models, query, language, onlyStreaming, onlyTranslation]);

  const yours = filtered
    .filter(
      (m) =>
        m.is_custom ||
        m.is_downloaded ||
        m.id in downloadingModels ||
        m.id in extractingModels,
    )
    .sort((a, b) => {
      if (a.id === currentModel) return -1;
      if (b.id === currentModel) return 1;
      if (a.is_custom !== b.is_custom) return a.is_custom ? 1 : -1;
      return 0;
    });
  const notYours = filtered.filter((m) => !yours.includes(m));
  const recommended = notYours.filter((m) => m.is_recommended);
  const others = notYours.filter((m) => !m.is_recommended);
  // The long tail stays folded unless a search or filter narrows it.
  const narrowed =
    query.trim() !== "" ||
    language !== "all" ||
    onlyStreaming ||
    onlyTranslation;
  const OTHERS_SHOWN = 8;
  const visibleOthers =
    showAllModels || narrowed ? others : others.slice(0, OTHERS_SHOWN);

  const moreChanged = countChanged(settings, defaults, [
    "custom_words",
    "word_correction_threshold",
    "chinese_script",
    "model_unload_timeout",
  ]);

  const stateText = {
    ready: t("statusBar.model.ready"),
    loading: t("statusBar.model.loading"),
    error: t("statusBar.model.error"),
    unloaded: t("statusBar.model.unloaded"),
    none: t("statusBar.model.none"),
  }[status];

  const supportsChinese =
    !!active &&
    (supportsLanguageCode(active.supported_languages, "zh") ||
      supportsLanguageCode(active.supported_languages, "yue"));
  const customWords = settings?.custom_words ?? [];

  const row = (m: ModelInfo, index: number, list: ModelInfo[]) => (
    <ModelRow
      key={m.id}
      model={m}
      last={index === list.length - 1}
      active={m.id === currentModel && m.is_downloaded}
      switching={switching === m.id}
      downloading={m.id in downloadingModels}
      verifying={m.id in verifyingModels}
      extracting={m.id in extractingModels}
      percent={downloadProgress[m.id]?.percentage}
      speed={downloadStats[m.id]?.speed}
      locked={running}
      size={sizeText(Number(m.size_mb), t, i18n.language)}
      languageText={languageText(m)}
      onUse={() => void use(m.id)}
      onDownload={() => void downloadModel(m.id)}
      onCancel={() => void cancelDownload(m.id)}
      onDelete={() => setConfirmDelete(m)}
      onParams={() => setParamsModelId(m.id)}
    />
  );

  const filterButton = (
    on: boolean,
    toggle: () => void,
    icon: React.ReactNode,
    label: string,
  ) => (
    <Button variant="quiet" size="sm" aria-pressed={on} onClick={toggle}>
      {on ? <Check aria-hidden="true" /> : icon}
      {label}
    </Button>
  );

  return (
    <Page
      section="models"
      title={t("sidebar.models")}
      purpose={
        <>
          {t("models.purpose")}{" "}
          <TextLink onClick={() => link("llm", { target: "llm-where" })}>
            {t("sidebar.llm")}
          </TextLink>
        </>
      }
    >
      <div className="t-work t-wide">
        <div className="t-work-main">
          <SettingsGroup
            title={t("models.active.title")}
            anchor="models-active"
          >
            {active ? (
              <SettingContainer
                title={
                  <span className="t-type-headline">
                    {getTranslatedModelName(active, t)}
                  </span>
                }
                extra={
                  <div className="t-svc">
                    {status === "loading" ? (
                      <Spinner size={14} />
                    ) : (
                      <span
                        className={`t-dot ${status === "ready" ? "" : "t-dot-empty"}`}
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {[stateText, languageText(active)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                }
              >
                <Dropdown
                  ariaLabel={t("models.active.change")}
                  selectedValue={active.id}
                  disabled={running}
                  options={downloaded.map((m) => ({
                    value: m.id,
                    label: getTranslatedModelName(m, t),
                  }))}
                  onSelect={(id) => id !== active.id && void use(id)}
                />
                <Button
                  variant="quiet"
                  icon
                  aria-label={t("settings.models.params.open")}
                  title={t("settings.models.params.open")}
                  onClick={() => setParamsModelId(active.id)}
                >
                  <Settings aria-hidden="true" />
                </Button>
              </SettingContainer>
            ) : (
              <>
                <SettingContainer
                  title={t("models.active.none")}
                  description={t("models.active.noneHint")}
                />
                <div className="t-block">
                  <AsrSetupCard embedded />
                </div>
              </>
            )}
            {running && (
              <div className="t-lock pb-3">
                {t("models.lockedByTranscription")}
              </div>
            )}
          </SettingsGroup>

          {active &&
            (active.supports_language_selection ||
              active.supports_translation) && (
              <SettingsGroup
                title={t("models.language.title")}
                description={t("models.language.scope")}
                anchor="models-language"
              >
                {active.supports_language_selection && (
                  <LanguageSelector
                    grouped
                    supportedLanguages={active.supported_languages}
                    supportsLanguageDetection={
                      active.supports_language_detection
                    }
                    disabled={running}
                    disabledReason={
                      running ? t("models.lockedByTranscription") : undefined
                    }
                  />
                )}
                {active.supports_translation && <TranslateToEnglish grouped />}
              </SettingsGroup>
            )}
        </div>

        <div className="t-work-side">
          <Fold id={MORE_FOLD} title={t("ui.fold.more")} changed={moreChanged}>
            <SettingsGroup
              title={t("models.cleanup.title")}
              description={t("models.cleanup.scope")}
              anchor="models-cleanup"
            >
              <CustomWords grouped />
              {customWords.length > 0 && <WordCorrectionThreshold dependent />}
              {supportsChinese && <ChineseScriptSetting grouped />}
            </SettingsGroup>
            <SettingsGroup
              title={t("models.memory.title")}
              anchor="models-memory"
            >
              <ModelUnloadTimeoutSetting grouped />
            </SettingsGroup>
          </Fold>
        </div>
      </div>

      <section className="t-fold t-wide" data-anchor="models-catalog">
        <h2 className="t-group-title" tabIndex={-1}>
          {t("models.catalog.title")}
        </h2>
        <div className="mb-2 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              width={16}
              height={16}
              aria-hidden="true"
              className="t-icon-tertiary pointer-events-none absolute start-3 top-2"
            />
            <Input
              className="w-full ps-9"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.models.searchPlaceholder")}
              aria-label={t("settings.models.searchPlaceholder")}
            />
          </div>
          <Button
            variant="quiet"
            icon
            onClick={() => void rescanLocalModels()}
            disabled={isRescanning}
            aria-label={t("settings.models.rescan.tooltip")}
            title={t("settings.models.rescan.tooltip")}
          >
            {isRescanning ? (
              <Spinner size={16} />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
          </Button>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-1">
          <Dropdown
            ariaLabel={t("models.catalog.languageFilter")}
            selectedValue={language}
            onSelect={setLanguage}
            options={[
              {
                value: "all",
                label: t("settings.models.filters.allLanguages"),
              },
              ...MODEL_CAPABILITY_LANGUAGES.map((l) => ({
                value: l.value,
                label: capitalize(languageName(l.value, i18n.language)),
              })),
            ]}
          />
          {filterButton(
            onlyStreaming,
            () => setOnlyStreaming((v) => !v),
            <AudioLines aria-hidden="true" />,
            t("models.catalog.streaming"),
          )}
          {filterButton(
            onlyTranslation,
            () => setOnlyTranslation((v) => !v),
            <Languages aria-hidden="true" />,
            t("models.catalog.translation"),
          )}
        </div>

        {loading ? (
          <div className="t-empty">
            <Spinner size={16} />
          </div>
        ) : (
          <>
            {yours.length > 0 && (
              <div
                className="t-list t-list-grid"
                role="list"
                aria-label={t("models.catalog.yours")}
              >
                <h3 className="t-list-title">
                  {t("models.catalog.yoursCount", { count: yours.length })}
                </h3>
                {yours.map(row)}
              </div>
            )}
            {recommended.length > 0 && (
              <div
                className="t-list t-list-grid mt-6"
                role="list"
                aria-label={t("models.catalog.recommended")}
              >
                <h3 className="t-list-title">
                  {t("models.catalog.recommended")}
                </h3>
                {recommended.map(row)}
              </div>
            )}
            {others.length > 0 && (
              <div
                className="t-list t-list-grid mt-6"
                role="list"
                aria-label={t("models.catalog.all")}
              >
                <h3 className="t-list-title">{t("models.catalog.all")}</h3>
                {visibleOthers.map(row)}
              </div>
            )}
            {!narrowed && others.length > OTHERS_SHOWN && (
              <div className="t-list-more">
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setShowAllModels((s) => !s)}
                >
                  {showAllModels
                    ? t("models.catalog.showFewer")
                    : t("models.catalog.showAll", { count: others.length })}
                </Button>
              </div>
            )}
            {filtered.length === 0 && (
              <div className="t-empty">
                <div className="t-empty-text">
                  {t("settings.models.noModelsMatch")}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <AsrModelSettingsDialog
        modelId={paramsModelId}
        modelName={models.find((m) => m.id === paramsModelId)?.name ?? ""}
        onClose={() => setParamsModelId(null)}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={
          confirmDelete && confirmDelete.id === currentModel
            ? t("ui.confirm.deleteActiveTitle", {
                name: getTranslatedModelName(confirmDelete, t),
              })
            : t("ui.confirm.deleteModelTitle", {
                name: confirmDelete
                  ? getTranslatedModelName(confirmDelete, t)
                  : "",
              })
        }
        confirmLabel={t("ui.confirm.deleteModel")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const m = confirmDelete;
          setConfirmDelete(null);
          if (m) void deleteModel(m.id).catch((e) => console.error(e));
        }}
      >
        {confirmDelete &&
          (confirmDelete.id === currentModel
            ? t("ui.confirm.deleteActiveBody", {
                size: sizeText(Number(confirmDelete.size_mb), t, i18n.language),
              })
            : t("ui.confirm.deleteModelBody", {
                size: sizeText(Number(confirmDelete.size_mb), t, i18n.language),
              }))}
      </ConfirmDialog>
    </Page>
  );
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

interface ModelRowProps {
  model: ModelInfo;
  last: boolean;
  active: boolean;
  switching: boolean;
  downloading: boolean;
  verifying: boolean;
  extracting: boolean;
  percent?: number;
  speed?: number;
  locked: boolean;
  size: string;
  languageText: string;
  onUse: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onParams: () => void;
}

const ModelRow: React.FC<ModelRowProps> = ({
  model,
  last,
  active,
  switching,
  downloading,
  verifying,
  extracting,
  percent,
  speed,
  locked,
  size,
  languageText,
  onUse,
  onDownload,
  onCancel,
  onDelete,
  onParams,
}) => {
  const { t } = useTranslation();
  const menu = useMenu();
  const debugMode = useSettingsStore((s) => s.settings?.debug_mode ?? false);
  const name = getTranslatedModelName(model, t);
  // GGUF quantization, shown only in debug mode (as the old card did).
  const quant = model.filename
    .match(/[._-](IQ\d+_\w+|Q\d+(?:_\w+)?|F16|BF16|F32)\.gguf$/i)?.[1]
    ?.toUpperCase();
  const legacy = isLegacySource(model);

  const meta = [
    languageText,
    model.supports_translation ? t("models.row.translate") : null,
    model.accuracy_score > 0
      ? t("models.row.accuracy", { n: Math.round(model.accuracy_score * 10) })
      : null,
    model.speed_score > 0
      ? t("models.row.speed", { n: Math.round(model.speed_score * 10) })
      : null,
    model.is_downloaded || model.is_custom ? size : null,
    debugMode && quant ? quant : null,
  ].filter(Boolean);

  let acts: React.ReactNode;
  if (downloading) {
    acts = (
      <Button variant="quiet" size="sm" onClick={onCancel}>
        {t("ui.cancelDownload")}
      </Button>
    );
  } else if (verifying || extracting) {
    acts = null;
  } else if (model.is_downloaded) {
    acts = (
      <>
        {active ? (
          <Tag>{t("models.row.inUse")}</Tag>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={switching}
            disabled={locked}
            title={locked ? t("models.lockedByTranscription") : undefined}
            onClick={onUse}
          >
            {t("models.row.use")}
          </Button>
        )}
        <Button
          ref={menu.anchorRef}
          variant="quiet"
          size="sm"
          icon
          aria-label={t("models.row.more", { name })}
          title={t("models.row.more", { name })}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
        <Menu
          anchor={menu.anchorRef.current}
          open={menu.open}
          onClose={menu.close}
          align="end"
          items={[
            {
              value: "params",
              label: t("settings.models.params.open"),
              onSelect: onParams,
            },
            {
              value: "delete",
              label: t("models.row.delete"),
              danger: true,
              separatorBefore: true,
              disabled: locked && active,
              onSelect: onDelete,
            },
          ]}
        />
      </>
    );
  } else {
    acts = (
      <Button variant="secondary" size="sm" onClick={onDownload}>
        {size ? t("ui.downloadSize", { size }) : t("ui.download")}
      </Button>
    );
  }

  return (
    <div
      className={`t-item ${last ? "t-item-last" : ""}`}
      role="listitem"
      data-anchor={`model-${model.id}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="t-item-name">{name}</span>
          {model.is_custom && <Tag>{t("modelSelector.custom")}</Tag>}
          {legacy && <Tag>{t("modelSelector.legacy")}</Tag>}
          {model.supports_streaming && <Tag>{t("models.row.streaming")}</Tag>}
        </div>
        <div className="t-item-meta">{meta.join(" · ")}</div>
        <div className="t-row-desc">
          {getTranslatedModelDescription(model, t)}
        </div>
        {downloading && (
          <div className="mt-1">
            <div className="t-item-meta">
              {t("ui.downloadingPercent", {
                percent: Math.round(percent ?? 0),
              })}
              {speed && speed > 0
                ? ` · ${t("modelSelector.downloadSpeed", { speed: speed.toFixed(1) })}`
                : ""}
            </div>
            <ProgressLine value={percent ?? 0} label={name} />
          </div>
        )}
        {(verifying || extracting) && (
          <div className="mt-1">
            <div className="t-item-meta">
              {verifying
                ? t("modelSelector.verifyingGeneric")
                : t("modelSelector.extractingGeneric")}
            </div>
            <ProgressLine value={null} label={name} />
          </div>
        )}
      </div>
      <div className="t-item-acts">{acts}</div>
    </div>
  );
};
