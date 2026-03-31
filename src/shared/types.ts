export const STAGES = ['script', 'storyboard', 'assets', 'shots', 'edit'] as const;
export const COMFYUI_WORKFLOW_TYPES = [
  'character_asset',
  'storyboard_image',
  'text_to_image',
  'reference_image_to_image',
  'image_edit',
  'text_to_video',
  'image_to_video_first_last',
  'image_to_video_first_frame',
  'tts'
] as const;
export const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'] as const;
export const SCRIPT_MODES = ['generate', 'optimize'] as const;
export const STORY_LENGTHS = ['test', 'short', 'medium', 'long'] as const;

export type StageId = (typeof STAGES)[number];
export type ComfyWorkflowType = (typeof COMFYUI_WORKFLOW_TYPES)[number];
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type ScriptMode = (typeof SCRIPT_MODES)[number];
export type StoryLength = (typeof STORY_LENGTHS)[number];
export type RunStage = StageId | 'all';
export type StageStatus = 'idle' | 'running' | 'success' | 'error';
export type LogLevel = 'info' | 'warn' | 'error';
export type ReferenceAssetKind = 'character' | 'scene' | 'object';

export interface ComfyWorkflowSettings {
  workflowPath: string;
}

export interface AppSettings {
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  comfyui: {
    baseUrl: string;
    workflows: Record<ComfyWorkflowType, ComfyWorkflowSettings>;
    pollIntervalMs: number;
    timeoutMs: number;
    maxVideoSegmentDurationSeconds: number;
  };
  ffmpeg: {
    binaryPath: string;
  };
}

export interface RuntimeStatus {
  llmConfigured: boolean;
  comfyuiConfigured: boolean;
  characterAssetWorkflowExists: boolean;
  storyboardImageWorkflowExists: boolean;
  textToImageWorkflowExists: boolean;
  referenceImageToImageWorkflowExists: boolean;
  imageEditWorkflowExists: boolean;
  textToVideoWorkflowExists: boolean;
  imageToVideoFirstLastWorkflowExists: boolean;
  imageToVideoFirstFrameWorkflowExists: boolean;
  ttsWorkflowExists: boolean;
  ffmpegReady: boolean;
}

export interface LlmModelDiscoveryRequest {
  baseUrl: string;
  apiKey: string;
}

export interface LlmModelDiscoveryResponse {
  models: string[];
}

