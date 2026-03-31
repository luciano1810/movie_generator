import { useEffect, useRef, useState } from 'react';
import type {
  AppMeta,
  AppSettings,
  GeneratedAsset,
  LlmModelDiscoveryResponse,
  Project,
  ProjectSettings,
  ReferenceAssetItem,
  ReferenceAssetKind,
  ScriptMode,
  RunStage,
  StageId
} from '../shared/types';
import {
  ASPECT_RATIOS,
  DEFAULT_SETTINGS,
  getGenerationReferenceLibraryForShot,
  SCRIPT_MODES,
  STORY_LENGTH_LABELS,
  STORY_LENGTHS,
  STAGES,
  STAGE_LABELS
} from '../shared/types';
import { SettingsDialog } from './SettingsDialog';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const SHOT_REFERENCE_KINDS: ReferenceAssetKind[] = ['character', 'scene', 'object'];

interface ProjectDraft {
  title: string;
  sourceText: string;
  settings: ProjectSettings;
}

type MainTab = 'projects' | 'assets';
type AssetLibraryKind = 'image' | 'video' | 'final';
type AssetLibrarySection = 'outputs' | 'characters' | 'scenes' | 'objects';
type ResolutionPresetId = '540p' | '720p' | '1080p' | '1440p';
type ResolutionSelectValue = ResolutionPresetId | 'custom';
type ProjectPanelTab = StageId | 'logs';

interface LibraryAssetItem {
  id: string;
  kind: AssetLibraryKind;
  projectId: string;
  projectTitle: string;
  createdAt: string;
  relativePath: string;
  prompt: string;
  sceneNumber: number | null;
  shotId: string | null;
}

interface ReferenceLibraryAssetItem {
  id: string;
  kind: ReferenceAssetKind;
  itemId: string;
  projectId: string;
  projectTitle: string;
  createdAt: string;
  relativePath: string;
  prompt: string;
  name: string;
  summary: string;
}

interface ShotAudioPromptDraft {
  backgroundSoundPrompt: string;
  speechPrompt: string;
}

interface ShotTechnicalDraft {
  durationSeconds: string;
  firstFramePrompt: string;
  lastFramePrompt: string;
  transitionHint: string;
}

interface ReferenceLibraryPickerProps {
  assets: ReferenceLibraryAssetItem[];
  disabled: boolean;
  selectedValue: string;
  onChange: (value: string) => void;
}

const ASPECT_RATIO_LABELS: Record<ProjectSettings['aspectRatio'], string> = {
  '21:9': '21:9 超宽横屏',
  '16:9': '16:9 横屏',
  '4:3': '4:3 经典横屏',
  '3:2': '3:2 胶片横屏',
  '1:1': '1:1 方屏',
  '2:3': '2:3 海报竖屏',
  '3:4': '3:4 经典竖屏',
  '9:16': '9:16 手机竖屏'
};

const SCRIPT_MODE_LABELS: Record<ScriptMode, string> = {
  generate: '生成新剧本',
  optimize: '优化已有剧本'
};

const TAB_LABELS: Record<ProjectPanelTab, string> = {
  script: '剧本生成',
  storyboard: '分镜生成',
  assets: '资产生成',
  shots: '镜头生成',
  edit: '视频剪辑',
  logs: '执行日志'
};

const TAB_DESCRIPTIONS: Record<ProjectPanelTab, string> = {
  script: '根据输入文案生成或优化完整短剧剧本。',
  storyboard: '基于剧本拆分镜头，输出镜头信息、长镜头承接标识和镜头生成描述。',
  assets: '提取角色、场景、物品候选，并批量生成参考资产。',
  shots: '为每个镜头先生成参考帧，再立即生成对应视频片段。',
  edit: '拼接视频片段，输出最终成片。',
  logs: '查看整个项目流水线的实时执行日志和错误信息。'
};

const RESOLUTION_PRESETS: Array<{
  id: ResolutionPresetId;
  label: string;
  width: number;
  height: number;
}> = [
  {
    id: '540p',
    label: '540p · 960×540',
    width: 960,
    height: 540
  },
  {
    id: '720p',
    label: '720p · 1280×720',
    width: 1280,
    height: 720
  },
  {
    id: '1080p',
    label: '1080p · 1920×1080',
    width: 1920,
    height: 1080
  },
  {
    id: '1440p',
    label: '1440p · 2560×1440',
    width: 2560,
    height: 1440
  }
];

function apiPath(pathname: string): string {
  return API_BASE ? `${API_BASE}${pathname}` : pathname;
}

function assetUrl(relativePath: string): string {
  return apiPath(`/storage/${relativePath}`);
}

