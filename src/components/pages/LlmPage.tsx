import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, RefreshCcw } from "lucide-react";
import type { ModelUnloadTimeout } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { countChanged } from "@/lib/changedSettings";
import { useFileOptionsStore } from "@/stores/fileOptionsStore";
import {
  APPLE_PROVIDER_ID,
  CUSTOM_PROVIDER_ID,
  LOCAL_PROVIDER_ID,
  MODEL_LOOK,
  RECOMMENDED_LOCAL_MODEL,
  providerWhere,
  useLlmStore,
  type LlmWhere,
} from "@/stores/llmStore";
import { formatBytes } from "@/lib/utils/humanize";
import { Page } from "../shell/Page";
import { SettingsGroup } from "../ui/SettingsGroup";
import { SettingContainer } from "../ui/SettingContainer";
import { Fold } from "../ui/Fold";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { Tag } from "../ui/Badge";
import { Alert } from "../ui/Alert";
import { Menu, useMenu } from "../ui/Menu";
import { ProgressLine } from "../ui/ProgressLine";
import { ServiceLine } from "../ui/ServiceLine";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ApiKeyField } from "../settings/PostProcessingSettingsApi/ApiKeyField";
import { BaseUrlField } from "../settings/PostProcessingSettingsApi/BaseUrlField";
import { ModelSelect } from "../settings/PostProcessingSettingsApi/ModelSelect";
import { usePostProcessProviderState } from "../settings/PostProcessingSettingsApi/usePostProcessProviderState";
import { LocalLlmModelSettingsDialog } from "../settings/PostProcessingSettingsApi/LocalLlmModelSettingsDialog";

/**
 * «Нейросеть» — the resource that edits text (UX_INTERACTION_ARCHITECTURE S6).
 * The main decision is where it runs, grouped by where the text goes: this
 * computer, your own server, or a cloud service. Under the choice — what that
 * variant needs. File editing and dictation with editing only read it.
 */

const LAST_CLOUD_KEY = "tishe.lastCloudProvider";
const MORE_FOLD = "llm-more";
const SHOWN_LOCAL = 1;

const readLastCloud = (): string | null => {
  try {
    return localStorage.getItem(LAST_CLOUD_KEY);
  } catch {
    return null;
  }
};