export interface StageState {
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface ProjectSettings {
  scriptMode: ScriptMode;
  storyLength: StoryLength;
  language: string;
  tone: string;
  audience: string;
  visualStyle: string;
  negativePrompt: string;
  aspectRatio: AspectRatio;
  imageWidth: number;
  imageHeight: number;
  videoWidth: number;
  videoHeight: number;
  fps: number;
  maxVideoSegmentDurationSeconds: number;
  maxShotsPerScene: number;
  useTtsWorkflow: boolean;
}

export interface ScriptCharacter {
  name: string;
  identity: string;
  visualTraits: string;
  motivation: string;
}

export interface ScriptDialogueLine {
  character: string;
  line: string;
  performanceNote: string;
}

export type ScriptSceneBlockType = 'action' | 'dialogue' | 'voiceover' | 'transition';

export interface ScriptSceneActionBlock {
  type: 'action';
  text: string;
}

export interface ScriptSceneDialogueBlock {
  type: 'dialogue';
  character: string;
  text: string;
  parenthetical: string;
}

export interface ScriptSceneVoiceoverBlock {
  type: 'voiceover';
  character: string;
  text: string;
}

export interface ScriptSceneTransitionBlock {
  type: 'transition';
  text: string;
}

export type ScriptSceneBlock =
  | ScriptSceneActionBlock
  | ScriptSceneDialogueBlock
  | ScriptSceneVoiceoverBlock
  | ScriptSceneTransitionBlock;

export interface ScriptScene {
  sceneNumber: number;
  sceneHeading: string;
  location: string;
  timeOfDay: string;
  summary: string;
  emotionalBeat: string;
  conflict: string;
  turningPoint: string;
  voiceover: string;
  durationSeconds: number;
  dialogue: ScriptDialogueLine[];
  scriptBlocks: ScriptSceneBlock[];
}

export interface ScriptPackage {
  title: string;
  tagline: string;
  synopsis: string;
  styleNotes: string;
  characters: ScriptCharacter[];
  scenes: ScriptScene[];
  markdown: string;
}

export type StoryboardDialogueFlowRole = 'single' | 'start' | 'middle' | 'end';

export interface StoryboardDialogueIdentifier {
  groupId: string;
  sequenceIndex: number;
  sequenceLength: number;
  flowRole: StoryboardDialogueFlowRole;
}

export interface StoryboardShot {
  id: string;
  sceneNumber: number;
  shotNumber: number;
  title: string;
  purpose: string;
  durationSeconds: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  startTimecode: string;
  endTimecode: string;
  dialogueIdentifier: StoryboardDialogueIdentifier | null;
  longTakeIdentifier: string | null;
  dialogue: string;
  voiceover: string;
  camera: string;
  composition: string;
  transitionHint: string;
  useLastFrameReference: boolean;
  firstFramePrompt: string;
  lastFramePrompt: string;
  videoPrompt: string;
  backgroundSoundPrompt: string;
  speechPrompt: string;
  referenceAssetIds: string[];
  manualReferenceAssetIds: string[];
  excludedReferenceAssetIds: string[];
}

export interface GeneratedAsset {
  shotId: string | null;
  sceneNumber: number | null;
  relativePath: string;
  prompt: string;
  createdAt: string;
}

export interface ShotAssetHistoryMap {
  [shotId: string]: GeneratedAsset[] | undefined;
}

export interface ReferenceAssetItem {
  id: string;
  kind: ReferenceAssetKind;
  name: string;
  summary: string;
  genderHint: string;
  ageHint: string;
  ethnicityHint: string;
  generationPrompt: string;
  status: StageStatus;
  error: string | null;
  updatedAt: string;
  referenceImage: GeneratedAsset | null;
  referenceAudio: GeneratedAsset | null;
  asset: GeneratedAsset | null;
  assetHistory: GeneratedAsset[];
}

export interface ProjectReferenceLibrary {
  characters: ReferenceAssetItem[];
  scenes: ReferenceAssetItem[];
  objects: ReferenceAssetItem[];
}

export interface ProjectArtifacts {
  scriptMarkdown: string | null;
  scriptJson: string | null;
  storyboardJson: string | null;
  referenceLibraryJson: string | null;
}

export interface ProjectLog {
  id: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

export interface ProjectRunState {
  isRunning: boolean;
  requestedStage: RunStage | null;
  currentStage: StageId | null;
  startedAt: string | null;
  pauseRequested: boolean;
  stopRequested: boolean;
  isPaused: boolean;
}

export interface Project {
  id: string;
  title: string;
  sourceText: string;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  stages: Record<StageId, StageState>;
  script: ScriptPackage | null;
  storyboard: StoryboardShot[];
  assets: {
    images: GeneratedAsset[];
    imageHistory: ShotAssetHistoryMap;
    lastImages: GeneratedAsset[];
    lastImageHistory: ShotAssetHistoryMap;
    audios: GeneratedAsset[];
    audioHistory: ShotAssetHistoryMap;
    videos: GeneratedAsset[];
    videoHistory: ShotAssetHistoryMap;
    finalVideo: GeneratedAsset | null;
  };
  referenceLibrary: ProjectReferenceLibrary;
  artifacts: ProjectArtifacts;
  logs: ProjectLog[];
  runState: ProjectRunState;
}

export interface AppMeta {
  defaults: ProjectSettings;
  stages: Array<{ id: StageId; label: string }>;
  envStatus: RuntimeStatus;
  workflowPaths: Record<ComfyWorkflowType, string>;
}

function normalizeReferenceSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s"'`“”‘’「」『』（）()【】[\]{}<>《》，,。.!！？?；;：:/\\|_-]+/g, '')
    .trim();
}

function normalizeDialogueIdentifierGroupId(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeLongTakeIdentifier(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeStoryboardDialogueFlowRole(
  value: unknown,
  fallback: StoryboardDialogueFlowRole
): StoryboardDialogueFlowRole {
  return value === 'single' || value === 'start' || value === 'middle' || value === 'end'
    ? value
    : fallback;
}

function deriveStoryboardDialogueFlowRole(
  sequenceIndex: number,
  sequenceLength: number
): StoryboardDialogueFlowRole {
  if (sequenceLength <= 1) {
    return 'single';
  }

  if (sequenceIndex <= 1) {
    return 'start';
  }

  if (sequenceIndex >= sequenceLength) {
    return 'end';
  }

  return 'middle';
}

export function normalizeStoryboardDialogueIdentifier(
  value: unknown,
  fallback: StoryboardDialogueIdentifier | null = null
): StoryboardDialogueIdentifier | null {
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const input = value as Partial<StoryboardDialogueIdentifier>;
  const groupId = normalizeDialogueIdentifierGroupId(input.groupId);

  if (!groupId) {
    return fallback;
  }

  const sequenceLength = normalizePositiveInteger(input.sequenceLength, fallback?.sequenceLength ?? 1);
  const sequenceIndex = Math.min(
    sequenceLength,
    normalizePositiveInteger(input.sequenceIndex, fallback?.sequenceIndex ?? 1)
  );
  const flowRole = normalizeStoryboardDialogueFlowRole(
    input.flowRole,
    deriveStoryboardDialogueFlowRole(sequenceIndex, sequenceLength)
  );

  return {
    groupId,
    sequenceIndex,
    sequenceLength,
    flowRole
  };
}

function normalizedTextMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeReferenceSearchText(left);
  const normalizedRight = normalizeReferenceSearchText(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function buildShotReferenceSearchTexts(shot: StoryboardShot): string[] {
  return [
    shot.title,
    shot.purpose,
    shot.dialogue,
    shot.voiceover,
    shot.camera,
    shot.composition,
    shot.transitionHint,
    shot.firstFramePrompt,
    shot.lastFramePrompt,
    shot.videoPrompt,
    shot.backgroundSoundPrompt,
    shot.speechPrompt
  ].filter(Boolean);
}

function buildSceneReferenceSearchTexts(scene: ScriptScene | null): string[] {
  if (!scene) {
    return [];
  }

  return [
    scene.sceneHeading,
    scene.location,
    scene.timeOfDay,
    scene.summary,
    scene.emotionalBeat,
    scene.conflict,
    scene.turningPoint,
    scene.voiceover,
    ...scene.dialogue.flatMap((line) => [line.character, line.line, line.performanceNote]),
    ...(scene.scriptBlocks ?? []).flatMap((block) => {
      if (block.type === 'dialogue') {
        return [block.character, block.parenthetical, block.text];
      }

      if (block.type === 'voiceover') {
        return [block.character, block.text];
      }

      return [block.text];
    })
  ].filter(Boolean);
}

function matchesAnySearchText(searchTexts: string[], candidate: string): boolean {
  return searchTexts.some((text) => normalizedTextMatches(text, candidate));
}

function buildReferenceSelectionId(kind: ReferenceAssetKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

function normalizeReferenceSelectionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

export function filterReferenceLibraryForShot(
  referenceLibrary: ProjectReferenceLibrary,
  shot: StoryboardShot,
  script: ScriptPackage | null
): ProjectReferenceLibrary {
  const scriptScene = script?.scenes.find((scene) => scene.sceneNumber === shot.sceneNumber) ?? null;
  const shotSearchTexts = buildShotReferenceSearchTexts(shot);
  const sceneSearchTexts = buildSceneReferenceSearchTexts(scriptScene);
  const dialogueText = normalizeReferenceSearchText(shot.dialogue);
  const matchedDialogueSpeakers = new Set(
    (scriptScene?.dialogue ?? [])
      .filter((line) => {
        const lineText = normalizeReferenceSearchText(line.line);
        return Boolean(dialogueText && lineText && (dialogueText.includes(lineText) || lineText.includes(dialogueText)));
      })
      .map((line) => normalizeReferenceSearchText(line.character))
      .filter(Boolean)
  );

  const characters = referenceLibrary.characters.filter((item) => {
    const normalizedName = normalizeReferenceSearchText(item.name);
    return (
      matchesAnySearchText(shotSearchTexts, item.name) ||
      matchesAnySearchText(sceneSearchTexts, item.name) ||
      (normalizedName ? matchedDialogueSpeakers.has(normalizedName) : false)
    );
  });

  const scenes = referenceLibrary.scenes.filter(
    (item) =>
      matchesAnySearchText(shotSearchTexts, item.name) ||
      matchesAnySearchText(sceneSearchTexts, item.name) ||
      matchesAnySearchText(sceneSearchTexts, item.summary)
  );

  const objects = referenceLibrary.objects.filter((item) => matchesAnySearchText(shotSearchTexts, item.name));

  return {
    characters:
      characters.length || referenceLibrary.characters.length !== 1 ? characters : referenceLibrary.characters.slice(0, 1),
    scenes: scenes.length || referenceLibrary.scenes.length !== 1 ? scenes : referenceLibrary.scenes.slice(0, 1),
    objects
  };
}

export function getGenerationReferenceLibraryForShot(
  referenceLibrary: ProjectReferenceLibrary,
  shot: StoryboardShot,
  script: ScriptPackage | null
): ProjectReferenceLibrary {
  const explicitReferenceIds = new Set(shot.referenceAssetIds);
  const autoMatched = filterReferenceLibraryForShot(referenceLibrary, shot, script);
  const manualReferenceIds = new Set(shot.manualReferenceAssetIds);
  const excludedReferenceIds = new Set(shot.excludedReferenceAssetIds);

  const explicitSelectionLibrary =
    explicitReferenceIds.size > 0
      ? {
          characters: referenceLibrary.characters.filter((item) =>
            explicitReferenceIds.has(buildReferenceSelectionId('character', item.id))
          ),
          scenes: referenceLibrary.scenes.filter((item) =>
            explicitReferenceIds.has(buildReferenceSelectionId('scene', item.id))
          ),
          objects: referenceLibrary.objects.filter((item) =>
            explicitReferenceIds.has(buildReferenceSelectionId('object', item.id))
          )
        }
      : autoMatched;

  const mergeCollection = (
    kind: ReferenceAssetKind,
    matchedItems: ReferenceAssetItem[],
    allItems: ReferenceAssetItem[]
  ): ReferenceAssetItem[] => {
    const nextItems = matchedItems.filter((item) => !excludedReferenceIds.has(buildReferenceSelectionId(kind, item.id)));
    const seen = new Set(nextItems.map((item) => buildReferenceSelectionId(kind, item.id)));

    for (const item of allItems) {
      const selectionId = buildReferenceSelectionId(kind, item.id);

      if (!manualReferenceIds.has(selectionId) || seen.has(selectionId)) {
        continue;
      }

      nextItems.push(item);
      seen.add(selectionId);
    }

    return nextItems;
  };

  return {
    characters: mergeCollection('character', explicitSelectionLibrary.characters, referenceLibrary.characters),
    scenes: mergeCollection('scene', explicitSelectionLibrary.scenes, referenceLibrary.scenes),
    objects: mergeCollection('object', explicitSelectionLibrary.objects, referenceLibrary.objects)
  };
}

export const STAGE_LABELS: Record<StageId, string> = {
  script: '剧本生成',
  storyboard: '分镜生成',
  assets: '资产生成',
  shots: '镜头生成',
  edit: '视频剪辑'
};

export const STORY_LENGTH_LABELS: Record<StoryLength, string> = {
  test: '测试',
  short: '短篇',
  medium: '中篇',
  long: '长篇'
};

const STORY_LENGTH_REFERENCE = {
  test: {
    defaultShotDurationSeconds: 3,
    defaultSceneDurationSeconds: 8,
    storyboardSplitReferenceSeconds: 4,
    preferredLongShotDurationSeconds: 3
  },
  short: {
    defaultShotDurationSeconds: 4,
    defaultSceneDurationSeconds: 15,
    storyboardSplitReferenceSeconds: 6,
    preferredLongShotDurationSeconds: 5
  },
  medium: {
    defaultShotDurationSeconds: 5,
    defaultSceneDurationSeconds: 45,
    storyboardSplitReferenceSeconds: 8,
    preferredLongShotDurationSeconds: 6
  },
  long: {
    defaultShotDurationSeconds: 6,
    defaultSceneDurationSeconds: 90,
    storyboardSplitReferenceSeconds: 10,
    preferredLongShotDurationSeconds: 7
  }
} satisfies Record<
  StoryLength,
  {
    defaultShotDurationSeconds: number;
    defaultSceneDurationSeconds: number;
    storyboardSplitReferenceSeconds: number;
    preferredLongShotDurationSeconds: number;
  }
>;

function resolveStoryLength(value: Pick<ProjectSettings, 'storyLength'> | StoryLength): StoryLength {
  return typeof value === 'string' ? value : value.storyLength;
}

export function getStoryLengthReference(
  value: Pick<ProjectSettings, 'storyLength'> | StoryLength
): (typeof STORY_LENGTH_REFERENCE)[StoryLength] {
  return STORY_LENGTH_REFERENCE[resolveStoryLength(value)];
}

export function getDefaultShotDurationSeconds(value: Pick<ProjectSettings, 'storyLength'> | StoryLength): number {
  return getStoryLengthReference(value).defaultShotDurationSeconds;
}

export function getStoryboardShotFallbackDurationSeconds(
  value: Pick<ProjectSettings, 'maxVideoSegmentDurationSeconds'>
): number {
  return Math.max(1, Math.min(4, value.maxVideoSegmentDurationSeconds || 4));
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  scriptMode: 'generate',
  storyLength: 'medium',
  language: 'zh-CN',
  tone: '高情绪、高反转、强钩子',
  audience: '短剧平台用户',
  visualStyle: '电影感写实光影，人物统一，镜头具有戏剧张力',
  negativePrompt: 'low quality, blurry, watermark, subtitle, deformed hands, extra fingers',
  aspectRatio: '9:16',
  imageWidth: 720,
  imageHeight: 1280,
  videoWidth: 720,
  videoHeight: 1280,
  fps: 24,
  maxVideoSegmentDurationSeconds: 4,
  maxShotsPerScene: 3,
  useTtsWorkflow: true
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  },
  comfyui: {
    baseUrl: 'http://127.0.0.1:8188',
    workflows: {
      character_asset: {
        workflowPath: ''
      },
      storyboard_image: {
        workflowPath: ''
      },
      text_to_image: {
        workflowPath: ''
      },
      reference_image_to_image: {
        workflowPath: ''
      },
      image_edit: {
        workflowPath: ''
      },
      text_to_video: {
        workflowPath: ''
      },
      image_to_video_first_last: {
        workflowPath: ''
      },
      image_to_video_first_frame: {
        workflowPath: ''
      },
      tts: {
        workflowPath: ''
      }
    },
    pollIntervalMs: 3000,
    timeoutMs: 1_800_000,
    maxVideoSegmentDurationSeconds: DEFAULT_SETTINGS.maxVideoSegmentDurationSeconds
  },
  ffmpeg: {
    binaryPath: ''
  }
};

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeEditableString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function matchesWorkflowTemplatePath(value: string, templatePath: string): boolean {
  if (!value || !templatePath) {
    return false;
  }

  const normalizedValue = value.replace(/\\/g, '/');
  const normalizedTemplatePath = templatePath.replace(/\\/g, '/');
  return normalizedValue === normalizedTemplatePath || normalizedValue.endsWith(`/${normalizedTemplatePath}`);
}

function parseStoryLength(value: unknown): StoryLength | null {
  return STORY_LENGTHS.includes(value as StoryLength) ? (value as StoryLength) : null;
}

function inferStoryLength(
  input: Partial<ProjectSettings> & {
    defaultShotDurationSeconds?: unknown;
    targetSceneCount?: unknown;
  }
): StoryLength {
  const explicit = parseStoryLength(input.storyLength);
  if (explicit) {
    return explicit;
  }

  const legacyTargetSceneCount = Number(input.targetSceneCount);
  if (Number.isFinite(legacyTargetSceneCount) && legacyTargetSceneCount > 0) {
    if (legacyTargetSceneCount >= 8) {
      return 'long';
    }

    if (legacyTargetSceneCount >= 5) {
      return 'medium';
    }

    if (legacyTargetSceneCount >= 3) {
      return 'short';
    }

    return 'test';
  }

  const legacyShotDurationSeconds = Number(input.defaultShotDurationSeconds);
  if (Number.isFinite(legacyShotDurationSeconds) && legacyShotDurationSeconds > 0) {
    if (legacyShotDurationSeconds >= 6) {
      return 'long';
    }

    if (legacyShotDurationSeconds >= 5) {
      return 'medium';
    }

    if (legacyShotDurationSeconds >= 4) {
      return 'short';
    }

    return 'test';
  }

  return DEFAULT_SETTINGS.storyLength;
}

function normalizeComfyWorkflowSettings(
  input: unknown,
  fallback: ComfyWorkflowSettings,
  legacyWorkflowPath = ''
): ComfyWorkflowSettings {
  const normalizedInput = input && typeof input === 'object' ? (input as Partial<ComfyWorkflowSettings>) : {};

  return {
    workflowPath: normalizeEditableString(normalizedInput.workflowPath, legacyWorkflowPath || fallback.workflowPath)
  };
}

export function normalizeSettings(input?: Partial<ProjectSettings>): ProjectSettings {
  const legacyInput = (input ?? {}) as Partial<ProjectSettings> & {
    defaultShotDurationSeconds?: unknown;
    targetSceneCount?: unknown;
  };
  const merged = {
    ...DEFAULT_SETTINGS,
    ...legacyInput
  };
  const storyLength = inferStoryLength(legacyInput);

  return {
    scriptMode: SCRIPT_MODES.includes(merged.scriptMode as ScriptMode)
      ? (merged.scriptMode as ScriptMode)
      : DEFAULT_SETTINGS.scriptMode,
    storyLength,
    language: normalizeString(merged.language, DEFAULT_SETTINGS.language),
    tone: normalizeString(merged.tone, DEFAULT_SETTINGS.tone),
    audience: normalizeString(merged.audience, DEFAULT_SETTINGS.audience),
    visualStyle: normalizeString(merged.visualStyle, DEFAULT_SETTINGS.visualStyle),
    negativePrompt: normalizeString(merged.negativePrompt, DEFAULT_SETTINGS.negativePrompt),
    aspectRatio: ASPECT_RATIOS.includes(merged.aspectRatio as AspectRatio)
      ? (merged.aspectRatio as AspectRatio)
      : DEFAULT_SETTINGS.aspectRatio,
    imageWidth: normalizePositiveInteger(merged.imageWidth, DEFAULT_SETTINGS.imageWidth),
    imageHeight: normalizePositiveInteger(merged.imageHeight, DEFAULT_SETTINGS.imageHeight),
    videoWidth: normalizePositiveInteger(merged.videoWidth, DEFAULT_SETTINGS.videoWidth),
    videoHeight: normalizePositiveInteger(merged.videoHeight, DEFAULT_SETTINGS.videoHeight),
    fps: normalizePositiveInteger(merged.fps, DEFAULT_SETTINGS.fps),
    maxVideoSegmentDurationSeconds: normalizePositiveInteger(
      merged.maxVideoSegmentDurationSeconds,
      DEFAULT_SETTINGS.maxVideoSegmentDurationSeconds
    ),
    maxShotsPerScene: normalizePositiveInteger(merged.maxShotsPerScene, DEFAULT_SETTINGS.maxShotsPerScene),
    useTtsWorkflow: normalizeBoolean(merged.useTtsWorkflow, DEFAULT_SETTINGS.useTtsWorkflow)
  };
}

export function normalizeAppSettings(input: Partial<AppSettings> | undefined, fallback: AppSettings): AppSettings {
  const llm = {
    ...fallback.llm,
    ...(input?.llm ?? {})
  };
  const rawComfyui = ((input?.comfyui ?? {}) as Record<string, unknown>) ?? {};
  const rawWorkflows =
    rawComfyui.workflows && typeof rawComfyui.workflows === 'object'
      ? (rawComfyui.workflows as Record<string, Partial<ComfyWorkflowSettings>>)
      : {};
  const ffmpeg = {
    ...fallback.ffmpeg,
    ...(input?.ffmpeg ?? {})
  };

  const legacyImageWorkflowPath = normalizeEditableString(rawComfyui.imageWorkflowPath, '');
  const legacyVideoWorkflowPath = normalizeEditableString(rawComfyui.videoWorkflowPath, '');
  const legacyCharacterWorkflowPath = normalizeEditableString(rawComfyui.characterWorkflowPath, '');
  const legacyTtsWorkflowPath = normalizeEditableString(rawComfyui.ttsWorkflowPath, '');
  const legacySingleFrameVideoWorkflowTemplatePath = 'config/workflows/ltx_2.3_i2v_modular_api.template.json';
  const legacyFirstLastVideoWorkflowTemplatePath = 'config/workflows/ltx_2.3_i2v_first_last_api.template.json';

  const pickWorkflowPath = (...candidates: Array<string | undefined>): string => {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    return '';
  };

  const legacyImageToVideoWorkflowPath = pickWorkflowPath(
    rawWorkflows.image_to_video?.workflowPath,
    rawWorkflows.video?.workflowPath,
    legacyVideoWorkflowPath
  );
  const inferredLegacyFirstFrameVideoWorkflowPath = matchesWorkflowTemplatePath(
    legacyImageToVideoWorkflowPath,
    legacyFirstLastVideoWorkflowTemplatePath
  )
    ? legacySingleFrameVideoWorkflowTemplatePath
    : legacyImageToVideoWorkflowPath;
  const inferredLegacyFirstLastVideoWorkflowPath = matchesWorkflowTemplatePath(
    legacyImageToVideoWorkflowPath,
    legacySingleFrameVideoWorkflowTemplatePath
  )
    ? legacyFirstLastVideoWorkflowTemplatePath
    : legacyImageToVideoWorkflowPath;

  return {
    llm: {
      baseUrl: normalizeEditableString(llm.baseUrl, fallback.llm.baseUrl),
      apiKey: normalizeEditableString(llm.apiKey, fallback.llm.apiKey),
      model: normalizeEditableString(llm.model, fallback.llm.model)
    },
    comfyui: {
      baseUrl: normalizeEditableString(rawComfyui.baseUrl, fallback.comfyui.baseUrl),
      workflows: {
        character_asset: normalizeComfyWorkflowSettings(
          rawWorkflows.character_asset,
          fallback.comfyui.workflows.character_asset,
          pickWorkflowPath(rawWorkflows.character?.workflowPath, legacyCharacterWorkflowPath, legacyImageWorkflowPath)
        ),
        storyboard_image: normalizeComfyWorkflowSettings(
          rawWorkflows.storyboard_image,
          fallback.comfyui.workflows.storyboard_image,
          pickWorkflowPath(
            rawWorkflows.storyboard?.workflowPath,
            rawWorkflows.image_edit?.workflowPath,
            rawWorkflows.reference_image_to_image?.workflowPath
          )
        ),
        text_to_image: normalizeComfyWorkflowSettings(
          rawWorkflows.text_to_image,
          fallback.comfyui.workflows.text_to_image,
          pickWorkflowPath(
            rawWorkflows.scene?.workflowPath,
            rawWorkflows.object?.workflowPath,
            legacyImageWorkflowPath
          )
        ),
        reference_image_to_image: normalizeComfyWorkflowSettings(
          rawWorkflows.reference_image_to_image,
          fallback.comfyui.workflows.reference_image_to_image,
          pickWorkflowPath(rawWorkflows.storyboard?.workflowPath, legacyImageWorkflowPath)
        ),
        image_edit: normalizeComfyWorkflowSettings(
          rawWorkflows.image_edit,
          fallback.comfyui.workflows.image_edit,
          pickWorkflowPath(rawWorkflows.reference_image_to_image?.workflowPath)
        ),
        text_to_video: normalizeComfyWorkflowSettings(
          rawWorkflows.text_to_video,
          fallback.comfyui.workflows.text_to_video,
          pickWorkflowPath(rawWorkflows.video?.workflowPath, legacyVideoWorkflowPath)
        ),
        image_to_video_first_last: normalizeComfyWorkflowSettings(
          rawWorkflows.image_to_video_first_last,
          fallback.comfyui.workflows.image_to_video_first_last,
          pickWorkflowPath(inferredLegacyFirstLastVideoWorkflowPath)
        ),
        image_to_video_first_frame: normalizeComfyWorkflowSettings(
          rawWorkflows.image_to_video_first_frame,
          fallback.comfyui.workflows.image_to_video_first_frame,
          pickWorkflowPath(inferredLegacyFirstFrameVideoWorkflowPath)
        ),
        tts: normalizeComfyWorkflowSettings(
          rawWorkflows.tts,
          fallback.comfyui.workflows.tts,
          legacyTtsWorkflowPath
        )
      },
      pollIntervalMs: normalizePositiveInteger(rawComfyui.pollIntervalMs, fallback.comfyui.pollIntervalMs),
      timeoutMs: normalizePositiveInteger(rawComfyui.timeoutMs, fallback.comfyui.timeoutMs),
      maxVideoSegmentDurationSeconds: normalizePositiveInteger(
        rawComfyui.maxVideoSegmentDurationSeconds,
        fallback.comfyui.maxVideoSegmentDurationSeconds
      )
    },
    ffmpeg: {
      binaryPath: normalizeEditableString(ffmpeg.binaryPath, fallback.ffmpeg.binaryPath)
    }
  };
}

export function normalizeStoryboardShot(
  input: Partial<StoryboardShot> | undefined,
  index: number,
  settings: ProjectSettings
): StoryboardShot {
  const sceneNumber = normalizePositiveInteger(input?.sceneNumber, index + 1);
  const shotNumber = normalizePositiveInteger(input?.shotNumber, 1);
  const id =
    normalizeString(input?.id, `scene-${sceneNumber}-shot-${shotNumber}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `scene-${sceneNumber}-shot-${shotNumber}`;
  const dialogue = normalizeString(input?.dialogue, '');
  const voiceover = normalizeString(input?.voiceover, '');
  const useLastFrameReference = normalizeBoolean(
    input?.useLastFrameReference,
    Boolean(typeof input?.lastFramePrompt === 'string' && input.lastFramePrompt.trim())
  );
  const dialogueIdentifier = normalizeStoryboardDialogueIdentifier(input?.dialogueIdentifier);
  const longTakeIdentifier = normalizeLongTakeIdentifier(input?.longTakeIdentifier);

  return {
    id,
    sceneNumber,
    shotNumber,
    title: normalizeString(input?.title, `场景${sceneNumber}镜头${shotNumber}`),
    purpose: normalizeString(input?.purpose, '推进剧情'),
    durationSeconds: normalizePositiveInteger(input?.durationSeconds, getStoryboardShotFallbackDurationSeconds(settings)),
    startTimeSeconds: 0,
    endTimeSeconds: 0,
    startTimecode: '00:00',
    endTimecode: '00:00',
    dialogueIdentifier,
    longTakeIdentifier: longTakeIdentifier || null,
    dialogue,
    voiceover,
    camera: normalizeString(input?.camera, '中近景，稳定推进'),
    composition: normalizeString(input?.composition, '主体明确，突出人物情绪'),
    transitionHint: normalizeString(input?.transitionHint, 'cut'),
    useLastFrameReference,
    firstFramePrompt: normalizeString(
      input?.firstFramePrompt,
      `${settings.visualStyle}，场景${sceneNumber}镜头${shotNumber}起始参考帧`
    ),
    lastFramePrompt: useLastFrameReference
      ? normalizeString(input?.lastFramePrompt, `${settings.visualStyle}，场景${sceneNumber}镜头${shotNumber}结束参考帧`)
      : '',
    videoPrompt: normalizeString(
      input?.videoPrompt,
      `${settings.visualStyle}，场景${sceneNumber}镜头${shotNumber}视频动作描述`
    ),
    backgroundSoundPrompt: normalizeString(
      input?.backgroundSoundPrompt,
      dialogue || voiceover
        ? `场景${sceneNumber}镜头${shotNumber}的背景声音设计，突出环境氛围、动作音效和空间层次，不包含额外人物对白，也不要盖过主要语音内容。`
        : `场景${sceneNumber}镜头${shotNumber}没有对白和旁白，需要自然、真实、连贯的环境音、动作音和空间氛围声，不要出现人声。`
    ),
    speechPrompt: normalizeString(
      input?.speechPrompt,
      dialogue || voiceover
        ? `场景${sceneNumber}镜头${shotNumber}的中文台词/旁白配音设计。台词：${dialogue || '无'}；旁白：${voiceover || '无'}。要求情绪准确、节奏自然、贴合人物状态，并通过人物身份、年龄感和外观气质明确当前说话者，不要只写角色名。`
        : `场景${sceneNumber}镜头${shotNumber}无台词和旁白，不生成语音内容。`
    ),
    referenceAssetIds: normalizeReferenceSelectionIds(input?.referenceAssetIds),
    manualReferenceAssetIds: normalizeReferenceSelectionIds(input?.manualReferenceAssetIds),
    excludedReferenceAssetIds: normalizeReferenceSelectionIds(input?.excludedReferenceAssetIds)
  };
}

function formatStoryboardTimecode(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function finalizeStoryboardDialogueIdentifiers(shots: StoryboardShot[]): StoryboardShot[] {
  const groupedShotIndexes = new Map<string, number[]>();

  shots.forEach((shot, index) => {
    if (!shot.dialogueIdentifier?.groupId) {
      return;
    }

    const groupKey = `${shot.sceneNumber}:${shot.dialogueIdentifier.groupId}`;
    const indexes = groupedShotIndexes.get(groupKey) ?? [];
    indexes.push(index);
    groupedShotIndexes.set(groupKey, indexes);
  });

  if (!groupedShotIndexes.size) {
    return shots;
  }

  return shots.map((shot, index) => {
    if (!shot.dialogueIdentifier?.groupId) {
      return shot;
    }

    const groupKey = `${shot.sceneNumber}:${shot.dialogueIdentifier.groupId}`;
    const groupedIndexes = groupedShotIndexes.get(groupKey);

    if (!groupedIndexes?.length) {
      return shot;
    }

    const sequenceIndex = groupedIndexes.indexOf(index) + 1;
    const sequenceLength = groupedIndexes.length;

    return {
      ...shot,
      dialogueIdentifier: {
        groupId: shot.dialogueIdentifier.groupId,
        sequenceIndex,
        sequenceLength,
        flowRole: deriveStoryboardDialogueFlowRole(sequenceIndex, sequenceLength)
      }
    };
  });
}

export function normalizeStoryboardShots(
  inputs: Array<Partial<StoryboardShot> | undefined>,
  settings: ProjectSettings
): StoryboardShot[] {
  let elapsedSeconds = 0;

  const normalizedShots = inputs.map((input, index) => {
    const shot = normalizeStoryboardShot(input, index, settings);
    const startTimeSeconds = elapsedSeconds;
    const endTimeSeconds = startTimeSeconds + shot.durationSeconds;
    elapsedSeconds = endTimeSeconds;

    return {
      ...shot,
      startTimeSeconds,
      endTimeSeconds,
      startTimecode: formatStoryboardTimecode(startTimeSeconds),
      endTimecode: formatStoryboardTimecode(endTimeSeconds)
    };
  });

  return finalizeStoryboardDialogueIdentifiers(normalizedShots);
}

export function createEmptyStageState(): StageState {
  return {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    error: null
  };
}

export function createStageStateMap(): Record<StageId, StageState> {
  return {
    script: createEmptyStageState(),
    storyboard: createEmptyStageState(),
    assets: createEmptyStageState(),
    shots: createEmptyStageState(),
    edit: createEmptyStageState()
  };
}

export function createEmptyReferenceLibrary(): ProjectReferenceLibrary {
  return {
    characters: [],
    scenes: [],
    objects: []
  };
}

export function createIdleRunState(): ProjectRunState {
  return {
    isRunning: false,
    requestedStage: null,
    currentStage: null,
    startedAt: null,
    pauseRequested: false,
    stopRequested: false,
    isPaused: false
  };
}