function finalVideoDownloadUrl(projectId: string): string {
  return apiPath(`/api/projects/${projectId}/final-video/download`);
}

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(pathname), {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const message = await response
      .json()
      .then((payload) => payload?.message as string | undefined)
      .catch(() => undefined);
    throw new Error(message ?? `请求失败: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('读取文件失败'));
        return;
      }

      resolve(reader.result);
    };
    reader.onerror = () => {
      reject(new Error('读取文件失败'));
    };
    reader.readAsDataURL(file);
  });
}

function createDraft(project: Project): ProjectDraft {
  return {
    title: project.title,
    sourceText: project.sourceText,
    settings: { ...project.settings }
  };
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) {
    return '-';
  }

  return new Date(iso).toLocaleString('zh-CN', {
    hour12: false
  });
}

function formatShotTimeline(shot: Pick<Project['storyboard'][number], 'startTimecode' | 'endTimecode' | 'durationSeconds'>): string {
  return `${shot.startTimecode} - ${shot.endTimecode} · ${shot.durationSeconds}s`;
}

function formatDialogueIdentifier(
  shot: Pick<Project['storyboard'][number], 'dialogueIdentifier'>
): string {
  if (!shot.dialogueIdentifier?.groupId) {
    return '无';
  }

  const flowRoleLabel =
    shot.dialogueIdentifier.flowRole === 'single'
      ? '单镜'
      : shot.dialogueIdentifier.flowRole === 'start'
        ? '起始'
        : shot.dialogueIdentifier.flowRole === 'middle'
          ? '中段'
          : '结束';

  return `${shot.dialogueIdentifier.groupId} · ${flowRoleLabel} ${shot.dialogueIdentifier.sequenceIndex}/${shot.dialogueIdentifier.sequenceLength}`;
}

function formatLongTakeIdentifier(
  shot: Pick<Project['storyboard'][number], 'longTakeIdentifier'>
): string {
  return shot.longTakeIdentifier?.trim() ? shot.longTakeIdentifier : '无';
}

function isLongTakeContinuationShot(project: Project, shot: Project['storyboard'][number]): boolean {
  const shotIndex = project.storyboard.findIndex((item) => item.id === shot.id);

  if (shotIndex <= 0) {
    return false;
  }

  const previousShot = project.storyboard[shotIndex - 1];
  return Boolean(shot.longTakeIdentifier && previousShot?.longTakeIdentifier === shot.longTakeIdentifier);
}

function truncateText(value: string | null | undefined, maxLength = 88): string {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return '暂无内容';
  }

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(maxLength - 1, 0)).trimEnd()}...`;
}

function referenceSelectionId(kind: ReferenceAssetKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

function getReferenceItemPreviewAsset(item: ReferenceAssetItem): GeneratedAsset | null {
  return item.asset ?? item.referenceImage;
}

function getShotPreviewAsset(
  project: Project,
  shot: Project['storyboard'][number],
  imageAsset: GeneratedAsset | null
): GeneratedAsset | null {
  if (imageAsset) {
    return imageAsset;
  }

  return getShotReferencePreviewItems(project, shot)[0]?.asset ?? null;
}

function parsePositiveIntegerDraft(value: string): number | null {
  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildShotTechnicalDraft(
  shot: Project['storyboard'][number],
  existing: ShotTechnicalDraft | undefined,
  patch: Partial<ShotTechnicalDraft>
): ShotTechnicalDraft {
  return {
    durationSeconds: patch.durationSeconds ?? existing?.durationSeconds ?? String(shot.durationSeconds),
    firstFramePrompt: patch.firstFramePrompt ?? existing?.firstFramePrompt ?? shot.firstFramePrompt,
    lastFramePrompt: patch.lastFramePrompt ?? existing?.lastFramePrompt ?? shot.lastFramePrompt,
    transitionHint: patch.transitionHint ?? existing?.transitionHint ?? shot.transitionHint
  };
}

function statusLabel(status: Project['stages'][StageId]['status']): string {
  if (status === 'idle') {
    return '未执行';
  }
  if (status === 'running') {
    return '执行中';
  }
  if (status === 'success') {
    return '成功';
  }
  return '失败';
}

function parseAspectRatio(aspectRatio: ProjectSettings['aspectRatio']): { width: number; height: number } {
  const [width, height] = aspectRatio.split(':').map(Number);
  return { width, height };
}

function aspectRatioDirectionLabel(aspectRatio: ProjectSettings['aspectRatio']): string {
  const { width, height } = parseAspectRatio(aspectRatio);

  if (width === height) {
    return '方屏';
  }

  return width > height ? '横屏' : '竖屏';
}

function roundToEven(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function buildDimensionsForAspectRatio(
  baseWidth: number,
  baseHeight: number,
  aspectRatio: ProjectSettings['aspectRatio']
): { width: number; height: number } {
  const { width: ratioWidth, height: ratioHeight } = parseAspectRatio(aspectRatio);
  const longEdge = Math.max(baseWidth, baseHeight);
  const shortEdge = Math.min(baseWidth, baseHeight);

  if (ratioWidth === ratioHeight) {
    return {
      width: shortEdge,
      height: shortEdge
    };
  }

  if (ratioWidth > ratioHeight) {
    return {
      width: longEdge,
      height: roundToEven((longEdge * ratioHeight) / ratioWidth)
    };
  }

  return {
    width: roundToEven((longEdge * ratioWidth) / ratioHeight),
    height: longEdge
  };
}

function applyAspectRatio(settings: ProjectSettings, aspectRatio: ProjectSettings['aspectRatio']): ProjectSettings {
  const imageDimensions = buildDimensionsForAspectRatio(settings.imageWidth, settings.imageHeight, aspectRatio);
  const videoDimensions = buildDimensionsForAspectRatio(settings.videoWidth, settings.videoHeight, aspectRatio);

  return {
    ...settings,
    aspectRatio,
    imageWidth: imageDimensions.width,
    imageHeight: imageDimensions.height,
    videoWidth: videoDimensions.width,
    videoHeight: videoDimensions.height
  };
}

function getResolutionPreset(presetId: ResolutionPresetId) {
  const preset = RESOLUTION_PRESETS.find((item) => item.id === presetId);

  if (!preset) {
    throw new Error(`未知分辨率预设: ${presetId}`);
  }

  return preset;
}

function applyResolutionPreset(settings: ProjectSettings, presetId: ResolutionPresetId): ProjectSettings {
  const preset = getResolutionPreset(presetId);
  const imageDimensions = buildDimensionsForAspectRatio(preset.width, preset.height, settings.aspectRatio);
  const videoDimensions = buildDimensionsForAspectRatio(preset.width, preset.height, settings.aspectRatio);

  return {
    ...settings,
    imageWidth: imageDimensions.width,
    imageHeight: imageDimensions.height,
    videoWidth: videoDimensions.width,
    videoHeight: videoDimensions.height
  };
}

function inferResolutionPreset(settings: Pick<ProjectSettings, 'aspectRatio' | 'imageWidth' | 'imageHeight' | 'videoWidth' | 'videoHeight'>): ResolutionSelectValue {
  const matchedPreset = RESOLUTION_PRESETS.find((preset) => {
    const imageDimensions = buildDimensionsForAspectRatio(preset.width, preset.height, settings.aspectRatio);
    const videoDimensions = buildDimensionsForAspectRatio(preset.width, preset.height, settings.aspectRatio);

    return (
      settings.imageWidth === imageDimensions.width &&
      settings.imageHeight === imageDimensions.height &&
      settings.videoWidth === videoDimensions.width &&
      settings.videoHeight === videoDimensions.height
    );
  });

  return matchedPreset?.id ?? 'custom';
}

function resolveDefaultResolutionPreset(
  settings: Pick<ProjectSettings, 'aspectRatio' | 'imageWidth' | 'imageHeight' | 'videoWidth' | 'videoHeight'>
): ResolutionPresetId {
  const preset = inferResolutionPreset(settings);
  return preset === 'custom' ? '720p' : preset;
}

function scriptModeSourcePlaceholder(scriptMode: ScriptMode): string {
  return scriptMode === 'generate'
    ? '输入故事梗概、角色设定、营销文案或剧情点子'
    : '输入已有剧本、分场粗稿、对白草稿或待优化文案';
}

function buildCreateProjectSettings(
  defaults: ProjectSettings,
  aspectRatio: ProjectSettings['aspectRatio'],
  scriptMode: ScriptMode,
  storyLength: ProjectSettings['storyLength'],
  resolutionPreset: ResolutionPresetId
): Partial<ProjectSettings> {
  return applyResolutionPreset(
    {
      ...defaults,
      scriptMode,
      storyLength,
      aspectRatio
    },
    resolutionPreset
  );
}

function createFormatSummary(settings: Partial<ProjectSettings>): string {
  if (!settings.aspectRatio) {
    return '未设置画幅';
  }

  return `${aspectRatioDirectionLabel(settings.aspectRatio)} ${settings.aspectRatio}｜图片 ${settings.imageWidth}×${settings.imageHeight}｜视频 ${settings.videoWidth}×${settings.videoHeight}`;
}

function assetKindLabel(kind: AssetLibraryKind): string {
  if (kind === 'image') {
    return '图片';
  }

  if (kind === 'video') {
    return '视频片段';
  }

  return '完整成片';
}

function referenceKindLabel(kind: ReferenceAssetKind): string {
  if (kind === 'character') {
    return '角色';
  }

  if (kind === 'scene') {
    return '场景';
  }

  return '物品';
}

function referenceCollectionLabel(section: AssetLibrarySection): string {
  if (section === 'characters') {
    return '角色';
  }

  if (section === 'scenes') {
    return '场景';
  }

  if (section === 'objects') {
    return '物品';
  }

  return '流程产物';
}

function libraryAssetLocationLabel(asset: Pick<LibraryAssetItem, 'sceneNumber' | 'shotId'>): string {
  const parts: string[] = [];

  if (asset.sceneNumber != null) {
    parts.push(`场景 ${asset.sceneNumber}`);
  }

  if (asset.shotId) {
    parts.push(asset.shotId);
  }

  return parts.length ? parts.join(' · ') : '完整项目输出';
}

function buildLibraryAssets(projects: Project[]): LibraryAssetItem[] {
  return projects
    .flatMap((project) => [
      ...project.assets.images.map((asset, index) => ({
        id: `${project.id}-image-${asset.shotId ?? index}`,
        kind: 'image' as const,
        projectId: project.id,
        projectTitle: project.title,
        createdAt: asset.createdAt,
        relativePath: asset.relativePath,
        prompt: asset.prompt,
        sceneNumber: asset.sceneNumber,
        shotId: asset.shotId
      })),
      ...project.assets.videos.map((asset, index) => ({
        id: `${project.id}-video-${asset.shotId ?? index}`,
        kind: 'video' as const,
        projectId: project.id,
        projectTitle: project.title,
        createdAt: asset.createdAt,
        relativePath: asset.relativePath,
        prompt: asset.prompt,
        sceneNumber: asset.sceneNumber,
        shotId: asset.shotId
      })),
      ...(project.assets.finalVideo
        ? [
            {
              id: `${project.id}-final`,
              kind: 'final' as const,
              projectId: project.id,
              projectTitle: project.title,
              createdAt: project.assets.finalVideo.createdAt,
              relativePath: project.assets.finalVideo.relativePath,
              prompt: project.assets.finalVideo.prompt,
              sceneNumber: null,
              shotId: null
            }
          ]
        : [])
    ])
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function getReferenceCollection(project: Project, kind: ReferenceAssetKind): ReferenceAssetItem[] {
  if (kind === 'character') {
    return project.referenceLibrary.characters;
  }

  if (kind === 'scene') {
    return project.referenceLibrary.scenes;
  }

  return project.referenceLibrary.objects;
}

function buildReferenceLibraryAssets(
  projects: Project[],
  kind: ReferenceAssetKind
): ReferenceLibraryAssetItem[] {
  return projects
    .flatMap((project) =>
      getReferenceCollection(project, kind)
        .filter((item) => item.asset)
        .map((item) => ({
          id: `${project.id}-${kind}-${item.id}`,
          kind,
          itemId: item.id,
          projectId: project.id,
          projectTitle: project.title,
          createdAt: item.asset!.createdAt,
          relativePath: item.asset!.relativePath,
          prompt: item.asset!.prompt || item.generationPrompt,
          name: item.name,
          summary: item.summary
        }))
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function referenceDraftKey(kind: ReferenceAssetKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

function referenceLibrarySelectionKey(kind: ReferenceAssetKind, itemId: string): string {
  return `library:${kind}:${itemId}`;
}

function referenceLibraryAssetValue(asset: Pick<ReferenceLibraryAssetItem, 'projectId' | 'kind' | 'itemId'>): string {
  return `${asset.projectId}::${asset.kind}::${asset.itemId}`;
}

function resolveReferenceLibrarySelection(
  assets: ReferenceLibraryAssetItem[],
  preferredValue?: string
): string {
  if (!assets.length) {
    return '';
  }

  if (preferredValue && assets.some((asset) => referenceLibraryAssetValue(asset) === preferredValue)) {
    return preferredValue;
  }

  return referenceLibraryAssetValue(assets[0]);
}

function ReferenceLibraryPicker({
  assets,
  disabled,
  selectedValue,
  onChange
}: ReferenceLibraryPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedAsset = assets.find((asset) => referenceLibraryAssetValue(asset) === selectedValue) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }

      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if ((disabled || !assets.length) && open) {
      setOpen(false);
    }
  }, [assets.length, disabled, open]);

  return (
    <div className="asset-picker" ref={rootRef}>
      <button
        className={`asset-picker-trigger ${open ? 'open' : ''}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled || !assets.length}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {selectedAsset ? (
          <>
            <img
              className="asset-picker-thumb"
              src={assetUrl(selectedAsset.relativePath)}
              alt=""
              aria-hidden="true"
            />
            <span className="asset-picker-copy">
              <strong>{selectedAsset.name}</strong>
              <small>{selectedAsset.projectTitle}</small>
              <span>{formatTime(selectedAsset.createdAt)}</span>
            </span>
            <span className="asset-picker-chevron" aria-hidden="true">
              ▾
            </span>
          </>
        ) : (
          <>
            <span className="asset-picker-copy asset-picker-placeholder">
              <strong>当前资产库没有可直接选用的同类素材</strong>
            </span>
            <span className="asset-picker-chevron" aria-hidden="true">
              ▾
            </span>
          </>
        )}
      </button>

      {open && assets.length ? (
        <div className="asset-picker-menu" role="listbox">
          {assets.map((asset) => {
            const value = referenceLibraryAssetValue(asset);
            const isSelected = value === selectedValue;

            return (
              <button
                key={value}
                className={`asset-picker-option ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  onChange(value);
                  setOpen(false);
                }}
                role="option"
                aria-selected={isSelected}
                type="button"
              >
                <img className="asset-picker-thumb" src={assetUrl(asset.relativePath)} alt="" aria-hidden="true" />
                <span className="asset-picker-copy">
                  <strong>{asset.name}</strong>
                  <small>{asset.projectTitle}</small>
                  <span>{asset.summary}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function isStageTab(tab: ProjectPanelTab): tab is StageId {
  return STAGES.includes(tab as StageId);
}

function allReferenceItems(project: Project): ReferenceAssetItem[] {
  return [...project.referenceLibrary.characters, ...project.referenceLibrary.scenes, ...project.referenceLibrary.objects];
}

function countGeneratedReferenceAssets(project: Project): number {
  return allReferenceItems(project).filter((item) => item.asset).length;
}

function getShotReferencePreviewItems(
  project: Project,
  shot: Project['storyboard'][number]
): Array<{
  kind: ReferenceAssetKind;
  itemId: string;
  name: string;
  summary: string;
  asset: GeneratedAsset;
}> {
  const referenceLibrary = getGenerationReferenceLibraryForShot(project.referenceLibrary, shot, project.script);
  const previewItems: Array<{
    kind: ReferenceAssetKind;
    itemId: string;
    name: string;
    summary: string;
    asset: GeneratedAsset;
  }> = [];

  for (const [kind, items] of [
    ['scene', referenceLibrary.scenes],
    ['character', referenceLibrary.characters],
    ['object', referenceLibrary.objects]
  ] as Array<[ReferenceAssetKind, ReferenceAssetItem[]]>) {
    for (const item of items) {
      if (!item.asset) {
        continue;
      }

      previewItems.push({
        kind,
        itemId: item.id,
        name: item.name,
        summary: item.summary,
        asset: item.asset
      });
    }
  }

  return previewItems;
}

function buildCurrentProjectReferenceAssets(project: Project): ReferenceLibraryAssetItem[] {
  return SHOT_REFERENCE_KINDS
    .flatMap((kind) => buildReferenceLibraryAssets([project], kind))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function getReferenceAssetVersions(item: ReferenceAssetItem): GeneratedAsset[] {
  return item.asset ? [item.asset, ...item.assetHistory] : [];
}

function getShotAssetVersions(project: Project, stage: 'images' | 'videos', shotId: string): GeneratedAsset[] {
  const activeAsset =
    stage === 'images'
      ? project.assets.images.find((asset) => asset.shotId === shotId) ?? null
      : project.assets.videos.find((asset) => asset.shotId === shotId) ?? null;
  const history = stage === 'images' ? project.assets.imageHistory[shotId] ?? [] : project.assets.videoHistory[shotId] ?? [];

  return activeAsset ? [activeAsset, ...history] : history;
}

function getReferenceLibraryAssetPool(
  kind: ReferenceAssetKind,
  assets: {
    character: ReferenceLibraryAssetItem[];
    scene: ReferenceLibraryAssetItem[];
    object: ReferenceLibraryAssetItem[];
  }
): ReferenceLibraryAssetItem[] {
  if (kind === 'character') {
    return assets.character;
  }

  if (kind === 'scene') {
    return assets.scene;
  }

  return assets.object;
}

function inferProjectStageTab(project: Project): StageId {
  if (!project.script) {
    return 'script';
  }

  if (!project.storyboard.length) {
    return 'storyboard';
  }

  if (!project.artifacts.referenceLibraryJson || countGeneratedReferenceAssets(project) === 0) {
    return 'assets';
  }

  if (!project.assets.videos.length) {
    return 'shots';
  }

  return 'edit';
}

function nextProjectStage(project: Project): StageId {
  return STAGES.find((stage) => project.stages[stage].status !== 'success') ?? inferProjectStageTab(project);
}

function projectCardStatus(project: Project): {
  badge: string;
  badgeTone: '' | 'running' | 'success';
  detail: string;
} {
  if (project.runState.isRunning) {
    return {
      badge: '运行中',
      badgeTone: 'running',
      detail: project.runState.currentStage
        ? `当前阶段 · ${STAGE_LABELS[project.runState.currentStage]}${
            project.runState.stopRequested ? '（停止中）' : project.runState.pauseRequested ? '（暂停中）' : ''
          }`
        : project.runState.stopRequested
          ? '当前阶段 · 排队中（停止中）'
          : project.runState.pauseRequested
            ? '当前阶段 · 排队中（暂停中）'
          : '当前阶段 · 排队中'
    };
  }

  if (project.runState.isPaused) {
    return {
      badge: '已暂停',
      badgeTone: 'running',
      detail: `等待继续 · ${STAGE_LABELS[nextProjectStage(project)]}`
    };
  }

  if (project.assets.finalVideo) {
    return {
      badge: '已完成',
      badgeTone: 'success',
      detail: '已导出最终成片'
    };
  }

  return {
    badge: '待处理',
    badgeTone: '',
    detail: `下一步 · ${STAGE_LABELS[inferProjectStageTab(project)]}`
  };
}

export function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [activeTab, setActiveTab] = useState<MainTab>('projects');
  const [projectStageTab, setProjectStageTab] = useState<ProjectPanelTab>('script');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [assetLibrarySection, setAssetLibrarySection] = useState<AssetLibrarySection>('outputs');
  const [assetFilter, setAssetFilter] = useState<'all' | AssetLibraryKind>('all');
  const [selectedLibraryOutputId, setSelectedLibraryOutputId] = useState('');
  const [selectedLibraryReferenceId, setSelectedLibraryReferenceId] = useState('');
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [llmModels, setLlmModels] = useState<string[]>([]);
  const [llmModelsPending, setLlmModelsPending] = useState(false);
  const [llmModelsError, setLlmModelsError] = useState('');
  const [llmModelsReloadKey, setLlmModelsReloadKey] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [referencePromptDrafts, setReferencePromptDrafts] = useState<Record<string, string>>({});
  const [referenceEthnicityDrafts, setReferenceEthnicityDrafts] = useState<Record<string, string>>({});
  const [referenceLibrarySelections, setReferenceLibrarySelections] = useState<Record<string, string>>({});
  const [shotReferenceLibrarySelections, setShotReferenceLibrarySelections] = useState<Record<string, string>>({});
  const [referenceAssetVersionIndices, setReferenceAssetVersionIndices] = useState<Record<string, number>>({});
  const [imageAssetVersionIndices, setImageAssetVersionIndices] = useState<Record<string, number>>({});
  const [videoAssetVersionIndices, setVideoAssetVersionIndices] = useState<Record<string, number>>({});
  const [videoPromptDrafts, setVideoPromptDrafts] = useState<Record<string, string>>({});
  const [audioPromptDrafts, setAudioPromptDrafts] = useState<Record<string, ShotAudioPromptDraft>>({});
  const [technicalPromptDrafts, setTechnicalPromptDrafts] = useState<Record<string, ShotTechnicalDraft>>({});
  const [selectedReferenceItemId, setSelectedReferenceItemId] = useState('');
  const [selectedStoryboardShotId, setSelectedStoryboardShotId] = useState('');
  const [selectedImageShotId, setSelectedImageShotId] = useState('');
  const [selectedVideoShotId, setSelectedVideoShotId] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createSource, setCreateSource] = useState('');
  const [createScriptMode, setCreateScriptMode] = useState<ScriptMode>(DEFAULT_SETTINGS.scriptMode);
  const [createStoryLength, setCreateStoryLength] = useState<ProjectSettings['storyLength']>(
    DEFAULT_SETTINGS.storyLength
  );
  const [createAspectRatio, setCreateAspectRatio] = useState<ProjectSettings['aspectRatio']>(
    DEFAULT_SETTINGS.aspectRatio
  );
  const [createResolutionPreset, setCreateResolutionPreset] = useState<ResolutionPresetId>(
    resolveDefaultResolutionPreset(DEFAULT_SETTINGS)
  );
  const [notice, setNotice] = useState<string>('');
  const [pending, setPending] = useState<string>('');

  function clearProjectWorkspace() {
    setSelectedId(null);
    setProject(null);
    setDraft(null);
    setProjectSettingsOpen(false);
    setDraftDirty(false);
    setReferencePromptDrafts({});
    setReferenceEthnicityDrafts({});
    setReferenceLibrarySelections({});
    setShotReferenceLibrarySelections({});
    setReferenceAssetVersionIndices({});
    setImageAssetVersionIndices({});
    setVideoAssetVersionIndices({});
    setVideoPromptDrafts({});
    setAudioPromptDrafts({});
    setTechnicalPromptDrafts({});
    setSelectedReferenceItemId('');
    setSelectedStoryboardShotId('');
    setSelectedImageShotId('');
    setSelectedVideoShotId('');
  }

  function handleOpenProject(projectId: string) {
    setActiveTab('projects');
    setProject(null);
    setDraft(null);
    setProjectSettingsOpen(false);
    setDraftDirty(false);
    setReferencePromptDrafts({});
    setReferenceEthnicityDrafts({});
    setReferenceLibrarySelections({});
    setShotReferenceLibrarySelections({});
    setReferenceAssetVersionIndices({});
    setImageAssetVersionIndices({});
    setVideoAssetVersionIndices({});
    setVideoPromptDrafts({});
    setAudioPromptDrafts({});
    setTechnicalPromptDrafts({});
    setSelectedReferenceItemId('');
    setSelectedStoryboardShotId('');
    setSelectedImageShotId('');
    setSelectedVideoShotId('');
    setSelectedId(projectId);
  }

  async function loadMeta() {
    setMeta(await requestJson<AppMeta>('/api/meta'));
  }

  async function loadAppSettings() {
    const nextSettings = await requestJson<AppSettings>('/api/app-settings');
    setAppSettings(nextSettings);
    setSettingsDraft(nextSettings);
    setSettingsDirty(false);
  }

  async function loadProjects(preferredId?: string) {
    const nextProjects = await requestJson<Project[]>('/api/projects');
    setProjects(nextProjects);

    const nextSelectedId = preferredId ?? selectedId;
    if (!nextProjects.length) {
      clearProjectWorkspace();
      return;
    }

    if (nextSelectedId && nextProjects.some((item) => item.id === nextSelectedId)) {
      if (selectedId !== nextSelectedId) {
        setSelectedId(nextSelectedId);
      }
      return;
    }

    clearProjectWorkspace();
  }

  async function loadProject(projectId: string, silent = false, preserveDraft = false) {
    try {
      const nextProject = await requestJson<Project>(`/api/projects/${projectId}`);
      setProject(nextProject);
      setDraft((current) => {
        if (preserveDraft && current) {
          return current;
        }

        return createDraft(nextProject);
      });
      if (!preserveDraft) {
        setDraftDirty(false);
      }
    } catch (error) {
      if (!silent) {
        setNotice(error instanceof Error ? error.message : '加载项目失败');
      }
    }
  }

  useEffect(() => {
    void Promise.all([loadMeta(), loadProjects(), loadAppSettings()]);
  }, []);

  useEffect(() => {
    if (!meta) {
      return;
    }

    setCreateScriptMode(meta.defaults.scriptMode);
    setCreateAspectRatio(meta.defaults.aspectRatio);
    setCreateResolutionPreset(resolveDefaultResolutionPreset(meta.defaults));
  }, [meta]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    setReferencePromptDrafts({});
    setReferenceEthnicityDrafts({});
    setReferenceLibrarySelections({});
    setShotReferenceLibrarySelections({});
    setImageAssetVersionIndices({});
    setVideoAssetVersionIndices({});
    setVideoPromptDrafts({});
    setAudioPromptDrafts({});
    setTechnicalPromptDrafts({});
    setSelectedReferenceItemId('');
    setSelectedStoryboardShotId('');
    setSelectedImageShotId('');
    setSelectedVideoShotId('');
    void loadProject(selectedId, false, false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProjects(selectedId);
      void loadProject(selectedId, true, draftDirty);
    }, 3000);

    return () => window.clearInterval(timer);
  }, [draftDirty, selectedId]);

  useEffect(() => {
    if (activeTab !== 'assets') {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProjects(selectedId ?? undefined);
    }, 3000);

    return () => window.clearInterval(timer);
  }, [activeTab, selectedId]);

  useEffect(() => {
    if (!project) {
      return;
    }

    setProjectStageTab(inferProjectStageTab(project));
  }, [project?.id]);

  useEffect(() => {
    if (!project?.runState.currentStage) {
      return;
    }

    setProjectStageTab(project.runState.currentStage);
  }, [project?.runState.currentStage]);

  useEffect(() => {
    if (projectStageTab !== 'shots' || !project?.storyboard.length) {
      return;
    }

    const availableShotIds = new Set(project.storyboard.map((shot) => shot.id));
    const sharedShotId =
      (selectedImageShotId && availableShotIds.has(selectedImageShotId) ? selectedImageShotId : null) ??
      (selectedVideoShotId && availableShotIds.has(selectedVideoShotId) ? selectedVideoShotId : null) ??
      project.storyboard[0]?.id ??
      '';

    if (selectedImageShotId !== sharedShotId) {
      setSelectedImageShotId(sharedShotId);
    }

    if (selectedVideoShotId !== sharedShotId) {
      setSelectedVideoShotId(sharedShotId);
    }
  }, [project?.storyboard, projectStageTab, selectedImageShotId, selectedVideoShotId]);

  useEffect(() => {
    if (!project) {
      setSelectedReferenceItemId('');
      setSelectedStoryboardShotId('');
      setSelectedImageShotId('');
      setSelectedVideoShotId('');
      return;
    }

    const nextReferenceSelectionIds = (
      [
        ['character', project.referenceLibrary.characters],
        ['scene', project.referenceLibrary.scenes],
        ['object', project.referenceLibrary.objects]
      ] as Array<[ReferenceAssetKind, ReferenceAssetItem[]]>
    ).flatMap(([kind, items]) => items.map((item) => referenceSelectionId(kind, item.id)));
    const nextShotIds = project.storyboard.map((shot) => shot.id);

    setSelectedReferenceItemId((current) =>
      current && nextReferenceSelectionIds.includes(current) ? current : nextReferenceSelectionIds[0] ?? ''
    );
    setSelectedStoryboardShotId((current) => (current && nextShotIds.includes(current) ? current : nextShotIds[0] ?? ''));
    setSelectedImageShotId((current) => (current && nextShotIds.includes(current) ? current : nextShotIds[0] ?? ''));
    setSelectedVideoShotId((current) => (current && nextShotIds.includes(current) ? current : nextShotIds[0] ?? ''));
  }, [project]);

  useEffect(() => {
    if (!settingsOpen || !settingsDraft) {
      return;
    }

    const baseUrl = settingsDraft.llm.baseUrl.trim();
    const apiKey = settingsDraft.llm.apiKey.trim();

    if (!baseUrl || !apiKey) {
      setLlmModels([]);
      setLlmModelsPending(false);
      setLlmModelsError('');
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLlmModelsPending(true);
      setLlmModelsError('');

      void requestJson<LlmModelDiscoveryResponse>('/api/llm-models/discover', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl,
          apiKey
        }),
        signal: controller.signal
      })
        .then((response) => {
          if (controller.signal.aborted) {
            return;
          }

          setLlmModels(response.models);
          setLlmModelsError(response.models.length ? '' : '接口未返回可用模型');
        })
        .catch((error) => {
          if (controller.signal.aborted) {
            return;
          }

          setLlmModels([]);
          setLlmModelsError(error instanceof Error ? error.message : '获取模型列表失败');
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLlmModelsPending(false);
          }
        });
    }, 700);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    llmModelsReloadKey,
    settingsDraft?.llm.apiKey,
    settingsDraft?.llm.baseUrl,
    settingsOpen
  ]);

  async function handleCreateProject() {
    const createSettings = buildCreateProjectSettings(
      meta?.defaults ?? DEFAULT_SETTINGS,
      createAspectRatio,
      createScriptMode,
      createStoryLength,
      createResolutionPreset
    );

    try {
      setPending('create');
      const created = await requestJson<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          title: createTitle,
          sourceText: createSource,
          settings: createSettings
        })
      });

      setCreateTitle('');
      setCreateSource('');
      setCreateStoryLength(DEFAULT_SETTINGS.storyLength);
      setCreateProjectOpen(false);
      setNotice('项目已创建');
      await loadProjects(created.id);
      setActiveTab('projects');
      setSelectedId(created.id);
      setProject(created);
      setDraft(createDraft(created));
      setDraftDirty(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建项目失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveProject(options?: { closeAfterSave?: boolean }) {
    if (!selectedId || !draft) {
      return;
    }

    try {
      setPending('save');
      const updated = await requestJson<Project>(`/api/projects/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify(draft)
      });

      setProject(updated);
      setDraft(createDraft(updated));
      setDraftDirty(false);
      if (options?.closeAfterSave) {
        setProjectSettingsOpen(false);
      }
      setNotice('项目参数已保存');
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setPending('');
    }
  }

  async function handleDeleteProject(projectId: string, title: string) {
    const confirmed = window.confirm(
      `确认删除项目“${title}”吗？此操作会移除该项目的全部分镜、素材和导出文件，且不可恢复。`
    );

    if (!confirmed) {
      return;
    }

    try {
      setPending(`delete-project:${projectId}`);
      await requestJson<{ ok: true }>(`/api/projects/${projectId}`, {
        method: 'DELETE'
      });

      if (selectedId === projectId) {
        clearProjectWorkspace();
        setActiveTab('projects');
        setProjectStageTab('script');
        await loadProjects();
      } else {
        await loadProjects(selectedId ?? undefined);
      }

      setNotice(`项目“${title}”已删除`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除项目失败');
    } finally {
      setPending('');
    }
  }

  async function handleRunStage(stage: RunStage) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(stage);
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/run`, {
        method: 'POST',
        body: JSON.stringify({ stage })
      });
      setNotice(stage === 'all' ? '已提交全流程任务' : `已提交 ${STAGE_LABELS[stage as StageId]} 任务`);
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '执行失败');
    } finally {
      setPending('');
    }
  }

  async function handlePauseProjectRun() {
    if (!selectedId) {
      return;
    }

    try {
      setPending('pause-all');
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/pause`, {
        method: 'POST'
      });
      setNotice('已请求暂停；系统会在当前阶段安全结束后暂停全流程');
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '请求暂停失败');
    } finally {
      setPending('');
    }
  }

  async function handleStopProjectRun() {
    if (!selectedId) {
      return;
    }

    try {
      setPending('stop-all');
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/stop`, {
        method: 'POST'
      });
      setNotice('已请求停止；系统正在中断当前任务');
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '停止任务失败');
    } finally {
      setPending('');
    }
  }

  async function handleResumeProjectRun() {
    if (!selectedId) {
      return;
    }

    try {
      setPending('resume-all');
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/resume`, {
        method: 'POST'
      });
      setNotice('已继续全流程任务');
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '继续全流程失败');
    } finally {
      setPending('');
    }
  }

  async function handleContinueProjectRun() {
    if (!selectedId) {
      return;
    }

    try {
      setPending('continue-all');
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/continue`, {
        method: 'POST'
      });
      setNotice('已提交从当前阶段继续到完成的任务');
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '继续执行到完成失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveAppSettings() {
    if (!settingsDraft) {
      return;
    }

    try {
      setSettingsPending(true);
      const nextSettings = await requestJson<AppSettings>('/api/app-settings', {
        method: 'PUT',
        body: JSON.stringify(settingsDraft)
      });
      setAppSettings(nextSettings);
      setSettingsDraft(nextSettings);
      setSettingsDirty(false);
      setLlmModelsError('');
      setNotice('系统设置已保存');
      await loadMeta();
      setSettingsOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '系统设置保存失败');
    } finally {
      setSettingsPending(false);
    }
  }

  async function handleGenerateReferenceAsset(
    kind: ReferenceAssetKind,
    item: ReferenceAssetItem
  ) {
    if (!selectedId) {
      return;
    }

    const key = referenceDraftKey(kind, item.id);
    const prompt = referencePromptDrafts[key]?.trim() || item.generationPrompt;
    const ethnicityHint = kind === 'character' ? (referenceEthnicityDrafts[key] ?? item.ethnicityHint).trim() : '';
    const shouldUseReferenceImage = Boolean(item.referenceImage);

    try {
      setPending(`reference:${kind}:${item.id}`);
      setReferenceAssetVersionIndices((current) => ({
        ...current,
        [key]: 0
      }));
      await requestJson<{ ok: true }>(
        `/api/projects/${selectedId}/reference-library/${kind}/${item.id}/generate`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            useReferenceImage: shouldUseReferenceImage,
            ethnicityHint
          })
        }
      );
      setNotice(
        kind === 'character'
          ? shouldUseReferenceImage
            ? `已提交角色“${item.name}”的参考图生成任务，将按用户上传参考图、角色名、人种/族裔提示和人物外貌特点生成；人物特点 Prompt 会并入后续视频生成提示词`
            : item.asset
              ? `已提交角色“${item.name}”的参考图重新生成任务，将使用角色名、人种/族裔提示和人物外貌特点生成`
              : `已提交角色“${item.name}”的参考图生成任务，将使用角色名、人种/族裔提示和人物外貌特点生成`
          : shouldUseReferenceImage
            ? `已提交${referenceKindLabel(kind)}“${item.name}”的“参考图 + Prompt”生成任务，成功后会自动清除临时参考图`
            : item.asset
              ? `已提交${referenceKindLabel(kind)}“${item.name}”的 Prompt 重新生成任务`
              : `已提交${referenceKindLabel(kind)}“${item.name}”的 Prompt 生成任务`
      );
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '参考资产生成失败');
    } finally {
      setPending('');
    }
  }

  async function handleUploadReferenceImage(kind: ReferenceAssetKind, item: ReferenceAssetItem, file: File) {
    if (!selectedId) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      setNotice('只能上传图片文件');
      return;
    }

    try {
      setPending(`reference-upload:${kind}:${item.id}`);
      const dataUrl = await fileToDataUrl(file);
      const updated = await requestJson<Project>(
        `/api/projects/${selectedId}/reference-library/${kind}/${item.id}/reference-image`,
        {
          method: 'PUT',
          body: JSON.stringify({
            filename: file.name,
            dataUrl
          })
        }
      );
      setProject(updated);
      setReferenceAssetVersionIndices((current) => ({
        ...current,
        [referenceDraftKey(kind, item.id)]: 0
      }));
      setNotice(
        kind === 'character'
          ? `角色“${item.name}”的参考图已上传；下次生成会按用户上传参考图处理，成功后会自动清除这张临时参考图`
          : `${referenceKindLabel(kind)}“${item.name}”的参考图已上传；生成按钮会自动按“参考图 + Prompt”处理，成功后会自动清除这张临时参考图`
      );
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '上传参考图失败');
    } finally {
      setPending('');
    }
  }

  async function handleUploadReferenceAudio(kind: ReferenceAssetKind, item: ReferenceAssetItem, file: File) {
    if (!selectedId) {
      return;
    }

    if (kind !== 'character') {
      setNotice('只有角色资产支持上传参考音频');
      return;
    }

    if (!file.type.startsWith('audio/')) {
      setNotice('只能上传音频文件');
      return;
    }

    try {
      setPending(`reference-audio-upload:${kind}:${item.id}`);
      const dataUrl = await fileToDataUrl(file);
      const updated = await requestJson<Project>(
        `/api/projects/${selectedId}/reference-library/${kind}/${item.id}/reference-audio`,
        {
          method: 'PUT',
          body: JSON.stringify({
            filename: file.name,
            dataUrl
          })
        }
      );
      setProject(updated);
      setReferenceAssetVersionIndices((current) => ({
        ...current,
        [referenceDraftKey(kind, item.id)]: 0
      }));
      setNotice(
        `角色“${item.name}”的参考音频已上传；后续生成视频片段时会优先使用角色参考音频配音，未匹配到参考音频的镜头仍会回退到无参考音频版 TTS`
      );
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '上传参考音频失败');
    } finally {
      setPending('');
    }
  }

  async function handleRemoveReferenceImage(kind: ReferenceAssetKind, item: ReferenceAssetItem) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`reference-remove:${kind}:${item.id}`);
      const updated = await requestJson<Project>(
        `/api/projects/${selectedId}/reference-library/${kind}/${item.id}/reference-image`,
        {
          method: 'DELETE'
        }
      );
      setProject(updated);
      setReferenceAssetVersionIndices((current) => ({
        ...current,
        [referenceDraftKey(kind, item.id)]: 0
      }));
      setNotice(`${referenceKindLabel(kind)}“${item.name}”的参考图已移除`);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '移除参考图失败');
    } finally {
      setPending('');
    }
  }

  async function handleRemoveReferenceAudio(kind: ReferenceAssetKind, item: ReferenceAssetItem) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`reference-audio-remove:${kind}:${item.id}`);
      const updated = await requestJson<Project>(
        `/api/projects/${selectedId}/reference-library/${kind}/${item.id}/reference-audio`,
        {
          method: 'DELETE'
        }
      );
      setProject(updated);
      setReferenceAssetVersionIndices((current) => ({
        ...current,
        [referenceDraftKey(kind, item.id)]: 0
      }));
      setNotice(`角色“${item.name}”的参考音频已移除`);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '移除参考音频失败');
    } finally {
      setPending('');
    }
  }

  async function handleSelectLibraryReferenceAsset(
    kind: ReferenceAssetKind,
    item: ReferenceAssetItem,
    sourceProjectId: string,
    sourceItemId: string
  ) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`reference-library:${kind}:${item.id}`);
      const updated = await requestJson<Project>(
        `/api/projects/${selectedId}/reference-library/${kind}/${item.id}/select-library-asset`,
        {
          method: 'PUT',
          body: JSON.stringify({
            sourceProjectId,
            sourceItemId,
            sourceKind: kind
          })
        }
      );
      setProject(updated);
      setReferenceAssetVersionIndices((current) => ({
        ...current,
        [referenceDraftKey(kind, item.id)]: 0
      }));
      setNotice(`已为${referenceKindLabel(kind)}“${item.name}”选用资产库素材，后续镜头链路和成片请重新生成`);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '选用资产库素材失败');
    } finally {
      setPending('');
    }
  }

  async function handleAddShotReferenceAsset(
    shotId: string,
    kind: ReferenceAssetKind,
    itemId: string,
    itemName: string
  ) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`shot-reference-add:${shotId}`);
      const updated = await requestJson<Project>(
        `/api/projects/${selectedId}/storyboard/${shotId}/reference-items/${kind}/${itemId}`,
        {
          method: 'PUT'
        }
      );
      setProject(updated);
      setNotice(`已为当前镜头加入${referenceKindLabel(kind)}参考图“${itemName}”，请重新生成当前镜头链路或视频片段`);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '添加镜头参考图失败');
    } finally {
      setPending('');
    }
  }

  async function handleRemoveShotReferenceAsset(
    shotId: string,
    kind: ReferenceAssetKind,
    itemId: string,
    itemName: string
  ) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`shot-reference-remove:${shotId}:${kind}:${itemId}`);
      const updated = await requestJson<Project>(
        `/api/projects/${selectedId}/storyboard/${shotId}/reference-items/${kind}/${itemId}`,
        {
          method: 'DELETE'
        }
      );
      setProject(updated);
      setNotice(`已从当前镜头移除${referenceKindLabel(kind)}参考图“${itemName}”`);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '移除镜头参考图失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveImagePrompt(shotId: string) {
    if (!selectedId || !project) {
      return;
    }

    const shot = project.storyboard.find((item) => item.id === shotId);
    if (!shot) {
      setNotice('镜头不存在');
      return;
    }

    const draft = technicalPromptDrafts[shotId];
    const firstFramePrompt = (draft?.firstFramePrompt ?? shot.firstFramePrompt).trim();

    if (!firstFramePrompt) {
      setNotice('起始参考帧 Prompt 不能为空');
      return;
    }

    try {
      setPending(`image-prompt:${shotId}`);
      const updated = await requestJson<Project>(`/api/projects/${selectedId}/storyboard/${shotId}/prompts`, {
        method: 'PUT',
        body: JSON.stringify({ firstFramePrompt })
      });
      setProject(updated);
      setTechnicalPromptDrafts((current) => {
        const existing = current[shotId];

        if (!existing) {
          return current;
        }

        const next = { ...current };
        const nextLastFramePrompt = existing.lastFramePrompt ?? shot.lastFramePrompt;
        const nextTransitionHint = existing.transitionHint ?? shot.transitionHint;
        const nextDurationSeconds = existing.durationSeconds ?? String(shot.durationSeconds);

        if (
          nextLastFramePrompt.trim() === shot.lastFramePrompt.trim() &&
          nextTransitionHint.trim() === shot.transitionHint.trim() &&
          nextDurationSeconds.trim() === String(shot.durationSeconds)
        ) {
          delete next[shotId];
          return next;
        }

        next[shotId] = {
          durationSeconds: nextDurationSeconds,
          firstFramePrompt,
          lastFramePrompt: nextLastFramePrompt,
          transitionHint: nextTransitionHint
        };
        return next;
      });
      setImageAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setNotice('起始参考帧 Prompt 已保存；当前参考帧、视频和最终成片需要按提示重新生成或重新选择版本');
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存起始参考帧 Prompt 失败');
    } finally {
      setPending('');
    }
  }

  async function handleGenerateShotImage(shotId: string) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`image-generate:${shotId}`);
      setImageAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/storyboard/${shotId}/image/generate`, {
        method: 'POST'
      });
      setNotice('已提交当前镜头的镜头生成任务，系统会先生成参考帧，再立即生成对应视频片段');
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交镜头生成任务失败');
    } finally {
      setPending('');
    }
  }

  async function handleSelectShotImageVersion(shotId: string, relativePath: string) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`image-select:${shotId}`);
      const updated = await requestJson<Project>(`/api/projects/${selectedId}/storyboard/${shotId}/image/select`, {
        method: 'PUT',
        body: JSON.stringify({ relativePath })
      });
      setProject(updated);
      setImageAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setNotice('已切换当前镜头的起始参考帧版本；如需保持匹配，请重新生成或重新选择对应视频版本');
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换起始参考帧版本失败');
    } finally {
      setPending('');
    }
  }

  async function handleGenerateShotVideo(shotId: string) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`video-generate:${shotId}`);
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/storyboard/${shotId}/video/generate`, {
        method: 'POST'
      });
      setNotice('已提交当前镜头的视频生成任务，完成后可在版本列表中切换');
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交视频生成任务失败');
    } finally {
      setPending('');
    }
  }

  async function handleSelectShotVideoVersion(shotId: string, relativePath: string) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(`video-select:${shotId}`);
      const updated = await requestJson<Project>(`/api/projects/${selectedId}/storyboard/${shotId}/video/select`, {
        method: 'PUT',
        body: JSON.stringify({ relativePath })
      });
      setProject(updated);
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setNotice('已切换当前镜头的视频版本；重新执行“视频剪辑”后会按当前版本剪辑');
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换视频版本失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveVideoPrompt(shotId: string) {
    if (!selectedId || !project) {
      return;
    }

    const shot = project.storyboard.find((item) => item.id === shotId);
    if (!shot) {
      setNotice('镜头不存在');
      return;
    }

    const videoPrompt = (videoPromptDrafts[shotId] ?? shot.videoPrompt).trim();
    if (!videoPrompt) {
      setNotice('视频生成 Prompt 不能为空');
      return;
    }

    try {
      setPending(`video-prompt:${shotId}`);
      const updated = await requestJson<Project>(`/api/projects/${selectedId}/storyboard/${shotId}/prompts`, {
        method: 'PUT',
        body: JSON.stringify({ videoPrompt })
      });
      setProject(updated);
      setVideoPromptDrafts((current) => {
        const next = { ...current };
        delete next[shotId];
        return next;
      });
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setNotice('视频生成 Prompt 已保存，相关视频片段和成片需要重新生成');
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存视频生成 Prompt 失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveAudioPrompts(shotId: string) {
    if (!selectedId || !project) {
      return;
    }

    const shot = project.storyboard.find((item) => item.id === shotId);
    if (!shot) {
      setNotice('镜头不存在');
      return;
    }

    const draft = audioPromptDrafts[shotId];
    const backgroundSoundPrompt = (draft?.backgroundSoundPrompt ?? shot.backgroundSoundPrompt).trim();
    const speechPrompt = (draft?.speechPrompt ?? shot.speechPrompt).trim();

    if (!backgroundSoundPrompt) {
      setNotice('背景声音 Prompt 不能为空');
      return;
    }

    if (!speechPrompt) {
      setNotice('台词/旁白 Prompt 不能为空');
      return;
    }

    try {
      setPending(`audio-prompts:${shotId}`);
      const updated = await requestJson<Project>(`/api/projects/${selectedId}/storyboard/${shotId}/prompts`, {
        method: 'PUT',
        body: JSON.stringify({
          backgroundSoundPrompt,
          speechPrompt
        })
      });
      setProject(updated);
      setAudioPromptDrafts((current) => {
        const next = { ...current };
        delete next[shotId];
        return next;
      });
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setNotice(
        meta?.envStatus.ttsWorkflowExists
          ? '背景声音和台词/旁白 Prompt 已保存；重新生成视频片段后会更新配音并自动匹配视频时长'
          : '背景声音和台词/旁白 Prompt 已保存；未配置 TTS 时，系统会按“人物描述：对白”格式把对白并入视频工作流，请重新生成视频片段和最终成片'
      );
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存音频 Prompt 失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveTechnicalPrompts(shotId: string) {
    if (!selectedId || !project) {
      return;
    }

    const shot = project.storyboard.find((item) => item.id === shotId);
    if (!shot) {
      setNotice('镜头不存在');
      return;
    }

    const draft = technicalPromptDrafts[shotId];
    const durationSecondsInput = draft?.durationSeconds ?? String(shot.durationSeconds);
    const firstFramePrompt = (draft?.firstFramePrompt ?? shot.firstFramePrompt).trim();
    const lastFramePrompt = (draft?.lastFramePrompt ?? shot.lastFramePrompt).trim();
    const transitionHint = (draft?.transitionHint ?? shot.transitionHint).trim();
    const durationSeconds = parsePositiveIntegerDraft(durationSecondsInput);

    if (durationSeconds === null) {
      setNotice('镜头时长必须为正整数秒');
      return;
    }

    if (!firstFramePrompt) {
      setNotice('起始参考帧 Prompt 不能为空');
      return;
    }

    if (shot.useLastFrameReference && !lastFramePrompt) {
      setNotice('结束参考帧 Prompt 不能为空');
      return;
    }

    if (!transitionHint) {
      setNotice('转场提示不能为空');
      return;
    }

    try {
      setPending(`technical-prompts:${shotId}`);
      const updated = await requestJson<Project>(`/api/projects/${selectedId}/storyboard/${shotId}/prompts`, {
        method: 'PUT',
        body: JSON.stringify({
          durationSeconds,
          firstFramePrompt,
          lastFramePrompt: shot.useLastFrameReference ? lastFramePrompt : undefined,
          transitionHint
        })
      });
      setProject(updated);
      setTechnicalPromptDrafts((current) => {
        const next = { ...current };
        delete next[shotId];
        return next;
      });
      setImageAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setVideoAssetVersionIndices((current) => ({
        ...current,
        [shotId]: 0
      }));
      setNotice('镜头技术面板已保存；请按提示重新生成受影响的镜头链路、视频片段或成片');
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存镜头技术面板失败');
    } finally {
      setPending('');
    }
  }

  const createResolvedSettings = buildCreateProjectSettings(
    meta?.defaults ?? DEFAULT_SETTINGS,
    createAspectRatio,
    createScriptMode,
    createStoryLength,
    createResolutionPreset
  );
  const libraryAssets = buildLibraryAssets(projects);
  const characterLibraryAssets = buildReferenceLibraryAssets(projects, 'character');
  const sceneLibraryAssets = buildReferenceLibraryAssets(projects, 'scene');
  const objectLibraryAssets = buildReferenceLibraryAssets(projects, 'object');
  const referenceLibraryAssetPools = {
    character: characterLibraryAssets,
    scene: sceneLibraryAssets,
    object: objectLibraryAssets
  };
  const filteredLibraryAssets =
    assetFilter === 'all' ? libraryAssets : libraryAssets.filter((asset) => asset.kind === assetFilter);
  const libraryCounts = {
    total:
      libraryAssets.length +
      characterLibraryAssets.length +
      sceneLibraryAssets.length +
      objectLibraryAssets.length,
    outputs: libraryAssets.length,
    image: libraryAssets.filter((asset) => asset.kind === 'image').length,
    video: libraryAssets.filter((asset) => asset.kind === 'video').length,
    final: libraryAssets.filter((asset) => asset.kind === 'final').length,
    characters: characterLibraryAssets.length,
    scenes: sceneLibraryAssets.length,
    objects: objectLibraryAssets.length
  };
  const currentReferenceAssets =
    assetLibrarySection === 'characters'
      ? characterLibraryAssets
      : assetLibrarySection === 'scenes'
        ? sceneLibraryAssets
        : assetLibrarySection === 'objects'
          ? objectLibraryAssets
          : [];
  const selectedLibraryOutput =
    filteredLibraryAssets.find((asset) => asset.id === selectedLibraryOutputId) ?? filteredLibraryAssets[0] ?? null;
  const selectedLibraryReference =
    currentReferenceAssets.find((asset) => asset.id === selectedLibraryReferenceId) ?? currentReferenceAssets[0] ?? null;
  const referenceWorkflowReadyCount = meta
    ? [
        meta.envStatus.characterAssetWorkflowExists,
        meta.envStatus.referenceImageToImageWorkflowExists,
        meta.envStatus.textToImageWorkflowExists
      ].filter(Boolean).length
    : 0;
  const storyboardImageWorkflowReady =
    (meta?.envStatus.storyboardImageWorkflowExists ?? false) || (meta?.envStatus.imageEditWorkflowExists ?? false);
  const shotVideoWorkflowReady =
    (meta?.envStatus.textToVideoWorkflowExists ?? false) ||
    (meta?.envStatus.imageToVideoFirstLastWorkflowExists ?? false) ||
    (meta?.envStatus.imageToVideoFirstFrameWorkflowExists ?? false);
  const productionWorkflowReadyCount = meta
    ? [
        storyboardImageWorkflowReady,
        meta.envStatus.textToVideoWorkflowExists,
        meta.envStatus.imageToVideoFirstLastWorkflowExists,
        meta.envStatus.imageToVideoFirstFrameWorkflowExists
      ].filter(Boolean).length
    : 0;
  const ttsWorkflowReady = meta?.envStatus.ttsWorkflowExists ?? false;
  const projectTtsEnabled =
    draft?.settings.useTtsWorkflow ?? project?.settings.useTtsWorkflow ?? DEFAULT_SETTINGS.useTtsWorkflow;
  const ttsWorkflowStatusLabel = !projectTtsEnabled
    ? '项目已关闭，台词并入视频'
    : ttsWorkflowReady
      ? '已就绪'
      : '未配置，回退到视频 Prompt';
  const ttsWorkflowConfigLabel = !projectTtsEnabled ? '项目已关闭' : ttsWorkflowReady ? '已配置' : '未配置';
  const draftResolutionPreset = draft ? inferResolutionPreset(draft.settings) : 'custom';
  const draftSourceLabel = draft ? (draft.settings.scriptMode === 'generate' ? '剧情输入' : '待优化文本') : '项目输入';
  const draftFormatSummary = draft ? createFormatSummary(draft.settings) : '未设置画幅';
  const effectiveMaxVideoSegmentDurationSeconds =
    appSettings?.comfyui.maxVideoSegmentDurationSeconds ??
    draft?.settings.maxVideoSegmentDurationSeconds ??
    DEFAULT_SETTINGS.maxVideoSegmentDurationSeconds;
  const imageMap = new Map(project?.assets.images.map((asset) => [asset.shotId, asset]) ?? []);
  const audioMap = new Map(project?.assets.audios.map((asset) => [asset.shotId, asset]) ?? []);
  const videoMap = new Map(project?.assets.videos.map((asset) => [asset.shotId, asset]) ?? []);
  const referenceEntries = project
    ? (
        [
          ['character', project.referenceLibrary.characters],
          ['scene', project.referenceLibrary.scenes],
          ['object', project.referenceLibrary.objects]
        ] as Array<[ReferenceAssetKind, ReferenceAssetItem[]]>
      ).flatMap(([kind, items]) =>
        items.map((item) => ({
          kind,
          item,
          selectionId: referenceSelectionId(kind, item.id)
        }))
      )
    : [];
  const selectedReferenceEntry =
    referenceEntries.find((entry) => entry.selectionId === selectedReferenceItemId) ?? referenceEntries[0] ?? null;
  const selectedStoryboardShot = project?.storyboard.find((shot) => shot.id === selectedStoryboardShotId) ?? project?.storyboard[0] ?? null;
  const selectedImageShot = project?.storyboard.find((shot) => shot.id === selectedImageShotId) ?? project?.storyboard[0] ?? null;
  const selectedVideoShot = project?.storyboard.find((shot) => shot.id === selectedVideoShotId) ?? project?.storyboard[0] ?? null;
  const referenceItems = project ? allReferenceItems(project) : [];
  const generatedReferenceCount = project ? countGeneratedReferenceAssets(project) : 0;
  const failedReferenceCount = referenceItems.filter((item) => item.status === 'error').length;
  const readyImageCount = project?.storyboard.filter((shot) => imageMap.has(shot.id)).length ?? 0;
  const readyVideoCount = project?.storyboard.filter((shot) => videoMap.has(shot.id)).length ?? 0;
  const activeStageState = project && isStageTab(projectStageTab) ? project.stages[projectStageTab] : null;
  const activeTabIndex = isStageTab(projectStageTab) ? STAGES.indexOf(projectStageTab) + 1 : STAGES.length + 1;
  const hasRemainingStages = project ? STAGES.some((stage) => project.stages[stage].status !== 'success') : false;
  const hasStartedStages = project ? STAGES.some((stage) => project.stages[stage].status !== 'idle') : false;
  const showContinueToCompletion = Boolean(project && hasRemainingStages && hasStartedStages);

  function renderReferenceDetail() {
    if (!project || !selectedReferenceEntry) {
      return <div className="empty-card stage-detail-empty">执行资产生成阶段后，左侧会列出可编辑的参考资产。</div>;
    }

    const { kind, item } = selectedReferenceEntry;
    const key = referenceDraftKey(kind, item.id);
    const librarySelectionKey = referenceLibrarySelectionKey(kind, item.id);
    const promptValue = referencePromptDrafts[key] ?? item.generationPrompt;
    const ethnicityValue = referenceEthnicityDrafts[key] ?? item.ethnicityHint;
    const assetVersions = getReferenceAssetVersions(item);
    const selectedAssetIndex = Math.min(referenceAssetVersionIndices[key] ?? 0, Math.max(assetVersions.length - 1, 0));
    const selectedAsset = assetVersions[selectedAssetIndex] ?? null;
    const availableLibraryAssets = getReferenceLibraryAssetPool(kind, referenceLibraryAssetPools)
      .filter((asset) => !(asset.projectId === selectedId && asset.itemId === item.id))
      .filter((asset) => asset.relativePath !== item.asset?.relativePath);
    const selectedLibraryValue = resolveReferenceLibrarySelection(
      availableLibraryAssets,
      referenceLibrarySelections[librarySelectionKey]
    );
    const selectedLibraryAsset =
      availableLibraryAssets.find((asset) => referenceLibraryAssetValue(asset) === selectedLibraryValue) ?? null;
    const selectLibraryPending = pending === `reference-library:${kind}:${item.id}`;

    return (
      <article className="reference-card stage-detail-card">
        <div className="stage-detail-head">
          <div>
            <span className="eyebrow">{referenceKindLabel(kind)}</span>
            <h4>{item.name}</h4>
            <p>{item.summary}</p>
          </div>
          <span className={`pill ${item.status}`}>{statusLabel(item.status)}</span>
        </div>
        <label className="field">
          <span>{kind === 'character' ? '人物特点 Prompt' : '生成 Prompt'}</span>
          <textarea
            rows={4}
            value={promptValue}
            onChange={(event) =>
              setReferencePromptDrafts((current) => ({
                ...current,
                [key]: event.target.value
              }))
            }
          />
          {kind === 'character' ? (
            <small className="inline-note">
              无参考图时，角色参考图会自动把角色名、人种/族裔提示和人物外貌特点拼进实际 Prompt；这里的人物特点 Prompt 也会并入后续视频生成提示词。
            </small>
          ) : null}
        </label>
        {kind === 'character' ? (
          <label className="field">
            <span>人种 / 族裔提示</span>
            <input
              type="text"
              value={ethnicityValue}
              placeholder="如：东亚面孔、白人、拉丁裔、阿拉伯裔"
              onChange={(event) =>
                setReferenceEthnicityDrafts((current) => ({
                  ...current,
                  [key]: event.target.value
                }))
              }
            />
            <small className="inline-note">
              这项会和角色名一起拼进人物资产生成 Prompt，也会随角色参考信息一起传给后续图片和视频阶段。
            </small>
          </label>
        ) : null}
        <div className="form-grid">
          <label className="field span-2">
            <span>{item.referenceImage ? '上传/更换参考图' : '上传参考图'}</span>
            <input
              type="file"
              accept="image/*"
              disabled={
                Boolean(project.runState.isRunning) ||
                item.status === 'running' ||
                pending === `reference-upload:${kind}:${item.id}`
              }
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (!file) {
                  return;
                }

                void handleUploadReferenceImage(kind, item, file);
              }}
            />
          </label>
          {kind === 'character' ? (
            <label className="field span-2">
              <span>{item.referenceAudio ? '上传/更换参考音频' : '上传参考音频'}</span>
              <input
                type="file"
                accept="audio/*"
                disabled={
                  Boolean(project.runState.isRunning) ||
                  item.status === 'running' ||
                  pending === `reference-audio-upload:${kind}:${item.id}`
                }
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (!file) {
                    return;
                  }

                  void handleUploadReferenceAudio(kind, item, file);
                }}
              />
              <small className="inline-note">
                这份音频会在生成视频片段前用于角色配音参考；不上传时，会自动回退到无参考音频版 TTS。
              </small>
            </label>
          ) : null}
          <div className="field span-2">
            <span>从资产库直接选用</span>
            <ReferenceLibraryPicker
              assets={availableLibraryAssets}
              disabled={Boolean(project.runState.isRunning) || item.status === 'running' || !availableLibraryAssets.length}
              selectedValue={selectedLibraryValue}
              onChange={(value) =>
                setReferenceLibrarySelections((current) => ({
                  ...current,
                  [librarySelectionKey]: value
                }))
              }
            />
          </div>
        </div>
        {selectedLibraryAsset ? (
          <div className="reference-library-selection">
            <small className="version-indicator">
              {selectedLibraryAsset.projectTitle} · {selectedLibraryAsset.summary}
            </small>
            <div className="inline-actions">
              <a href={assetUrl(selectedLibraryAsset.relativePath)} target="_blank" rel="noreferrer">
                打开资产库素材
              </a>
              <button
                className="button ghost mini-button"
                disabled={
                  Boolean(project.runState.isRunning) ||
                  item.status === 'running' ||
                  selectLibraryPending ||
                  !selectedLibraryAsset
                }
                onClick={() => {
                  const [sourceProjectId, , sourceItemId] = selectedLibraryValue.split('::');
                  if (!sourceProjectId || !sourceItemId) {
                    return;
                  }

                  void handleSelectLibraryReferenceAsset(kind, item, sourceProjectId, sourceItemId);
                }}
                type="button"
              >
                {selectLibraryPending ? '选用中...' : '选用这份素材'}
              </button>
            </div>
          </div>
        ) : null}
        {item.referenceImage ? (
          <div className="reference-preview">
            <img src={assetUrl(item.referenceImage.relativePath)} alt={`${item.name} 上传参考图`} />
            <a href={assetUrl(item.referenceImage.relativePath)} target="_blank" rel="noreferrer">
              打开上传参考图
            </a>
            <button
              className="button ghost mini-button"
              disabled={
                Boolean(project.runState.isRunning) ||
                item.status === 'running' ||
                pending === `reference-remove:${kind}:${item.id}`
              }
              onClick={() => void handleRemoveReferenceImage(kind, item)}
              type="button"
            >
              {pending === `reference-remove:${kind}:${item.id}` ? '移除中...' : '移除参考图'}
            </button>
          </div>
        ) : null}
        {item.referenceImage ? (
          <p className="settings-hint">
            {kind === 'character'
              ? '已上传参考图；角色参考图会按用户上传参考图生成，成功后会自动清除这张临时参考图。继续上传即可更换。'
              : '已上传参考图；生成按钮会自动按“参考图 + Prompt”处理，成功后会自动清除这张临时参考图。继续上传即可更换。'}
          </p>
        ) : kind === 'character' ? (
          <p className="settings-hint">
            未上传人物参考图时，角色参考图会自动把“角色名 + 人种/族裔提示 + 人物特点”拼进实际生成 Prompt；这里的人物特点 Prompt 也会并入后续视频生成提示词。
          </p>
        ) : null}
        {kind === 'character' && item.referenceAudio ? (
          <div className="reference-preview">
            <audio src={assetUrl(item.referenceAudio.relativePath)} controls preload="none" />
            <a href={assetUrl(item.referenceAudio.relativePath)} target="_blank" rel="noreferrer">
              打开上传参考音频
            </a>
            <button
              className="button ghost mini-button"
              disabled={
                Boolean(project.runState.isRunning) ||
                item.status === 'running' ||
                pending === `reference-audio-remove:${kind}:${item.id}`
              }
              onClick={() => void handleRemoveReferenceAudio(kind, item)}
              type="button"
            >
              {pending === `reference-audio-remove:${kind}:${item.id}` ? '移除中...' : '移除参考音频'}
            </button>
          </div>
        ) : null}
        {kind === 'character' ? (
          <p className="settings-hint">
            {item.referenceAudio
              ? '已上传角色参考音频；生成视频片段时会优先为匹配到该角色的镜头使用参考音频版 TTS，未匹配到的镜头会自动回退到无参考音频版 TTS。'
              : '未上传角色参考音频时，生成视频片段时会自动使用无参考音频版 TTS，根据镜头的台词/旁白文字直接生成语音。'}
          </p>
        ) : null}
        {item.error ? <div className="error-box">{item.error}</div> : null}
        {selectedAsset ? (
          <div className="reference-preview">
            <img src={assetUrl(selectedAsset.relativePath)} alt={item.name} />
            <a href={assetUrl(selectedAsset.relativePath)} target="_blank" rel="noreferrer">
              打开生成资产
            </a>
            {assetVersions.length > 1 ? (
              <div className="inline-actions">
                <button
                  className="button ghost mini-button"
                  disabled={selectedAssetIndex <= 0}
                  onClick={() =>
                    setReferenceAssetVersionIndices((current) => ({
                      ...current,
                      [key]: Math.max(0, selectedAssetIndex - 1)
                    }))
                  }
                  type="button"
                >
                  较新
                </button>
                <button
                  className="button ghost mini-button"
                  disabled={selectedAssetIndex >= assetVersions.length - 1}
                  onClick={() =>
                    setReferenceAssetVersionIndices((current) => ({
                      ...current,
                      [key]: Math.min(assetVersions.length - 1, selectedAssetIndex + 1)
                    }))
                  }
                  type="button"
                >
                  较旧
                </button>
                <small className="version-indicator">
                  {selectedAssetIndex + 1}/{assetVersions.length} · {formatTime(selectedAsset.createdAt)}
                </small>
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          className="button secondary"
          disabled={
            Boolean(project.runState.isRunning) ||
            item.status === 'running' ||
            pending === `reference-upload:${kind}:${item.id}` ||
            pending === `reference-remove:${kind}:${item.id}` ||
            pending === `reference-audio-upload:${kind}:${item.id}` ||
            pending === `reference-audio-remove:${kind}:${item.id}`
          }
          onClick={() => void handleGenerateReferenceAsset(kind, item)}
          type="button"
        >
          {item.status === 'running'
            ? '生成中...'
            : kind === 'character'
              ? item.referenceImage
                ? item.asset
                  ? '按参考图重新生成'
                  : '按参考图生成'
                : item.asset
                  ? '重新生成参考图'
                  : '生成参考图'
              : item.referenceImage
                ? item.asset
                  ? '按参考图 + Prompt 重新生成'
                  : '按参考图 + Prompt 生成'
                : item.asset
                  ? '按 Prompt 重新生成'
                  : '按 Prompt 生成'}
        </button>
      </article>
    );
  }

  function renderStoryboardDetail() {
    if (!project || !selectedStoryboardShot) {
      return <div className="empty-card stage-detail-empty">执行第 2 阶段后会在这里显示完整分镜。</div>;
    }

    const shot = selectedStoryboardShot;

    return (
      <article className="shot-card stage-detail-card">
        <div className="stage-detail-head">
          <div>
            <span className="eyebrow">{`S${shot.sceneNumber} · #${shot.shotNumber}`}</span>
            <h4>{shot.title}</h4>
            <p>{shot.purpose}</p>
          </div>
          <span className="pill">{formatShotTimeline(shot)}</span>
        </div>
        <dl className="shot-meta">
          <div>
            <dt>镜头</dt>
            <dd>{shot.camera}</dd>
          </div>
          <div>
            <dt>构图</dt>
            <dd>{shot.composition}</dd>
          </div>
          <div>
            <dt>对白</dt>
            <dd>{shot.dialogue || '无'}</dd>
          </div>
          <div>
            <dt>对话标识</dt>
            <dd>{formatDialogueIdentifier(shot)}</dd>
          </div>
          <div>
            <dt>长镜头组</dt>
            <dd>{formatLongTakeIdentifier(shot)}</dd>
          </div>
          <div>
            <dt>画外音</dt>
            <dd>{shot.voiceover || '无'}</dd>
          </div>
        </dl>
        <div className="prompt-block">
          <h5>起始参考帧描述</h5>
          <p>{shot.firstFramePrompt}</p>
        </div>
        <div className="prompt-block">
          <h5>结束参考帧描述</h5>
          <p>{shot.useLastFrameReference ? shot.lastFramePrompt : '当前镜头不需要结束参考帧约束'}</p>
        </div>
        <div className="prompt-block">
          <h5>视频描述</h5>
          <p>{shot.videoPrompt}</p>
        </div>
      </article>
    );
  }

  function renderImageDetail() {
    if (!project || !selectedImageShot) {
      return <div className="empty-card stage-detail-empty">执行第 4 阶段后，才能在这里查看镜头参考帧生成链路。</div>;
    }

    const shot = selectedImageShot;
    const longTakeContinuation = isLongTakeContinuationShot(project, shot);
    const technicalPromptDraft = technicalPromptDrafts[shot.id];
    const shotReferencePreviewItems = getShotReferencePreviewItems(project, shot);
    const shotReferenceIds = new Set(
      shotReferencePreviewItems.map((reference) => referenceSelectionId(reference.kind, reference.itemId))
    );
    const availableShotReferenceAssets = buildCurrentProjectReferenceAssets(project).filter(
      (asset) => !shotReferenceIds.has(referenceSelectionId(asset.kind, asset.itemId))
    );
    const shotReferenceSelectionValue = resolveReferenceLibrarySelection(
      availableShotReferenceAssets,
      shotReferenceLibrarySelections[shot.id]
    );
    const selectedShotReferenceAsset =
      availableShotReferenceAssets.find((asset) => referenceLibraryAssetValue(asset) === shotReferenceSelectionValue) ?? null;
    const firstFramePromptValue = technicalPromptDraft?.firstFramePrompt ?? shot.firstFramePrompt;
    const imagePromptDirty = firstFramePromptValue.trim() !== shot.firstFramePrompt.trim();
    const imagePromptPending = pending === `image-prompt:${shot.id}`;
    const imageGeneratePending = pending === `image-generate:${shot.id}`;
    const imageSelectPending = pending === `image-select:${shot.id}`;
    const shotReferenceAddPending = pending === `shot-reference-add:${shot.id}`;
    const imageAsset = imageMap.get(shot.id) ?? null;
    const imageVersions = getShotAssetVersions(project, 'images', shot.id);
    const selectedImageIndex = Math.min(imageAssetVersionIndices[shot.id] ?? 0, Math.max(imageVersions.length - 1, 0));
    const selectedImage = imageVersions[selectedImageIndex] ?? null;
    const selectedImageIsCurrent = imageAsset?.relativePath === selectedImage?.relativePath;

    return (
      <article className="shot-card stage-detail-card">
        <div className="stage-detail-head">
          <div>
            <span className="eyebrow">{`S${shot.sceneNumber} · #${shot.shotNumber}`}</span>
            <h4>{shot.title}</h4>
            <p>{shot.purpose}</p>
          </div>
          <span className={`pill ${imageAsset ? 'success' : ''}`}>
            {imageAsset ? '当前版本已就绪' : selectedImage ? '可从历史版本恢复' : '未生成'}
          </span>
        </div>
        <div className="input-reference-strip">
          <div className="input-reference-strip-head">
            <span>从当前资产库添加参考图</span>
            <small>可手动补充未自动匹配到的角色、场景或物品参考图，参考帧和后续视频生成都会使用这些参考图。</small>
          </div>
          {availableShotReferenceAssets.length ? (
            <>
              <ReferenceLibraryPicker
                assets={availableShotReferenceAssets}
                disabled={Boolean(project.runState.isRunning) || shotReferenceAddPending}
                selectedValue={shotReferenceSelectionValue}
                onChange={(value) =>
                  setShotReferenceLibrarySelections((current) => ({
                    ...current,
                    [shot.id]: value
                  }))
                }
              />
              {selectedShotReferenceAsset ? (
                <div className="inline-actions">
                  <a href={assetUrl(selectedShotReferenceAsset.relativePath)} target="_blank" rel="noreferrer">
                    打开资产库素材
                  </a>
                  <button
                    className="button ghost mini-button"
                    disabled={Boolean(project.runState.isRunning) || shotReferenceAddPending}
                    onClick={() =>
                      void handleAddShotReferenceAsset(
                        shot.id,
                        selectedShotReferenceAsset.kind,
                        selectedShotReferenceAsset.itemId,
                        selectedShotReferenceAsset.name
                      )
                    }
                    type="button"
                  >
                    {shotReferenceAddPending ? '加入中...' : '加入当前镜头'}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="input-reference-empty">当前项目资产库里没有更多可加入这个镜头的参考图。</div>
          )}
        </div>
        {shotReferencePreviewItems.length ? (
          <div className="input-reference-strip">
            <div className="input-reference-strip-head">
              <span>输入参考图</span>
              <small>{shotReferencePreviewItems.length} 张；自动匹配当前镜头内容，也支持你在上方手动添加或移除</small>
            </div>
            <div className="input-reference-strip-track">
              {shotReferencePreviewItems.map((reference) => (
                <div
                  key={`${reference.kind}:${reference.itemId}`}
                  className="input-reference-entry"
                >
                  <a
                    className="input-reference-chip"
                    href={assetUrl(reference.asset.relativePath)}
                    target="_blank"
                    rel="noreferrer"
                    title={
                      reference.summary
                        ? `${referenceKindLabel(reference.kind)} · ${reference.name}\n${reference.summary}`
                        : `${referenceKindLabel(reference.kind)} · ${reference.name}`
                    }
                  >
                    <img src={assetUrl(reference.asset.relativePath)} alt={`${referenceKindLabel(reference.kind)} ${reference.name}`} />
                    <div className="input-reference-chip-copy">
                      <strong>{reference.name}</strong>
                      <small>{referenceKindLabel(reference.kind)}</small>
                    </div>
                  </a>
                  <button
                    className="button ghost mini-button"
                    disabled={
                      Boolean(project.runState.isRunning) ||
                      pending === `shot-reference-remove:${shot.id}:${reference.kind}:${reference.itemId}`
                    }
                    onClick={() =>
                      void handleRemoveShotReferenceAsset(shot.id, reference.kind, reference.itemId, reference.name)
                    }
                    type="button"
                  >
                    {pending === `shot-reference-remove:${shot.id}:${reference.kind}:${reference.itemId}` ? '移除中...' : '移除'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="input-reference-empty">当前镜头没有匹配到可注入的参考图，参考帧生成将只使用 Prompt。</div>
        )}
        <div className="prompt-block">
          <div className="prompt-block-head">
            <h5>起始参考帧 Prompt</h5>
            <button
              className="button ghost mini-button"
              disabled={
                Boolean(project.runState.isRunning) || imagePromptPending || !imagePromptDirty || !firstFramePromptValue.trim()
              }
              onClick={() => void handleSaveImagePrompt(shot.id)}
              type="button"
            >
              {imagePromptPending ? '保存中...' : '保存起始参考帧 Prompt'}
            </button>
          </div>
          <textarea
            className="prompt-editor"
            rows={5}
            value={firstFramePromptValue}
            onChange={(event) =>
              setTechnicalPromptDrafts((current) => ({
                ...current,
                [shot.id]: buildShotTechnicalDraft(shot, current[shot.id], {
                  firstFramePrompt: event.target.value
                })
              }))
            }
            placeholder="输入这个镜头的起始参考帧 Prompt"
          />
        </div>
        <div className="prompt-block">
          <h5>结束参考帧策略</h5>
          <p>{shot.useLastFrameReference ? '该镜头会额外生成结束参考帧，并自动注入后续视频工作流。' : '该镜头仅生成起始参考帧，结束画面由视频工作流自然收束。'}</p>
        </div>
        <div className="prompt-block">
          <h5>长镜头承接</h5>
          <p>
            {shot.longTakeIdentifier
              ? longTakeContinuation
                ? `当前镜头属于长镜头组 ${shot.longTakeIdentifier}，不会单独生成首帧，而是直接复用上一镜头视频的尾帧作为起始帧。`
                : `当前镜头是长镜头组 ${shot.longTakeIdentifier} 的起始镜头，会正常生成首帧。`
              : '当前镜头未启用长镜头尾帧承接。'}
          </p>
        </div>
        <div className="asset-box">
          <span>起始参考帧版本</span>
          {selectedImage ? (
            <>
              <img src={assetUrl(selectedImage.relativePath)} alt={shot.title} />
              <a href={assetUrl(selectedImage.relativePath)} target="_blank" rel="noreferrer">
                打开原图
              </a>
              {imageVersions.length > 1 ? (
                <div className="inline-actions">
                  <button
                    className="button ghost mini-button"
                    disabled={selectedImageIndex <= 0}
                    onClick={() =>
                      setImageAssetVersionIndices((current) => ({
                        ...current,
                        [shot.id]: Math.max(0, selectedImageIndex - 1)
                      }))
                    }
                    type="button"
                  >
                    较新
                  </button>
                  <button
                    className="button ghost mini-button"
                    disabled={selectedImageIndex >= imageVersions.length - 1}
                    onClick={() =>
                      setImageAssetVersionIndices((current) => ({
                        ...current,
                        [shot.id]: Math.min(imageVersions.length - 1, selectedImageIndex + 1)
                      }))
                    }
                    type="button"
                  >
                    较旧
                  </button>
                  <small className="version-indicator">
                    {selectedImageIndex + 1}/{imageVersions.length} · {formatTime(selectedImage.createdAt)}
                  </small>
                </div>
              ) : null}
              {!selectedImageIsCurrent ? (
                <button
                  className="button ghost mini-button"
                  disabled={Boolean(project.runState.isRunning) || imageSelectPending || imagePromptDirty}
                  onClick={() => void handleSelectShotImageVersion(shot.id, selectedImage.relativePath)}
                  type="button"
                >
                  {imageSelectPending ? '切换中...' : '设为当前版本'}
                </button>
              ) : null}
            </>
          ) : (
            <small>当前镜头还没有起始参考帧图片。</small>
          )}
        </div>
        <button
          className="button secondary"
          disabled={
            Boolean(project.runState.isRunning) ||
            imageGeneratePending ||
            imagePromptPending ||
            imageSelectPending ||
            imagePromptDirty ||
            !firstFramePromptValue.trim()
          }
          onClick={() => void handleGenerateShotImage(shot.id)}
          type="button"
        >
          {imageGeneratePending ? '生成中...' : imageAsset ? '重新生成当前镜头链路' : '生成当前镜头链路'}
        </button>
      </article>
    );
  }

  function renderVideoDetail() {
    if (!project || !selectedVideoShot) {
      return <div className="empty-card stage-detail-empty">执行第 4 阶段后，才能在这里编辑视频 Prompt 并查看片段。</div>;
    }

    const shot = selectedVideoShot;
    const longTakeContinuation = isLongTakeContinuationShot(project, shot);
    const imageAsset = imageMap.get(shot.id) ?? null;
    const audioAsset = audioMap.get(shot.id) ?? null;
    const videoAsset = videoMap.get(shot.id) ?? null;
    const videoVersions = getShotAssetVersions(project, 'videos', shot.id);
    const selectedVideoIndex = Math.min(videoAssetVersionIndices[shot.id] ?? 0, Math.max(videoVersions.length - 1, 0));
    const selectedVideo = videoVersions[selectedVideoIndex] ?? null;
    const selectedVideoIsCurrent = videoAsset?.relativePath === selectedVideo?.relativePath;
    const videoPromptValue = videoPromptDrafts[shot.id] ?? shot.videoPrompt;
    const videoPromptDirty = videoPromptValue.trim() !== shot.videoPrompt.trim();
    const videoPromptPending = pending === `video-prompt:${shot.id}`;
    const audioPromptDraft = audioPromptDrafts[shot.id];
    const technicalPromptDraft = technicalPromptDrafts[shot.id];
    const firstFramePromptValue = technicalPromptDraft?.firstFramePrompt ?? shot.firstFramePrompt;
    const lastFramePromptValue = technicalPromptDraft?.lastFramePrompt ?? shot.lastFramePrompt;
    const transitionHintValue = technicalPromptDraft?.transitionHint ?? shot.transitionHint;
    const requiresLastFrameReference = shot.useLastFrameReference;
    const durationSecondsValue = technicalPromptDraft?.durationSeconds ?? String(shot.durationSeconds);
    const durationSecondsValid = parsePositiveIntegerDraft(durationSecondsValue) !== null;
    const technicalPromptDirty =
      durationSecondsValue.trim() !== String(shot.durationSeconds) ||
      firstFramePromptValue.trim() !== shot.firstFramePrompt.trim() ||
      (requiresLastFrameReference && lastFramePromptValue.trim() !== shot.lastFramePrompt.trim()) ||
      transitionHintValue.trim() !== shot.transitionHint.trim();
    const technicalPromptPending = pending === `technical-prompts:${shot.id}`;
    const backgroundSoundPromptValue = audioPromptDraft?.backgroundSoundPrompt ?? shot.backgroundSoundPrompt;
    const speechPromptValue = audioPromptDraft?.speechPrompt ?? shot.speechPrompt;
    const audioPromptDirty =
      backgroundSoundPromptValue.trim() !== shot.backgroundSoundPrompt.trim() ||
      speechPromptValue.trim() !== shot.speechPrompt.trim();
    const audioPromptPending = pending === `audio-prompts:${shot.id}`;
    const videoGeneratePending = pending === `video-generate:${shot.id}`;
    const videoSelectPending = pending === `video-select:${shot.id}`;
    const videoGenerationDirty = videoPromptDirty || technicalPromptDirty || audioPromptDirty;

    return (
      <article className="shot-card stage-detail-card">
        <div className="stage-detail-head">
          <div>
            <span className="eyebrow">{`S${shot.sceneNumber} · #${shot.shotNumber}`}</span>
            <h4>{shot.title}</h4>
            <p>{shot.purpose}</p>
          </div>
          <span className={`pill ${videoAsset ? 'success' : ''}`}>{formatShotTimeline(shot)}</span>
        </div>
        <dl className="shot-meta">
          <div>
            <dt>镜头</dt>
            <dd>{shot.camera}</dd>
          </div>
          <div>
            <dt>构图</dt>
            <dd>{shot.composition}</dd>
          </div>
          <div>
            <dt>对白</dt>
            <dd>{shot.dialogue || '无'}</dd>
          </div>
          <div>
            <dt>对话标识</dt>
            <dd>{formatDialogueIdentifier(shot)}</dd>
          </div>
          <div>
            <dt>长镜头组</dt>
            <dd>{formatLongTakeIdentifier(shot)}</dd>
          </div>
          <div>
            <dt>画外音</dt>
            <dd>{shot.voiceover || '无'}</dd>
          </div>
        </dl>
        <div className="prompt-block">
          <div className="prompt-block-head">
            <h5>视频描述</h5>
            <button
              className="button ghost mini-button"
              disabled={Boolean(project.runState.isRunning) || videoPromptPending || !videoPromptDirty || !videoPromptValue.trim()}
              onClick={() => void handleSaveVideoPrompt(shot.id)}
              type="button"
            >
              {videoPromptPending ? '保存中...' : '保存视频 Prompt'}
            </button>
          </div>
          <textarea
            className="prompt-editor"
            rows={6}
            value={videoPromptValue}
            onChange={(event) =>
              setVideoPromptDrafts((current) => ({
                ...current,
                [shot.id]: event.target.value
              }))
            }
            placeholder="输入这个镜头的视频生成 Prompt"
          />
        </div>
        <div className="prompt-block">
          <div className="prompt-block-head">
            <h5>镜头技术面板</h5>
            <button
              className="button ghost mini-button"
              disabled={
                Boolean(project.runState.isRunning) ||
                technicalPromptPending ||
                !technicalPromptDirty ||
                !durationSecondsValid ||
                !firstFramePromptValue.trim() ||
                (requiresLastFrameReference && !lastFramePromptValue.trim()) ||
                !transitionHintValue.trim()
              }
              onClick={() => void handleSaveTechnicalPrompts(shot.id)}
              type="button"
            >
              {technicalPromptPending ? '保存中...' : '保存技术面板'}
            </button>
          </div>
          <label className="prompt-subfield">
            <span>镜头时长（秒）</span>
            <input
              type="number"
              min={1}
              step={1}
              value={durationSecondsValue}
              onChange={(event) =>
                setTechnicalPromptDrafts((current) => ({
                  ...current,
                  [shot.id]: buildShotTechnicalDraft(shot, current[shot.id], {
                    durationSeconds: event.target.value
                  })
                }))
              }
              placeholder="输入镜头时长"
            />
          </label>
          <label className="prompt-subfield">
            <span>起始参考帧 Prompt</span>
            <textarea
              className="prompt-editor"
              rows={5}
              value={firstFramePromptValue}
              onChange={(event) =>
                setTechnicalPromptDrafts((current) => ({
                  ...current,
                  [shot.id]: buildShotTechnicalDraft(shot, current[shot.id], {
                    firstFramePrompt: event.target.value
                  })
                }))
              }
              placeholder="输入这个镜头的起始参考帧 Prompt"
            />
          </label>
          {requiresLastFrameReference ? (
            <label className="prompt-subfield">
              <span>结束参考帧 Prompt</span>
              <textarea
                className="prompt-editor"
                rows={5}
                value={lastFramePromptValue}
                onChange={(event) =>
                  setTechnicalPromptDrafts((current) => ({
                    ...current,
                    [shot.id]: buildShotTechnicalDraft(shot, current[shot.id], {
                      lastFramePrompt: event.target.value
                    })
                  }))
                }
                placeholder="输入这个镜头的结束参考帧 Prompt"
              />
            </label>
          ) : (
            <div className="prompt-subfield">
              <span>结束参考帧</span>
              <small>当前镜头不要求结束参考帧；是否生成结束参考帧由分镜规划决定。</small>
            </div>
          )}
          <label className="prompt-subfield">
            <span>转场提示</span>
            <input
              value={transitionHintValue}
              onChange={(event) =>
                setTechnicalPromptDrafts((current) => ({
                  ...current,
                  [shot.id]: buildShotTechnicalDraft(shot, current[shot.id], {
                    transitionHint: event.target.value
                  })
                }))
              }
              placeholder="例如：cut / match cut / fade in"
            />
          </label>
        </div>
        <div className="prompt-block">
          <div className="prompt-block-head">
            <h5>声音与台词 Prompt</h5>
            <button
              className="button ghost mini-button"
              disabled={
                Boolean(project.runState.isRunning) ||
                audioPromptPending ||
                !audioPromptDirty ||
                !backgroundSoundPromptValue.trim() ||
                !speechPromptValue.trim()
              }
              onClick={() => void handleSaveAudioPrompts(shot.id)}
              type="button"
            >
              {audioPromptPending ? '保存中...' : '保存声音 Prompt'}
            </button>
          </div>
          <label className="prompt-subfield">
            <span>背景声音 Prompt</span>
            <textarea
              className="prompt-editor"
              rows={5}
              value={backgroundSoundPromptValue}
              onChange={(event) =>
                setAudioPromptDrafts((current) => ({
                  ...current,
                  [shot.id]: {
                    backgroundSoundPrompt: event.target.value,
                    speechPrompt: current[shot.id]?.speechPrompt ?? shot.speechPrompt
                  }
                }))
              }
              placeholder="输入这个镜头的背景声音 Prompt"
            />
          </label>
          <label className="prompt-subfield">
            <span>台词/旁白 Prompt</span>
            <textarea
              className="prompt-editor"
              rows={5}
              value={speechPromptValue}
              onChange={(event) =>
                setAudioPromptDrafts((current) => ({
                  ...current,
                  [shot.id]: {
                    backgroundSoundPrompt: current[shot.id]?.backgroundSoundPrompt ?? shot.backgroundSoundPrompt,
                    speechPrompt: event.target.value
                  }
                }))
              }
              placeholder="输入这个镜头的台词或旁白 Prompt"
            />
          </label>
        </div>
        <div className="asset-stack">
          <div className="asset-box">
            <span>输入图片</span>
            {imageAsset ? (
              <>
                <img src={assetUrl(imageAsset.relativePath)} alt={shot.title} />
                <a href={assetUrl(imageAsset.relativePath)} target="_blank" rel="noreferrer">
                  打开原图
                </a>
              </>
            ) : (
              <small>{longTakeContinuation ? '当前镜头会复用上一镜头视频尾帧作为输入首帧。' : '未生成'}</small>
            )}
          </div>
          <div className="asset-box">
            <span>视频片段</span>
            {selectedVideo ? (
              <>
                <video src={assetUrl(selectedVideo.relativePath)} controls playsInline />
                <a href={assetUrl(selectedVideo.relativePath)} target="_blank" rel="noreferrer">
                  打开片段
                </a>
                <div className="asset-audio-preview">
                  <strong>镜头配音</strong>
                  {audioAsset ? (
                    <>
                      <audio src={assetUrl(audioAsset.relativePath)} controls preload="none" />
                      <a href={assetUrl(audioAsset.relativePath)} target="_blank" rel="noreferrer">
                        打开配音
                      </a>
                    </>
                  ) : (
                    <small>当前镜头还没有已生成配音</small>
                  )}
                </div>
                {videoVersions.length > 1 ? (
                  <div className="inline-actions">
                    <button
                      className="button ghost mini-button"
                      disabled={selectedVideoIndex <= 0}
                      onClick={() =>
                        setVideoAssetVersionIndices((current) => ({
                          ...current,
                          [shot.id]: Math.max(0, selectedVideoIndex - 1)
                        }))
                      }
                      type="button"
                    >
                      较新
                    </button>
                    <button
                      className="button ghost mini-button"
                      disabled={selectedVideoIndex >= videoVersions.length - 1}
                      onClick={() =>
                        setVideoAssetVersionIndices((current) => ({
                          ...current,
                          [shot.id]: Math.min(videoVersions.length - 1, selectedVideoIndex + 1)
                        }))
                      }
                      type="button"
                    >
                      较旧
                    </button>
                    <small className="version-indicator">
                      {selectedVideoIndex + 1}/{videoVersions.length} · {formatTime(selectedVideo.createdAt)}
                    </small>
                  </div>
                ) : null}
                {!selectedVideoIsCurrent ? (
                  <button
                    className="button ghost mini-button"
                    disabled={Boolean(project.runState.isRunning) || videoSelectPending || videoGenerationDirty}
                    onClick={() => void handleSelectShotVideoVersion(shot.id, selectedVideo.relativePath)}
                    type="button"
                  >
                    {videoSelectPending ? '切换中...' : '设为当前版本'}
                  </button>
                ) : null}
              </>
            ) : (
              <small>未生成</small>
            )}
          </div>
        </div>
        <button
          className="button secondary"
          disabled={
            Boolean(project.runState.isRunning) ||
            videoGeneratePending ||
            videoSelectPending ||
            videoPromptPending ||
            technicalPromptPending ||
            audioPromptPending ||
            videoGenerationDirty ||
            (!imageAsset && !longTakeContinuation)
          }
          onClick={() => void handleGenerateShotVideo(shot.id)}
          type="button"
        >
          {videoGeneratePending ? '生成中...' : videoAsset ? '仅重新生成视频片段' : '仅生成视频片段'}
        </button>
      </article>
    );
  }

  function renderLibraryOutputDetail() {
    if (!selectedLibraryOutput) {
      return <div className="empty-card stage-detail-empty">当前筛选下还没有流程产物。先去项目页生成图片、视频或成片。</div>;
    }

    const asset = selectedLibraryOutput;

    return (
      <article className="shot-card stage-detail-card library-detail-card">
        <div className="stage-detail-head">
          <div>
            <span className="eyebrow">{assetKindLabel(asset.kind)}</span>
            <h4>{asset.projectTitle}</h4>
            <p>{libraryAssetLocationLabel(asset)}</p>
          </div>
          <div className="library-detail-status">
            <span className={`pill ${asset.kind === 'final' ? 'success' : 'running'}`}>{assetKindLabel(asset.kind)}</span>
            <small>{formatTime(asset.createdAt)}</small>
          </div>
        </div>
        {asset.kind === 'image' ? (
          <img className="library-detail-preview media-preview" src={assetUrl(asset.relativePath)} alt={asset.projectTitle} />
        ) : (
          <video
            className="library-detail-preview media-preview"
            src={assetUrl(asset.relativePath)}
            controls
            playsInline
            preload="metadata"
          />
        )}
        <dl className="shot-meta library-detail-meta">
          <div>
            <dt>来源项目</dt>
            <dd>{asset.projectTitle}</dd>
          </div>
          <div>
            <dt>定位</dt>
            <dd>{libraryAssetLocationLabel(asset)}</dd>
          </div>
          <div>
            <dt>资产类型</dt>
            <dd>{assetKindLabel(asset.kind)}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{formatTime(asset.createdAt)}</dd>
          </div>
        </dl>
        <div className="prompt-block">
          <h5>生成 Prompt</h5>
          <p className="multiline-text">{asset.prompt || '无提示词'}</p>
        </div>
        <div className="library-detail-actions">
          <button className="button ghost" onClick={() => handleOpenProject(asset.projectId)} type="button">
            打开项目
          </button>
          <a className="button button-link ghost" href={assetUrl(asset.relativePath)} target="_blank" rel="noreferrer">
            打开资源
          </a>
          {asset.kind === 'final' ? (
            <a className="button button-link secondary" href={finalVideoDownloadUrl(asset.projectId)}>
              下载成片
            </a>
          ) : null}
        </div>
      </article>
    );
  }

  function renderLibraryReferenceDetail() {
    if (!selectedLibraryReference) {
      return (
        <div className="empty-card stage-detail-empty">
          当前还没有已生成的{referenceCollectionLabel(assetLibrarySection)}资产。先去项目页的“资产提取”里生成。
        </div>
      );
    }

    const asset = selectedLibraryReference;

    return (
      <article className="reference-card stage-detail-card library-detail-card">
        <div className="stage-detail-head">
          <div>
            <span className="eyebrow">{referenceKindLabel(asset.kind)}</span>
            <h4>{asset.name}</h4>
            <p>{asset.summary || '暂无描述'}</p>
          </div>
          <div className="library-detail-status">
            <span className="pill success">{referenceKindLabel(asset.kind)}</span>
            <small>{formatTime(asset.createdAt)}</small>
          </div>
        </div>
        <img className="library-detail-preview media-preview" src={assetUrl(asset.relativePath)} alt={asset.name} />
        <dl className="shot-meta library-detail-meta">
          <div>
            <dt>来源项目</dt>
            <dd>{asset.projectTitle}</dd>
          </div>
          <div>
            <dt>资产类型</dt>
            <dd>{referenceKindLabel(asset.kind)}</dd>
          </div>
          <div>
            <dt>资源名称</dt>
            <dd>{asset.name}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{formatTime(asset.createdAt)}</dd>
          </div>
        </dl>
        <div className="prompt-block">
          <h5>资产摘要</h5>
          <p className="multiline-text">{asset.summary || '暂无描述'}</p>
        </div>
        <div className="prompt-block">
          <h5>生成 Prompt</h5>
          <p className="multiline-text">{asset.prompt || '无提示词'}</p>
        </div>
        <div className="library-detail-actions">
          <button className="button ghost" onClick={() => handleOpenProject(asset.projectId)} type="button">
            打开项目
          </button>
          <a className="button button-link ghost" href={assetUrl(asset.relativePath)} target="_blank" rel="noreferrer">
            打开资源
          </a>
        </div>
      </article>
    );
  }

  return (
    <div className="shell">
      <header className="hero panel">
        <div>
          <span className="eyebrow">Short Drama Pipeline</span>
          <h1>MovieGen</h1>
          <p>
            一套六阶段工作台：文字到剧本，剧本到资产，资产到分镜，分镜到图片，图片到视频，最后剪出完整成片。
          </p>
        </div>
        <div className="hero-side">
          <div className="hero-actions">
            <div className="env-card">
              <span>文本模型</span>
              <strong>{meta?.envStatus.llmConfigured ? '已配置' : '未配置'}</strong>
            </div>
            <div className="env-card">
              <span>ComfyUI</span>
              <strong>{meta?.envStatus.comfyuiConfigured ? '已连接地址' : '未配置地址'}</strong>
            </div>
            <div className="env-card">
              <span>FFmpeg</span>
              <strong>{meta?.envStatus.ffmpegReady ? '可用' : '缺失'}</strong>
            </div>
          </div>
          <div className="hero-toolbar">
            <div className="tabs-bar hero-tabs">
              <button
                className={`tab-button ${activeTab === 'projects' ? 'active' : ''}`}
                onClick={() => setActiveTab('projects')}
                type="button"
              >
                项目
              </button>
              <button
                className={`tab-button ${activeTab === 'assets' ? 'active' : ''}`}
                onClick={() => setActiveTab('assets')}
                type="button"
              >
                资产库
              </button>
            </div>
            <button className="button ghost settings-trigger" onClick={() => setSettingsOpen(true)} type="button">
              系统设置
            </button>
          </div>
        </div>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}

      {activeTab === 'projects' ? (
        <main className="workspace workspace-single">
          <section className="main panel">
            {selectedId && project && draft && project.id === selectedId ? (
              <>
                <div className="project-header">
                  <div className="project-header-copy">
                    <button className="button ghost project-back-button" onClick={() => clearProjectWorkspace()} type="button">
                      返回项目列表
                    </button>
                    <span className="eyebrow">Project Workspace</span>
                    <h2>{project.title}</h2>
                    <p>
                      创建于 {formatTime(project.createdAt)}，最近更新 {formatTime(project.updatedAt)}
                    </p>
                  </div>
                  <div className="header-actions">
                    <button
                      className={`button ghost ${projectStageTab === 'logs' ? 'active-view' : ''}`}
                      onClick={() => setProjectStageTab('logs')}
                      type="button"
                    >
                      执行日志
                    </button>
                    <button
                      className={`button ghost ${projectSettingsOpen ? 'active-view' : ''}`}
                      onClick={() => setProjectSettingsOpen(true)}
                      type="button"
                    >
                      项目设置
                    </button>
                    <button
                      className="button danger"
                      disabled={Boolean(project.runState.isRunning) || pending === `delete-project:${project.id}`}
                      onClick={() => void handleDeleteProject(project.id, project.title)}
                      type="button"
                    >
                      {pending === `delete-project:${project.id}` ? '删除中...' : '删除项目'}
                    </button>
                    <button
                      className="button ghost"
                      disabled={Boolean(project.runState.isRunning) || pending === 'save'}
                      onClick={() => void handleSaveProject()}
                    >
                      {pending === 'save' ? '保存中...' : '保存项目'}
                    </button>
                    {project.runState.isRunning ? (
                      <>
                        {project.runState.requestedStage === 'all' ? (
                          <button
                            className="button secondary"
                            disabled={
                              project.runState.pauseRequested || project.runState.stopRequested || pending === 'pause-all'
                            }
                            onClick={() => void handlePauseProjectRun()}
                            type="button"
                          >
                            {project.runState.pauseRequested || pending === 'pause-all' ? '暂停中...' : '暂停'}
                          </button>
                        ) : null}
                        <button
                          className="button danger"
                          disabled={project.runState.stopRequested || pending === 'stop-all'}
                          onClick={() => void handleStopProjectRun()}
                          type="button"
                        >
                          {project.runState.stopRequested || pending === 'stop-all' ? '停止中...' : '停止'}
                        </button>
                      </>
                    ) : (
                      <>
                        {showContinueToCompletion ? (
                          <button
                            className="button primary"
                            disabled={Boolean(project.runState.isRunning) || pending === 'continue-all'}
                            onClick={() => void handleContinueProjectRun()}
                            type="button"
                          >
                            {pending === 'continue-all' ? '继续中...' : '继续执行到完成'}
                          </button>
                        ) : null}
                        {!project.runState.isPaused ? (
                          <button
                            className={`button ${showContinueToCompletion ? 'secondary' : 'primary'}`}
                            disabled={Boolean(project.runState.isRunning) || pending === 'all'}
                            onClick={() => void handleRunStage('all')}
                            type="button"
                          >
                            {pending === 'all' ? '提交中...' : '执行全流程'}
                          </button>
                        ) : project.runState.requestedStage === 'all' ? null : (
                          <button
                            className="button primary"
                            disabled={pending === 'resume-all'}
                            onClick={() => void handleResumeProjectRun()}
                            type="button"
                          >
                            {pending === 'resume-all' ? '继续中...' : '继续全流程'}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="status-strip">
                  {meta ? (
                    <>
                      <div className="status-item">
                        <span>参考资产工作流</span>
                        <strong>{referenceWorkflowReadyCount}/3 已就绪</strong>
                      </div>
                      <div className="status-item">
                        <span>分镜/视频工作流</span>
                        <strong>{productionWorkflowReadyCount}/4 已就绪</strong>
                      </div>
                      <div className="status-item">
                        <span>TTS 工作流</span>
                        <strong>{ttsWorkflowStatusLabel}</strong>
                      </div>
                      <div className="status-item">
                        <span>当前运行</span>
                        <strong>
                          {project.runState.isRunning
                            ? project.runState.currentStage
                              ? `${STAGE_LABELS[project.runState.currentStage]}${
                                  project.runState.stopRequested ? '（停止中）' : project.runState.pauseRequested ? '（暂停中）' : ''
                                }`
                              : project.runState.stopRequested
                                ? '排队中（停止中）'
                                : project.runState.pauseRequested
                                  ? '排队中（暂停中）'
                                : '排队中'
                            : project.runState.isPaused
                              ? `已暂停 · 下一阶段 ${STAGE_LABELS[nextProjectStage(project)]}`
                              : '无'}
                        </strong>
                      </div>
                    </>
                  ) : null}
                </div>

                <section className="project-stage-tabs">
                  {STAGES.map((stage) => {
                    const state = project.stages[stage];
                    return (
                      <button
                        key={stage}
                        className={`stage-tab ${projectStageTab === stage ? 'active' : ''} status-${state.status}`}
                        onClick={() => setProjectStageTab(stage)}
                        type="button"
                      >
                        <span className="stage-tab-index">{String(STAGES.indexOf(stage) + 1).padStart(2, '0')}</span>
                        <span className="stage-tab-copy">
                          <strong>{STAGE_LABELS[stage]}</strong>
                          <small>{statusLabel(state.status)}</small>
                        </span>
                      </button>
                    );
                  })}
                </section>

                <section className="panel inset stage-focus">
                  <div className="stage-focus-head">
                    <div>
                      <span className="eyebrow">
                        {isStageTab(projectStageTab) ? `Stage ${String(activeTabIndex).padStart(2, '0')}` : 'Logs'}
                      </span>
                      <h3>{TAB_LABELS[projectStageTab]}</h3>
                      <p>{TAB_DESCRIPTIONS[projectStageTab]}</p>
                    </div>
                    {isStageTab(projectStageTab) ? (
                      <button
                        className="button secondary"
                        disabled={Boolean(project.runState.isRunning) || pending === projectStageTab}
                        onClick={() => void handleRunStage(projectStageTab)}
                      >
                        {pending === projectStageTab ? '提交中...' : `执行${STAGE_LABELS[projectStageTab]}`}
                      </button>
                    ) : null}
                  </div>

                  <div className="status-strip">
                    <div className="status-item">
                      <span>{isStageTab(projectStageTab) ? '阶段状态' : '日志总数'}</span>
                      <strong>{isStageTab(projectStageTab) ? (activeStageState ? statusLabel(activeStageState.status) : '-') : project.logs.length}</strong>
                    </div>
                    <div className="status-item">
                      <span>{isStageTab(projectStageTab) ? '开始时间' : '最新记录'}</span>
                      <strong>
                        {isStageTab(projectStageTab)
                          ? activeStageState
                            ? formatTime(activeStageState.startedAt)
                            : '-'
                          : project.logs.length
                            ? formatTime(project.logs[project.logs.length - 1]?.createdAt)
                            : '-'}
                      </strong>
                    </div>
                    <div className="status-item">
                      <span>{isStageTab(projectStageTab) ? '完成时间' : '错误数量'}</span>
                      <strong>
                        {isStageTab(projectStageTab)
                          ? activeStageState
                            ? formatTime(activeStageState.finishedAt)
                            : '-'
                          : project.logs.filter((entry) => entry.level === 'error').length}
                      </strong>
                    </div>
                  </div>

                  {activeStageState?.error ? <div className="error-box">{activeStageState.error}</div> : null}
                </section>

                {projectStageTab === 'script' ? (
                  <section className="content-grid">
                    <article className="panel inset project-script-summary">
                      <div className="section-head">
                        <h3>剧本输入</h3>
                        <button className="button ghost mini-button" onClick={() => setProjectSettingsOpen(true)} type="button">
                          编辑项目设置
                        </button>
                      </div>
                      <div className="status-strip">
                        <div className="status-item">
                          <span>剧本模式</span>
                          <strong>{SCRIPT_MODE_LABELS[draft.settings.scriptMode]}</strong>
                        </div>
                        <div className="status-item">
                          <span>输出语言</span>
                          <strong>{draft.settings.language}</strong>
                        </div>
                        <div className="status-item">
                          <span>画幅与分辨率</span>
                          <strong>{draftFormatSummary}</strong>
                        </div>
                        <div className="status-item">
                          <span>项目篇幅</span>
                          <strong>{STORY_LENGTH_LABELS[draft.settings.storyLength]}</strong>
                        </div>
                        <div className="status-item">
                          <span>单次视频上限（系统）</span>
                          <strong>{effectiveMaxVideoSegmentDurationSeconds}s</strong>
                        </div>
                      </div>
                      <div className="prompt-block">
                        <h5>创作方向</h5>
                        <p className="multiline-text">
                          {`受众：${draft.settings.audience}
语气：${draft.settings.tone}
视觉：${draft.settings.visualStyle}
反向提示词：${draft.settings.negativePrompt}`}
                        </p>
                      </div>
                      <div className="prompt-block">
                        <h5>{draftSourceLabel}</h5>
                        <p className="multiline-text">
                          {draft.sourceText.trim() || '当前项目还没有输入内容，请在“项目设置”里补充剧情素材或待优化文本。'}
                        </p>
                      </div>
                    </article>

                    <article className="panel inset">
                    <div className="section-head">
                      <h3>剧本</h3>
                      <span>
                        {project.artifacts.scriptJson ? (
                          <a href={assetUrl(project.artifacts.scriptJson)} target="_blank" rel="noreferrer">
                            查看 JSON
                          </a>
                        ) : (
                          '等待生成'
                        )}
                      </span>
                    </div>
                    {project.script ? (
                      <pre className="content-block">{project.script.markdown}</pre>
                    ) : (
                      <div className="empty-card">执行第一阶段后会在这里显示完整剧本。</div>
                    )}
                    </article>
                  </section>
                ) : null}

                {projectStageTab === 'assets' ? (
                  <section className="panel inset">
                    <div className="section-head">
                      <h3>资产候选与参考图</h3>
                      <span>
                        {project.artifacts.referenceLibraryJson ? (
                          <a href={assetUrl(project.artifacts.referenceLibraryJson)} target="_blank" rel="noreferrer">
                            查看提取结果
                          </a>
                        ) : (
                          '等待资产阶段执行'
                        )}
                      </span>
                    </div>
                    <div className="status-strip">
                      <div className="status-item">
                        <span>候选总数</span>
                        <strong>{referenceItems.length}</strong>
                      </div>
                      <div className="status-item">
                        <span>已生成参考图</span>
                        <strong>{generatedReferenceCount}</strong>
                      </div>
                      <div className="status-item">
                        <span>失败项</span>
                        <strong>{failedReferenceCount}</strong>
                      </div>
                      <div className="status-item">
                        <span>工作流就绪</span>
                        <strong>{referenceWorkflowReadyCount}/3</strong>
                      </div>
                    </div>
                    {referenceEntries.length ? (
                      <div className="stage-browser">
                        <aside className="stage-browser-sidebar">
                          <div className="section-head stage-browser-sidebar-head">
                            <h4>候选列表</h4>
                            <span>{referenceEntries.length} 项</span>
                          </div>
                          <div className="stage-browser-list">
                            {referenceEntries.map((entry) => {
                              const previewAsset = getReferenceItemPreviewAsset(entry.item);
                              const isActive = selectedReferenceEntry?.selectionId === entry.selectionId;

                              return (
                                <button
                                  key={entry.selectionId}
                                  className={`stage-browser-item ${isActive ? 'active' : ''}`}
                                  onClick={() => setSelectedReferenceItemId(entry.selectionId)}
                                  type="button"
                                >
                                  <div className="stage-browser-thumb">
                                    {previewAsset ? (
                                      <img src={assetUrl(previewAsset.relativePath)} alt={entry.item.name} />
                                    ) : (
                                      <div className="stage-browser-thumb-placeholder">
                                        <span>{referenceKindLabel(entry.kind)}</span>
                                      </div>
                                    )}
                                  </div>
                                  <div className="stage-browser-copy">
                                    <div className="stage-browser-copy-top">
                                      <strong>{entry.item.name}</strong>
                                      <span className={`pill ${entry.item.status}`}>{statusLabel(entry.item.status)}</span>
                                    </div>
                                    <small>{referenceKindLabel(entry.kind)}</small>
                                    <p>{truncateText(entry.item.summary || entry.item.generationPrompt, 78)}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </aside>
                        <div className="stage-browser-detail">{renderReferenceDetail()}</div>
                      </div>
                    ) : (
                      <div className="empty-card">执行资产生成阶段后，左侧会列出角色、场景和物品候选。</div>
                    )}
                  </section>
                ) : null}

                {projectStageTab === 'storyboard' ? (
                  <section className="panel inset">
                    <div className="section-head">
                      <h3>分镜列表</h3>
                      <span>
                        {project.artifacts.storyboardJson ? (
                          <a href={assetUrl(project.artifacts.storyboardJson)} target="_blank" rel="noreferrer">
                            下载分镜 JSON
                          </a>
                        ) : (
                          '等待分镜生成'
                        )}
                      </span>
                    </div>
                    <div className="status-strip">
                      <div className="status-item">
                        <span>镜头总数</span>
                        <strong>{project.storyboard.length}</strong>
                      </div>
                      <div className="status-item">
                        <span>场景数量</span>
                        <strong>{new Set(project.storyboard.map((shot) => shot.sceneNumber)).size}</strong>
                      </div>
                      <div className="status-item">
                        <span>镜头编号</span>
                        <strong>由 LLM 自行决定</strong>
                      </div>
                    </div>
                    {project.storyboard.length ? (
                      <div className="stage-browser">
                        <aside className="stage-browser-sidebar">
                          <div className="section-head stage-browser-sidebar-head">
                            <h4>镜头列表</h4>
                            <span>{project.storyboard.length} 条</span>
                          </div>
                          <div className="stage-browser-list">
                            {project.storyboard.map((shot) => {
                              const previewAsset = getShotPreviewAsset(project, shot, imageMap.get(shot.id) ?? null);
                              const isActive = selectedStoryboardShot?.id === shot.id;

                              return (
                                <button
                                  key={shot.id}
                                  className={`stage-browser-item ${isActive ? 'active' : ''}`}
                                  onClick={() => setSelectedStoryboardShotId(shot.id)}
                                  type="button"
                                >
                                  <div className="stage-browser-thumb">
                                    {previewAsset ? (
                                      <img src={assetUrl(previewAsset.relativePath)} alt={shot.title} />
                                    ) : (
                                      <div className="stage-browser-thumb-placeholder">
                                        <span>{`S${shot.sceneNumber}`}</span>
                                        <strong>{`#${shot.shotNumber}`}</strong>
                                      </div>
                                    )}
                                  </div>
                                  <div className="stage-browser-copy">
                                    <div className="stage-browser-copy-top">
                                      <strong>{shot.title}</strong>
                                      <span className={`pill ${imageMap.has(shot.id) ? 'success' : ''}`}>
                                        {imageMap.has(shot.id) ? '有缩略图' : '待生成'}
                                      </span>
                                    </div>
                                    <small>
                                      {`S${shot.sceneNumber} · #${shot.shotNumber} · ${formatShotTimeline(shot)}`}
                                      {shot.dialogueIdentifier?.groupId ? ` · 对话 ${formatDialogueIdentifier(shot)}` : ''}
                                    </small>
                                    <p>{truncateText(shot.purpose, 78)}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </aside>
                        <div className="stage-browser-detail">{renderStoryboardDetail()}</div>
                      </div>
                    ) : (
                      <div className="empty-card">执行第 2 阶段后会在这里显示完整分镜。</div>
                    )}
                  </section>
                ) : null}

                {projectStageTab === 'shots' ? (
                  <section className="panel inset">
                    <div className="section-head">
                      <h3>镜头生成</h3>
                      <span>{project.storyboard.length ? `${readyVideoCount}/${project.storyboard.length} 视频已生成` : '等待分镜生成'}</span>
                    </div>
                    <div className="status-strip">
                      <div className="status-item">
                        <span>参考帧</span>
                        <strong>{readyImageCount}</strong>
                      </div>
                      <div className="status-item">
                        <span>视频片段</span>
                        <strong>{readyVideoCount}</strong>
                      </div>
                      <div className="status-item">
                        <span>参考帧工作流</span>
                        <strong>{storyboardImageWorkflowReady ? '已就绪' : '未配置'}</strong>
                      </div>
                      <div className="status-item">
                        <span>视频工作流</span>
                        <strong>{shotVideoWorkflowReady ? '已就绪' : '未配置'}</strong>
                      </div>
                    </div>
                    {project.storyboard.length ? (
                      <div className="stage-browser">
                        <aside className="stage-browser-sidebar">
                          <div className="section-head stage-browser-sidebar-head">
                            <h4>镜头列表</h4>
                            <span>{project.storyboard.length} 条</span>
                          </div>
                          <div className="stage-browser-list">
                            {project.storyboard.map((shot) => {
                              const longTakeContinuation = isLongTakeContinuationShot(project, shot);
                              const imageAsset = imageMap.get(shot.id) ?? null;
                              const previewAsset = getShotPreviewAsset(project, shot, imageAsset);
                              const videoAsset = videoMap.get(shot.id) ?? null;
                              const firstFramePromptValue =
                                technicalPromptDrafts[shot.id]?.firstFramePrompt ?? shot.firstFramePrompt;
                              const imageVersions = getShotAssetVersions(project, 'images', shot.id);
                              const videoVersions = getShotAssetVersions(project, 'videos', shot.id);
                              const isActive = selectedImageShot?.id === shot.id || selectedVideoShot?.id === shot.id;

                              return (
                                <button
                                  key={shot.id}
                                  className={`stage-browser-item ${isActive ? 'active' : ''}`}
                                  onClick={() => {
                                    setSelectedImageShotId(shot.id);
                                    setSelectedVideoShotId(shot.id);
                                  }}
                                  type="button"
                                >
                                  <div className="stage-browser-thumb">
                                    {previewAsset ? (
                                      <img src={assetUrl(previewAsset.relativePath)} alt={shot.title} />
                                    ) : (
                                      <div className="stage-browser-thumb-placeholder">
                                        <span>{`S${shot.sceneNumber}`}</span>
                                        <strong>{`#${shot.shotNumber}`}</strong>
                                      </div>
                                    )}
                                  </div>
                                  <div className="stage-browser-copy">
                                    <div className="stage-browser-copy-top">
                                      <strong>{shot.title}</strong>
                                      <span className={`pill ${videoAsset ? 'success' : imageAsset ? 'running' : ''}`}>
                                        {videoAsset
                                          ? '视频已生成'
                                          : imageAsset
                                            ? '已生成参考帧'
                                            : imageVersions.length || videoVersions.length
                                              ? '历史版本'
                                              : '待生成'}
                                      </span>
                                    </div>
                                    <small>
                                      {`S${shot.sceneNumber} · #${shot.shotNumber} · ${formatShotTimeline(shot)}`}
                                      {shot.longTakeIdentifier
                                        ? ` · ${longTakeContinuation ? '长镜头承接' : '长镜头起始'} ${shot.longTakeIdentifier}`
                                        : ''}
                                    </small>
                                    <p>{truncateText(firstFramePromptValue, 78)}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </aside>
                        <div className="stage-browser-detail">
                          {renderImageDetail()}
                          {renderVideoDetail()}
                        </div>
                      </div>
                    ) : (
                      <div className="empty-card">执行第 4 阶段后，才能在这里查看参考帧与视频片段。</div>
                    )}
                  </section>
                ) : null}

                {projectStageTab === 'edit' ? (
                  <section className="panel inset">
                    <div className="section-head">
                      <h3>最终成片</h3>
                      <span>{project.assets.finalVideo ? '已导出' : '等待剪辑'}</span>
                    </div>
                    <div className="status-strip">
                      <div className="status-item">
                        <span>视频片段</span>
                        <strong>{readyVideoCount}/{project.storyboard.length || 0}</strong>
                      </div>
                      <div className="status-item">
                        <span>TTS 工作流</span>
                        <strong>{ttsWorkflowConfigLabel}</strong>
                      </div>
                      <div className="status-item">
                        <span>导出状态</span>
                        <strong>{project.assets.finalVideo ? '已完成' : '待执行'}</strong>
                      </div>
                    </div>
                    {project.assets.finalVideo ? (
                      <div className="final-video">
                        <video src={assetUrl(project.assets.finalVideo.relativePath)} controls playsInline />
                        <div className="final-video-actions">
                          <a className="button secondary button-link" href={finalVideoDownloadUrl(project.id)}>
                            下载视频
                          </a>
                          <a
                            className="button ghost button-link"
                            href={assetUrl(project.assets.finalVideo.relativePath)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开最终视频
                          </a>
                        </div>
                      </div>
                    ) : (
                      <div className="empty-card">执行第 5 阶段后会在这里预览最终成片。</div>
                    )}
                  </section>
                ) : null}

                {projectStageTab === 'logs' ? (
                  <section className="panel inset">
                    <div className="section-head">
                      <h3>执行日志</h3>
                      <span>{project.logs.length} 条</span>
                    </div>
                    {project.logs.length ? (
                      <div className="log-list">
                        {[...project.logs].reverse().map((entry) => (
                          <div key={entry.id} className={`log-item ${entry.level}`}>
                            <strong>{entry.level.toUpperCase()}</strong>
                            <span>{entry.message}</span>
                            <small>{formatTime(entry.createdAt)}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-card">执行阶段后会在这里持续记录日志。</div>
                    )}
                  </section>
                ) : null}
              </>
            ) : (
              <section className="project-browser">
                <div className="project-browser-head">
                  <div>
                    <span className="eyebrow">Projects</span>
                    <h2>项目列表</h2>
                    <p>所有项目都在这里平铺展示。点击任一项目卡片后，整个项目 tab 会切换到该项目的工作区。</p>
                  </div>
                  <span className="project-browser-count">{projects.length} 个项目</span>
                </div>

                <div className="project-browser-grid">
                  <button className="project-card project-card-create" onClick={() => setCreateProjectOpen(true)} type="button">
                    <div className="project-card-top">
                      <span className="pill success">快速开始</span>
                      <small>New Project</small>
                    </div>
                    <div className="project-card-body">
                      <strong>新增项目</strong>
                      <p>打开创建菜单，填写素材、剧本模式、画幅和分辨率，创建后直接进入项目工作区。</p>
                    </div>
                    <div className="project-card-meta">
                      <span>支持先设定输入文本，再逐阶段推进完整生产流程。</span>
                      <small>创建后可在项目设置中继续调整参数</small>
                    </div>
                  </button>

                  {projects.map((item) => {
                    const status = projectCardStatus(item);
                    const deletePending = pending === `delete-project:${item.id}`;

                    return (
                      <div key={item.id} className="project-card-shell">
                        <button className="project-card" onClick={() => handleOpenProject(item.id)} type="button">
                          <div className="project-card-top">
                            <span className={`pill ${status.badgeTone}`}>{status.badge}</span>
                          </div>
                          <div className="project-card-body">
                            <strong>{item.title}</strong>
                            <p>{createFormatSummary(item.settings)}</p>
                          </div>
                          <div className="project-card-meta">
                            <span>{status.detail}</span>
                            <span>{`分镜 ${item.storyboard.length} · 图片 ${item.assets.images.length} · 视频 ${item.assets.videos.length}`}</span>
                            <small>{`更新于 ${formatTime(item.updatedAt)}`}</small>
                          </div>
                        </button>
                        <button
                          className="button danger mini-button project-card-delete"
                          disabled={Boolean(item.runState.isRunning) || deletePending}
                          onClick={() => void handleDeleteProject(item.id, item.title)}
                          type="button"
                        >
                          {deletePending ? '删除中...' : '删除'}
                        </button>
                      </div>
                    );
                  })}
                </div>

                {!projects.length ? <div className="empty-card">还没有项目，先创建一个。</div> : null}
              </section>
            )}
          </section>
        </main>
      ) : (
        <main className="workspace workspace-single">
          <section className="main panel">
            <>
              <div className="library-header">
                <div>
                  <span className="eyebrow">Asset Library</span>
                  <h2>资产库</h2>
                  <p>聚合全部项目的流程产物、角色、场景和物品资产，可快速预览并跳转到来源项目。</p>
                </div>
                <div className="hero-actions library-stats">
                  <div className="env-card">
                    <span>总资产</span>
                    <strong>{libraryCounts.total}</strong>
                  </div>
                  <div className="env-card">
                    <span>流程产物</span>
                    <strong>{libraryCounts.outputs}</strong>
                  </div>
                  <div className="env-card">
                    <span>角色/场景/物品</span>
                    <strong>{libraryCounts.characters + libraryCounts.scenes + libraryCounts.objects}</strong>
                  </div>
                </div>
              </div>

              <section className="panel inset">
                <div className="library-toolbar">
                  <button
                    className={`tab-button ${assetLibrarySection === 'outputs' ? 'active' : ''}`}
                    onClick={() => setAssetLibrarySection('outputs')}
                  >
                    流程产物
                  </button>
                  <button
                    className={`tab-button ${assetLibrarySection === 'characters' ? 'active' : ''}`}
                    onClick={() => setAssetLibrarySection('characters')}
                  >
                    角色
                  </button>
                  <button
                    className={`tab-button ${assetLibrarySection === 'scenes' ? 'active' : ''}`}
                    onClick={() => setAssetLibrarySection('scenes')}
                  >
                    场景
                  </button>
                  <button
                    className={`tab-button ${assetLibrarySection === 'objects' ? 'active' : ''}`}
                    onClick={() => setAssetLibrarySection('objects')}
                  >
                    物品
                  </button>
                </div>
                {assetLibrarySection === 'outputs' ? (
                  <>
                    <div className="library-subtoolbar">
                      <button
                        className={`tab-button ${assetFilter === 'all' ? 'active' : ''}`}
                        onClick={() => setAssetFilter('all')}
                      >
                        全部
                      </button>
                      <button
                        className={`tab-button ${assetFilter === 'image' ? 'active' : ''}`}
                        onClick={() => setAssetFilter('image')}
                      >
                        参考帧图
                      </button>
                      <button
                        className={`tab-button ${assetFilter === 'video' ? 'active' : ''}`}
                        onClick={() => setAssetFilter('video')}
                      >
                        片段视频
                      </button>
                      <button
                        className={`tab-button ${assetFilter === 'final' ? 'active' : ''}`}
                        onClick={() => setAssetFilter('final')}
                      >
                        最终成片
                      </button>
                    </div>
                    {filteredLibraryAssets.length ? (
                      <div className="stage-browser library-browser">
                        <aside className="stage-browser-sidebar">
                          <div className="section-head stage-browser-sidebar-head">
                            <div>
                              <h4>流程产物列表</h4>
                              <span>按当前筛选显示最新图片、视频和成片</span>
                            </div>
                            <span>{filteredLibraryAssets.length} 项</span>
                          </div>
                          <div className="stage-browser-list">
                            {filteredLibraryAssets.map((asset) => {
                              const isActive = selectedLibraryOutput?.id === asset.id;

                              return (
                                <button
                                  key={asset.id}
                                  className={`stage-browser-item ${isActive ? 'active' : ''}`}
                                  onClick={() => setSelectedLibraryOutputId(asset.id)}
                                  type="button"
                                >
                                  <div className="stage-browser-thumb">
                                    {asset.kind === 'image' ? (
                                      <img src={assetUrl(asset.relativePath)} alt={asset.projectTitle} />
                                    ) : (
                                      <video src={assetUrl(asset.relativePath)} muted playsInline preload="metadata" />
                                    )}
                                  </div>
                                  <div className="stage-browser-copy">
                                    <div className="stage-browser-copy-top">
                                      <strong>{asset.projectTitle}</strong>
                                      <span className={`pill ${asset.kind === 'final' ? 'success' : 'running'}`}>
                                        {assetKindLabel(asset.kind)}
                                      </span>
                                    </div>
                                    <small>
                                      {libraryAssetLocationLabel(asset)} · {formatTime(asset.createdAt)}
                                    </small>
                                    <p>{truncateText(asset.prompt || '无提示词', 78)}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </aside>
                        <div className="stage-browser-detail">{renderLibraryOutputDetail()}</div>
                      </div>
                    ) : (
                      <div className="empty-card">当前筛选下还没有流程产物。先去项目页生成图片、视频或成片。</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="library-subheader">
                      <span>{referenceCollectionLabel(assetLibrarySection)}</span>
                      <strong>{currentReferenceAssets.length} 个已生成资产</strong>
                    </div>
                    {currentReferenceAssets.length ? (
                      <div className="stage-browser library-browser">
                        <aside className="stage-browser-sidebar">
                          <div className="section-head stage-browser-sidebar-head">
                            <div>
                              <h4>{referenceCollectionLabel(assetLibrarySection)}列表</h4>
                              <span>按生成时间倒序浏览已生成资产</span>
                            </div>
                            <span>{currentReferenceAssets.length} 项</span>
                          </div>
                          <div className="stage-browser-list">
                            {currentReferenceAssets.map((asset) => {
                              const isActive = selectedLibraryReference?.id === asset.id;

                              return (
                                <button
                                  key={asset.id}
                                  className={`stage-browser-item ${isActive ? 'active' : ''}`}
                                  onClick={() => setSelectedLibraryReferenceId(asset.id)}
                                  type="button"
                                >
                                  <div className="stage-browser-thumb">
                                    <img src={assetUrl(asset.relativePath)} alt={asset.name} />
                                  </div>
                                  <div className="stage-browser-copy">
                                    <div className="stage-browser-copy-top">
                                      <strong>{asset.name}</strong>
                                      <span className="pill success">{referenceKindLabel(asset.kind)}</span>
                                    </div>
                                    <small>
                                      {asset.projectTitle} · {formatTime(asset.createdAt)}
                                    </small>
                                    <p>{truncateText(asset.summary || asset.prompt, 78)}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </aside>
                        <div className="stage-browser-detail">{renderLibraryReferenceDetail()}</div>
                      </div>
                    ) : (
                      <div className="empty-card">
                        当前还没有已生成的{referenceCollectionLabel(assetLibrarySection)}资产。先去项目页的“资产提取”里生成。
                      </div>
                    )}
                  </>
                )}
              </section>
            </>
          </section>
        </main>
      )}

      <SettingsDialog
        open={settingsOpen}
        draft={settingsDraft}
        status={meta?.envStatus ?? null}
        dirty={settingsDirty}
        pending={settingsPending}
        llmModels={llmModels}
        llmModelsPending={llmModelsPending}
        llmModelsError={llmModelsError}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsDraft(appSettings);
          setSettingsDirty(false);
          setLlmModelsError('');
        }}
        onSave={() => void handleSaveAppSettings()}
        onRefreshModels={() => setLlmModelsReloadKey((current) => current + 1)}
        onChange={(next) => {
          setSettingsDraft(next);
          setSettingsDirty(true);
        }}
      />

      {projectSettingsOpen && draft && project ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (pending !== 'save') {
              setProjectSettingsOpen(false);
            }
          }}
        >
          <div
            className="modal-panel panel"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">Project Settings</span>
                <h2>项目设置</h2>
                <p>统一管理项目标题、输入素材和生成参数。保存后会影响后续所有阶段。</p>
              </div>
              <button
                className="button ghost"
                disabled={pending === 'save'}
                onClick={() => setProjectSettingsOpen(false)}
                type="button"
              >
                关闭
              </button>
            </div>

            <section className="settings-section">
              <div className="section-head">
                <h3>项目信息</h3>
                <span>这里的内容会直接影响剧本生成入口和项目展示。</span>
              </div>
              <div className="form-grid">
                <label className="field span-2">
                  <span>项目标题</span>
                  <input
                    value={draft.title}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current ? { ...current, title: event.target.value } : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>剧本模式</span>
                  <select
                    value={draft.settings.scriptMode}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: {
                                ...current.settings,
                                scriptMode: event.target.value as ScriptMode
                              }
                            }
                          : current;
                      })
                    }
                  >
                    {SCRIPT_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {SCRIPT_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="format-preview">{draftFormatSummary}</div>
                <label className="field span-2">
                  <span>{draftSourceLabel}</span>
                  <textarea
                    rows={10}
                    value={draft.sourceText}
                    placeholder={scriptModeSourcePlaceholder(draft.settings.scriptMode)}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current ? { ...current, sourceText: event.target.value } : current;
                      })
                    }
                  />
                </label>
              </div>
            </section>

            <section className="settings-section">
              <div className="section-head">
                <h3>生成参数</h3>
                <span>用于剧本、资产、分镜、图片和视频阶段的统一默认参数。</span>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>语气风格</span>
                  <input
                    value={draft.settings.tone}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? { ...current, settings: { ...current.settings, tone: event.target.value } }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>受众</span>
                  <input
                    value={draft.settings.audience}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: { ...current.settings, audience: event.target.value }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>项目篇幅</span>
                  <select
                    value={draft.settings.storyLength}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: {
                                ...current.settings,
                                storyLength: event.target.value as ProjectSettings['storyLength']
                              }
                            }
                          : current;
                      })
                    }
                  >
                    {STORY_LENGTHS.map((storyLength) => (
                      <option key={storyLength} value={storyLength}>
                        {STORY_LENGTH_LABELS[storyLength]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field span-2">
                  <span>视觉风格</span>
                  <textarea
                    rows={3}
                    value={draft.settings.visualStyle}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: { ...current.settings, visualStyle: event.target.value }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field span-2">
                  <span>反向提示词</span>
                  <textarea
                    rows={2}
                    value={draft.settings.negativePrompt}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: { ...current.settings, negativePrompt: event.target.value }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>语言</span>
                  <input
                    value={draft.settings.language}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? { ...current, settings: { ...current.settings, language: event.target.value } }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>画幅</span>
                  <select
                    value={draft.settings.aspectRatio}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: applyAspectRatio(
                                current.settings,
                                event.target.value as ProjectSettings['aspectRatio']
                              )
                            }
                          : current;
                      })
                    }
                  >
                    {ASPECT_RATIOS.map((aspectRatio) => (
                      <option key={aspectRatio} value={aspectRatio}>
                        {ASPECT_RATIO_LABELS[aspectRatio]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>分辨率</span>
                  <select
                    value={draftResolutionPreset}
                    onChange={(event) =>
                      setDraft((current) => {
                        if (!current) {
                          return current;
                        }

                        const nextPreset = event.target.value as ResolutionSelectValue;
                        if (nextPreset === 'custom') {
                          return current;
                        }

                        setDraftDirty(true);
                        return {
                          ...current,
                          settings: applyResolutionPreset(current.settings, nextPreset)
                        };
                      })
                    }
                  >
                    {RESOLUTION_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">自定义</option>
                  </select>
                </label>
                <label className="field">
                  <span>图片宽度</span>
                  <input
                    type="number"
                    value={draft.settings.imageWidth}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: {
                                ...current.settings,
                                imageWidth: Number(event.target.value) || current.settings.imageWidth
                              }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>图片高度</span>
                  <input
                    type="number"
                    value={draft.settings.imageHeight}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: {
                                ...current.settings,
                                imageHeight: Number(event.target.value) || current.settings.imageHeight
                              }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>视频宽度</span>
                  <input
                    type="number"
                    value={draft.settings.videoWidth}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: {
                                ...current.settings,
                                videoWidth: Number(event.target.value) || current.settings.videoWidth
                              }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>视频高度</span>
                  <input
                    type="number"
                    value={draft.settings.videoHeight}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: {
                                ...current.settings,
                                videoHeight: Number(event.target.value) || current.settings.videoHeight
                              }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>FPS</span>
                  <input
                    type="number"
                    value={draft.settings.fps}
                    onChange={(event) =>
                      setDraft((current) => {
                        setDraftDirty(true);
                        return current
                          ? {
                              ...current,
                              settings: {
                                ...current.settings,
                                fps: Number(event.target.value) || current.settings.fps
                              }
                            }
                          : current;
                      })
                    }
                  />
                </label>
                <label className="field span-2">
                  <span>TTS 工作流</span>
                  <div className="inline-check">
                    <input
                      checked={draft.settings.useTtsWorkflow}
                      onChange={(event) =>
                        setDraft((current) => {
                          setDraftDirty(true);
                          return current
                            ? {
                                ...current,
                                settings: {
                                  ...current.settings,
                                  useTtsWorkflow: event.target.checked
                                }
                              }
                            : current;
                        })
                      }
                      type="checkbox"
                    />
                    <span>
                      启用独立 TTS 工作流。关闭后，台词会以“人物描述：对白”的格式直接输入到视频工作流；开启后，视频工作流只负责背景音/动作音与口型表演，台词由 TTS 单独生成。
                    </span>
                  </div>
                </label>
                <label className="field">
                  <span>镜头视频最长秒数（系统设置）</span>
                  <input
                    type="number"
                    value={effectiveMaxVideoSegmentDurationSeconds}
                    disabled
                  />
                </label>
              </div>
              <p className="settings-hint">
                项目篇幅会直接约束剧本阶段的目标场景数和总时长，并继续影响后续拆镜颗粒度。修改篇幅后，需要重新执行“剧本生成”，后续阶段才会基于新篇幅生效。这里显示的是当前系统允许的单个镜头视频硬上限；镜头时长超过该值时，需要在分镜阶段主动拆成多个镜头。
              </p>
              <p className="settings-hint">
                当前项目的 TTS 状态：{ttsWorkflowStatusLabel}。
              </p>
            </section>

            <div className="modal-actions">
              <span className="settings-dirty">{draftDirty ? '有未保存修改' : '项目设置已同步'}</span>
              <div className="modal-buttons">
                <button
                  className="button ghost"
                  disabled={pending === 'save'}
                  onClick={() => setProjectSettingsOpen(false)}
                  type="button"
                >
                  关闭
                </button>
                <button
                  className="button primary"
                  disabled={Boolean(project.runState.isRunning) || pending === 'save'}
                  onClick={() => void handleSaveProject({ closeAfterSave: true })}
                  type="button"
                >
                  {pending === 'save' ? '保存中...' : '保存项目设置'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {createProjectOpen ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (pending !== 'create') {
              setCreateProjectOpen(false);
            }
          }}
        >
          <div
            className="modal-panel panel"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">New Project</span>
                <h2>新增项目</h2>
                <p>在这里填写素材和基础参数，确认后创建项目。</p>
              </div>
              <button
                className="button ghost"
                disabled={pending === 'create'}
                onClick={() => setCreateProjectOpen(false)}
                type="button"
              >
                关闭
              </button>
            </div>

            <section className="settings-section">
              <div className="form-grid">
                <label className="field span-2">
                  <span>项目标题</span>
                  <input
                    value={createTitle}
                    onChange={(event) => setCreateTitle(event.target.value)}
                    placeholder="例如：替身新娘复仇记"
                  />
                </label>
                <label className="field">
                  <span>剧本模式</span>
                  <select
                    value={createScriptMode}
                    onChange={(event) => setCreateScriptMode(event.target.value as ScriptMode)}
                  >
                    {SCRIPT_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {SCRIPT_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>画幅比例</span>
                  <select
                    value={createAspectRatio}
                    onChange={(event) => setCreateAspectRatio(event.target.value as ProjectSettings['aspectRatio'])}
                  >
                    {ASPECT_RATIOS.map((aspectRatio) => (
                      <option key={aspectRatio} value={aspectRatio}>
                        {ASPECT_RATIO_LABELS[aspectRatio]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>项目篇幅</span>
                  <select
                    value={createStoryLength}
                    onChange={(event) => setCreateStoryLength(event.target.value as ProjectSettings['storyLength'])}
                  >
                    {STORY_LENGTHS.map((storyLength) => (
                      <option key={storyLength} value={storyLength}>
                        {STORY_LENGTH_LABELS[storyLength]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field span-2">
                  <span>{createScriptMode === 'generate' ? '剧情输入' : '待优化文本'}</span>
                  <textarea
                    value={createSource}
                    onChange={(event) => setCreateSource(event.target.value)}
                    placeholder={scriptModeSourcePlaceholder(createScriptMode)}
                    rows={10}
                  />
                </label>
                <label className="field">
                  <span>分辨率</span>
                  <select
                    value={createResolutionPreset}
                    onChange={(event) => setCreateResolutionPreset(event.target.value as ResolutionPresetId)}
                  >
                    {RESOLUTION_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="format-preview span-2">{createFormatSummary(createResolvedSettings)}</div>
              </div>
            </section>

            <div className="modal-actions">
              <span className="settings-dirty">创建后可在项目页继续调整参数。</span>
              <div className="modal-buttons">
                <button
                  className="button ghost"
                  disabled={pending === 'create'}
                  onClick={() => setCreateProjectOpen(false)}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="button primary"
                  disabled={pending === 'create' || !createSource.trim()}
                  onClick={() => void handleCreateProject()}
                  type="button"
                >
                  {pending === 'create' ? '创建中...' : '创建项目'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