export const LlmPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const {
    settings,
    setPostProcessProvider,
    updatePostProcessModel,
    updateSetting,
  } = useSettings();
  const state = usePostProcessProviderState();
  const defaults = useSettingsStore((s) => s.defaultSettings);
  const llm = useLlmStore();
  const fileOptions = useFileOptionsStore((s) => s.options);
  const [showAll, setShowAll] = useState(false);
  const [paramsModelId, setParamsModelId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const providers = settings?.post_process_providers ?? [];
  const providerId = state.selectedProviderId;
  const where = providerWhere(providerId);
  const localAvailable = providers.some(
    (p) => p.id === LOCAL_PROVIDER_ID || p.id === APPLE_PROVIDER_ID,
  );
  const cloudProviders = providers.filter(
    (p) => providerWhere(p.id) === "cloud",
  );
  const selectedLocal =
    settings?.post_process_models?.[LOCAL_PROVIDER_ID] ?? "";
  const unloadTimeout = settings?.local_llm_unload_timeout ?? "min5";

  const choose = (next: LlmWhere) => {
    if (next === where) return;
    if (next === "local") {
      const id = providers.some((p) => p.id === LOCAL_PROVIDER_ID)
        ? LOCAL_PROVIDER_ID
        : APPLE_PROVIDER_ID;
      void state.handleProviderSelect(id);
    } else if (next === "server") {
      void state.handleProviderSelect(CUSTOM_PROVIDER_ID);
    } else {
      const last = readLastCloud();
      const id =
        (last && cloudProviders.some((p) => p.id === last) && last) ||
        cloudProviders[0]?.id;
      if (id) void state.handleProviderSelect(id);
    }
  };

  const chooseCloud = (id: string) => {
    try {
      localStorage.setItem(LAST_CLOUD_KEY, id);
    } catch {
      // ignore
    }
    void state.handleProviderSelect(id);
  };

  // Recommended first, then the rest in catalog order.
  const localModels = useMemo(() => {
    const known = llm.models.filter((m) => MODEL_LOOK[m.id]);
    return [...known].sort((a, b) => {
      const ra = a.id === RECOMMENDED_LOCAL_MODEL ? 0 : 1;
      const rb = b.id === RECOMMENDED_LOCAL_MODEL ? 0 : 1;
      return ra - rb;
    });
  }, [llm.models]);
  // Always show what is downloaded, downloading or selected.
  const pinned = (id: string) => {
    const m = llm.models.find((x) => x.id === id);
    return !!m && (m.downloaded || m.downloading || id === selectedLocal);
  };
  const visibleLocal = showAll
    ? localModels
    : localModels.filter((m, i) => i < SHOWN_LOCAL || pinned(m.id));
  const hiddenCount = localModels.length - visibleLocal.length;

  const modelTitle = (id: string) => {
    const look = MODEL_LOOK[id];
    return look
      ? t(`settings.postProcessing.local.models.${look.key}.model`)
      : id;
  };

  const usedFor = [
    t("llm.status.files", {
      state: fileOptions.llmEnabled ? t("llm.status.on") : t("llm.status.off"),
    }),
    t("llm.status.dictation", {
      state: settings?.post_process_enabled
        ? t("llm.status.on")
        : t("llm.status.off"),
    }),
  ].join(" · ");

  const localState = llm.status?.state ?? "stopped";
  const localStateText = {
    stopped: t("settings.postProcessing.local.state.stopped"),
    loading: t("settings.postProcessing.local.state.loading"),
    ready: t("settings.postProcessing.local.state.ready"),
  }[localState];

  const whereOptions: {
    value: LlmWhere;
    title: string;
    text: string;
    disabled?: boolean;
    recommended?: boolean;
  }[] = [
    {
      value: "local",
      title: t("llm.where.local"),
      text: localAvailable
        ? t("llm.where.localText")
        : t("llm.where.localUnavailable"),
      disabled: !localAvailable,
      recommended: true,
    },
    {
      value: "server",
      title: t("llm.where.server"),
      text: t("llm.where.serverText"),
    },
    {
      value: "cloud",
      title: t("llm.where.cloud"),
      text: t("llm.where.cloudText"),
    },
  ];

  const refreshButton = (
    <Button
      variant="quiet"
      icon
      onClick={state.handleRefreshModels}
      disabled={state.isFetchingModels}
      aria-label={t("settings.postProcessing.api.model.refreshModels")}
      title={t("settings.postProcessing.api.model.refreshModels")}
    >
      <RefreshCcw
        aria-hidden="true"
        className={state.isFetchingModels ? "t-spinner" : ""}
      />
    </Button>
  );

  const modelRow = (
    <SettingContainer
      title={t("settings.postProcessing.api.model.title")}
      description={
        state.isCustomProvider
          ? t("settings.postProcessing.api.model.descriptionCustom")
          : t("settings.postProcessing.api.model.descriptionDefault")
      }
      layout="stacked"
    >
      <div className="flex items-center gap-2">
        <ModelSelect
          value={state.model}
          options={state.modelOptions}
          disabled={state.isModelUpdating}
          isLoading={state.isFetchingModels}
          placeholder={
            state.modelOptions.length > 0
              ? t("settings.postProcessing.api.model.placeholderWithOptions")
              : t("settings.postProcessing.api.model.placeholderNoOptions")
          }
          onSelect={state.handleModelSelect}
          onCreate={state.handleModelCreate}
          onBlur={() => {}}
        />
        {refreshButton}
      </div>
    </SettingContainer>
  );

  return (
    <Page section="llm" title={t("sidebar.llm")} purpose={t("llm.purpose")}>
      <div className="t-work t-wide">
        <div className="t-work-side">
          <SettingsGroup anchor="llm-status">
            <SettingContainer
              title={t("llm.status.usedFor")}
              description={usedFor}
            />
            {where === "local" &&
              providerId === LOCAL_PROVIDER_ID &&
              selectedLocal && (
                <SettingContainer
                  title={modelTitle(selectedLocal)}
                  description={localStateText}
                >
                  {localState === "ready" && (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => void llm.stop()}
                    >
                      {t("settings.postProcessing.local.unloadNow")}
                    </Button>
                  )}
                </SettingContainer>
              )}
          </SettingsGroup>
        </div>

        <div className="t-work-main">
          <SettingsGroup title={t("llm.where.title")} anchor="llm-where">
            <div role="radiogroup" aria-label={t("llm.where.title")}>
              {whereOptions.map((o, index) => {
                const checked = where === o.value;
                return (
                  <div
                    key={o.value}
                    className={`t-row ${index > 0 ? "t-row-sep" : ""} ${o.disabled ? "t-row-disabled" : ""}`}
                    role="radio"
                    aria-checked={checked}
                    aria-disabled={o.disabled || undefined}
                    tabIndex={checked ? 0 : -1}
                    onClick={() => !o.disabled && choose(o.value)}
                    onKeyDown={(e) => {
                      const enabled = whereOptions.filter((x) => !x.disabled);
                      const i = enabled.findIndex((x) => x.value === where);
                      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                        e.preventDefault();
                        choose(enabled[(i + 1) % enabled.length].value);
                      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                        e.preventDefault();
                        choose(
                          enabled[(i - 1 + enabled.length) % enabled.length]
                            .value,
                        );
                      } else if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        if (!o.disabled) choose(o.value);
                      }
                    }}
                  >
                    <span
                      className="t-radio"
                      data-checked={checked}
                      aria-hidden="true"
                    />
                    <div className="t-row-text">
                      <span className="t-row-label inline-flex items-center gap-2">
                        {o.title}
                        {o.recommended && (
                          <Tag>
                            {t("settings.postProcessing.local.recommended")}
                          </Tag>
                        )}
                      </span>
                      <div className="t-row-desc">{o.text}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsGroup>

          <SettingsGroup
            title={
              where === "local"
                ? t("llm.variant.local")
                : where === "server"
                  ? t("llm.variant.server")
                  : t("llm.variant.cloud")
            }
            anchor="llm-variant"
          >
            {where === "local" && providerId === APPLE_PROVIDER_ID && (
              <SettingContainer
                title="Apple Intelligence"
                extra={
                  state.appleIntelligenceUnavailable ? (
                    <ServiceLine kind="error">
                      {t(
                        "settings.postProcessing.api.appleIntelligence.unavailable",
                      )}
                    </ServiceLine>
                  ) : undefined
                }
              />
            )}
            {where === "local" && providerId === LOCAL_PROVIDER_ID && (
              <>
                {llm.status && !llm.status.runtime_available && (
                  <div className="t-block">
                    <Alert variant="error" contained>
                      {t("settings.postProcessing.local.runtimeMissing")}
                    </Alert>
                  </div>
                )}
                <div className="t-block">
                  <p className="t-type-caption t-text-secondary">
                    {t("settings.postProcessing.local.intro")}
                  </p>
                  <div className="t-list mt-1" role="list">
                    {visibleLocal.map((m, index) => (
                      <LocalModelRow
                        key={m.id}
                        id={m.id}
                        last={index === visibleLocal.length - 1}
                        selected={m.downloaded && m.id === selectedLocal}
                        downloaded={m.downloaded}
                        downloading={m.downloading}
                        percent={llm.progress[m.id]}
                        size={formatBytes(m.size_bytes, t, i18n.language)}
                        runtimeMissing={llm.status?.runtime_available === false}
                        onUse={() =>
                          void updatePostProcessModel(LOCAL_PROVIDER_ID, m.id)
                        }
                        onDownload={async () => {
                          const ok = await llm.download(m.id);
                          if (ok && !selectedLocal)
                            await updatePostProcessModel(
                              LOCAL_PROVIDER_ID,
                              m.id,
                            );
                        }}
                        onCancel={() => void llm.cancel(m.id)}
                        onParams={() => setParamsModelId(m.id)}
                        onDelete={() => setConfirmDelete(m.id)}
                      />
                    ))}
                  </div>
                  {(hiddenCount > 0 || showAll) && (
                    <div className="t-list-more">
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => setShowAll((s) => !s)}
                      >
                        {showAll
                          ? t("llm.local.showFewer")
                          : t("llm.local.showAll", { count: hiddenCount })}
                      </Button>
                    </div>
                  )}
                  {llm.error && (
                    <ServiceLine kind="error">{llm.error}</ServiceLine>
                  )}
                </div>
              </>
            )}
            {where === "server" && (
              <>
                <SettingContainer
                  title={t("settings.postProcessing.api.baseUrl.title")}
                  description={t("llm.server.urlDescription")}
                  layout="stacked"
                >
                  <BaseUrlField
                    value={state.baseUrl}
                    onBlur={state.handleBaseUrlChange}
                    placeholder={t(
                      "settings.postProcessing.api.baseUrl.placeholder",
                    )}
                    disabled={state.isBaseUrlUpdating}
                  />
                </SettingContainer>
                <SettingContainer
                  title={t("settings.postProcessing.api.apiKey.title")}
                  description={t("llm.server.keyDescription")}
                  layout="stacked"
                >
                  <ApiKeyField
                    value={state.apiKey}
                    onBlur={state.handleApiKeyChange}
                    placeholder={t(
                      "settings.postProcessing.api.apiKey.placeholder",
                    )}
                    disabled={state.isApiKeyUpdating}
                  />
                </SettingContainer>
                {modelRow}
              </>
            )}
            {where === "cloud" && (
              <>
                <SettingContainer
                  title={t("settings.postProcessing.api.provider.title")}
                  extra={
                    <ServiceLine kind="cloud">
                      {t("ui.llm.textToService", {
                        provider: state.selectedProvider?.label ?? providerId,
                      })}
                    </ServiceLine>
                  }
                >
                  <Dropdown
                    ariaLabel={t("settings.postProcessing.api.provider.title")}
                    options={cloudProviders.map((p) => ({
                      value: p.id,
                      label: p.label,
                    }))}
                    selectedValue={providerId}
                    onSelect={chooseCloud}
                  />
                </SettingContainer>
                <SettingContainer
                  title={t("settings.postProcessing.api.apiKey.title")}
                  description={t(
                    "settings.postProcessing.api.apiKey.description",
                  )}
                  layout="stacked"
                >
                  <ApiKeyField
                    value={state.apiKey}
                    onBlur={state.handleApiKeyChange}
                    placeholder={t(
                      "settings.postProcessing.api.apiKey.placeholder",
                    )}
                    disabled={state.isApiKeyUpdating}
                  />
                </SettingContainer>
                {modelRow}
              </>
            )}
          </SettingsGroup>

          {where === "local" && providerId === LOCAL_PROVIDER_ID && (
            <Fold
              id={MORE_FOLD}
              title={t("ui.fold.more")}
              changed={countChanged(settings, defaults, [
                "local_llm_unload_timeout",
              ])}
            >
              <SettingsGroup
                title={t("models.memory.title")}
                anchor="llm-memory"
              >
                <SettingContainer
                  settingKey="local_llm_unload_timeout"
                  title={t("settings.postProcessing.local.unload.title")}
                  description={t(
                    "settings.postProcessing.local.unload.description",
                  )}
                >
                  <Dropdown
                    ariaLabel={t("settings.postProcessing.local.unload.title")}
                    options={(
                      ["immediately", "min2", "min5", "min15", "never"] as const
                    ).map((value) => ({
                      value,
                      label: t(`settings.postProcessing.local.unload.${value}`),
                    }))}
                    selectedValue={unloadTimeout}
                    onSelect={(value) =>
                      updateSetting(
                        "local_llm_unload_timeout",
                        value as ModelUnloadTimeout,
                      )
                    }
                  />
                </SettingContainer>
              </SettingsGroup>
            </Fold>
          )}
        </div>
      </div>

      <LocalLlmModelSettingsDialog
        modelId={paramsModelId}
        modelName={paramsModelId ? modelTitle(paramsModelId) : ""}
        onClose={() => setParamsModelId(null)}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("ui.confirm.deleteLlmTitle", {
          name: confirmDelete ? modelTitle(confirmDelete) : "",
        })}
        confirmLabel={t("ui.confirm.deleteLlm")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(null);
          if (id) void llm.remove(id);
        }}
      >
        {t("ui.confirm.deleteLlmBody", {
          size: confirmDelete
            ? formatBytes(
                llm.models.find((m) => m.id === confirmDelete)?.size_bytes ?? 0,
                t,
                i18n.language,
              )
            : "",
        })}
      </ConfirmDialog>
    </Page>
  );
};

interface LocalModelRowProps {
  id: string;
  last: boolean;
  selected: boolean;
  downloaded: boolean;
  downloading: boolean;
  percent?: number;
  size: string;
  runtimeMissing: boolean;
  onUse: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onParams: () => void;
  onDelete: () => void;
}

const LocalModelRow: React.FC<LocalModelRowProps> = ({
  id,
  last,
  selected,
  downloaded,
  downloading,
  percent,
  size,
  runtimeMissing,
  onUse,
  onDownload,
  onCancel,
  onParams,
  onDelete,
}) => {
  const { t, i18n } = useTranslation();
  const menu = useMenu();
  const look = MODEL_LOOK[id];
  const base = `settings.postProcessing.local.models.${look.key}`;
  const name = t(`${base}.model`);
  const meta = [
    t("llm.local.speed", { n: look.speed }),
    t("llm.local.quality", { n: look.quality }),
    t("llm.local.footprint", {
      disk: size,
      ram: look.ramGb.toLocaleString(i18n.language),
    }),
  ].join(" · ");

  let acts: React.ReactNode;
  if (downloading) {
    acts = (
      <Button variant="quiet" size="sm" onClick={onCancel}>
        {t("ui.cancelDownload")}
      </Button>
    );
  } else if (downloaded) {
    acts = (
      <>
        {selected ? (
          <Tag>{t("models.row.inUse")}</Tag>
        ) : (
          <Button variant="secondary" size="sm" onClick={onUse}>
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
              label: t("settings.postProcessing.local.delete"),
              danger: true,
              separatorBefore: true,
              onSelect: onDelete,
            },
          ]}
        />
      </>
    );
  } else {
    acts = (
      <Button
        variant="secondary"
        size="sm"
        disabled={runtimeMissing}
        onClick={onDownload}
      >
        {t("ui.downloadSize", { size })}
      </Button>
    );
  }

  return (
    <div className={`t-item ${last ? "t-item-last" : ""}`} role="listitem">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="t-item-name">{name}</span>
          {look.recommended && (
            <Tag>{t("settings.postProcessing.local.recommended")}</Tag>
          )}
          {look.speedup && (
            <Tag title={t("settings.postProcessing.local.speedupHint")}>
              {t("settings.postProcessing.local.speedupBadge")}
            </Tag>
          )}
          {look.untested && (
            <Tag>{t("settings.postProcessing.local.untested")}</Tag>
          )}
        </div>
        <div className="t-item-meta">{meta}</div>
        <div className="t-row-desc">{t(`${base}.description`)}</div>
        {downloading && (
          <div className="mt-1">
            <div className="t-item-meta">
              {t("ui.downloadingPercent", {
                percent: Math.round(percent ?? 0),
              })}
            </div>
            <ProgressLine value={percent ?? 0} label={name} />
          </div>
        )}
      </div>
      <div className="t-item-acts">{acts}</div>
    </div>
  );
};
