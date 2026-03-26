export const STAGES = ['script', 'assets', 'storyboard', 'images', 'videos', 'edit'] as const;
export const COMFYUI_WORKFLOW_TYPES = ['character', 'scene', 'object', 'storyboard', 'video', 'tts'] as const;
export const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'] as const;
export const SCRIPT_MODES = ['generate', 'optimize'] as const;

export type StageId = (typeof STAGES)[number];
export type ComfyWorkflowType = (typeof COMFYUI_WORKFLOW_TYPES)[number];
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type ScriptMode = (typeof SCRIPT_MODES)[number];
export type RunStage = StageId | 'all';
export type StageStatus = 'idle' | 'running' | 'success' | 'error';
export type LogLevel = 'info' | 'warn' | 'error';
export type ReferenceAssetKind = 'character' | 'scene' | 'object';

export interface ComfyWorkflowSettings {
  workflowPath: string;
  checkpointName: string;
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
  };
  ffmpeg: {
    binaryPath: string;
  };
}

export interface RuntimeStatus {
  llmConfigured: boolean;
  comfyuiConfigured: boolean;
  characterWorkflowExists: boolean;
  sceneWorkflowExists: boolean;
  objectWorkflowExists: boolean;
  storyboardWorkflowExists: boolean;
  videoWorkflowExists: boolean;
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
  defaultShotDurationSeconds: number;
  targetSceneCount: number;
  maxShotsPerScene: number;
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

export interface ScriptScene {
  sceneNumber: number;
  location: string;
  timeOfDay: string;
  summary: string;
  emotionalBeat: string;
  voiceover: string;
  durationSeconds: number;
  dialogue: ScriptDialogueLine[];
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

export interface StoryboardShot {
  id: string;
  sceneNumber: number;
  shotNumber: number;
  title: string;
  purpose: string;
  durationSeconds: number;
  dialogue: string;
  voiceover: string;
  camera: string;
  composition: string;
  transitionHint: string;
  firstFramePrompt: string;
  videoPrompt: string;
  backgroundSoundPrompt: string;
  speechPrompt: string;
}

export interface GeneratedAsset {
  shotId: string | null;
  sceneNumber: number | null;
  relativePath: string;
  prompt: string;
  createdAt: string;
}

export interface ReferenceAssetItem {
  id: string;
  kind: ReferenceAssetKind;
  name: string;
  summary: string;
  generationPrompt: string;
  status: StageStatus;
  error: string | null;
  updatedAt: string;
  asset: GeneratedAsset | null;
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
    videos: GeneratedAsset[];
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

export const STAGE_LABELS: Record<StageId, string> = {
  script: '剧本生成',
  assets: '资产生成',
  storyboard: '分镜生成',
  images: '图片生成',
  videos: '视频生成',
  edit: '视频剪辑'
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  scriptMode: 'generate',
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
  defaultShotDurationSeconds: 4,
  targetSceneCount: 6,
  maxShotsPerScene: 3
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
      character: {
        workflowPath: '',
        checkpointName: ''
      },
      scene: {
        workflowPath: '',
        checkpointName: ''
      },
      object: {
        workflowPath: '',
        checkpointName: ''
      },
      storyboard: {
        workflowPath: '',
        checkpointName: ''
      },
      video: {
        workflowPath: '',
        checkpointName: ''
      },
      tts: {
        workflowPath: '',
        checkpointName: ''
      }
    },
    pollIntervalMs: 3000,
    timeoutMs: 1_800_000
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

function normalizeComfyWorkflowSettings(
  input: unknown,
  fallback: ComfyWorkflowSettings,
  legacy?: Partial<ComfyWorkflowSettings>
): ComfyWorkflowSettings {
  const normalizedInput = input && typeof input === 'object' ? (input as Partial<ComfyWorkflowSettings>) : {};

  return {
    workflowPath: normalizeEditableString(
      normalizedInput.workflowPath,
      legacy?.workflowPath ?? fallback.workflowPath
    ),
    checkpointName: normalizeEditableString(
      normalizedInput.checkpointName,
      legacy?.checkpointName ?? fallback.checkpointName
    )
  };
}

export function normalizeSettings(input?: Partial<ProjectSettings>): ProjectSettings {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(input ?? {})
  };

  return {
    scriptMode: SCRIPT_MODES.includes(merged.scriptMode as ScriptMode)
      ? (merged.scriptMode as ScriptMode)
      : DEFAULT_SETTINGS.scriptMode,
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
    defaultShotDurationSeconds: normalizePositiveInteger(
      merged.defaultShotDurationSeconds,
      DEFAULT_SETTINGS.defaultShotDurationSeconds
    ),
    targetSceneCount: normalizePositiveInteger(merged.targetSceneCount, DEFAULT_SETTINGS.targetSceneCount),
    maxShotsPerScene: normalizePositiveInteger(merged.maxShotsPerScene, DEFAULT_SETTINGS.maxShotsPerScene)
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
      ? (rawComfyui.workflows as Partial<Record<ComfyWorkflowType, Partial<ComfyWorkflowSettings>>>)
      : {};
  const ffmpeg = {
    ...fallback.ffmpeg,
    ...(input?.ffmpeg ?? {})
  };

  const legacyImageWorkflowPath = normalizeEditableString(rawComfyui.imageWorkflowPath, '');
  const legacyImageCheckpointName = normalizeEditableString(rawComfyui.imageCheckpointName, '');
  const legacyVideoWorkflowPath = normalizeEditableString(rawComfyui.videoWorkflowPath, '');
  const legacyVideoCheckpointName = normalizeEditableString(rawComfyui.videoCheckpointName, '');

  return {
    llm: {
      baseUrl: normalizeEditableString(llm.baseUrl, fallback.llm.baseUrl),
      apiKey: normalizeEditableString(llm.apiKey, fallback.llm.apiKey),
      model: normalizeEditableString(llm.model, fallback.llm.model)
    },
    comfyui: {
      baseUrl: normalizeEditableString(rawComfyui.baseUrl, fallback.comfyui.baseUrl),
      workflows: {
        character: normalizeComfyWorkflowSettings(rawWorkflows.character, fallback.comfyui.workflows.character, {
          workflowPath: legacyImageWorkflowPath,
          checkpointName: legacyImageCheckpointName
        }),
        scene: normalizeComfyWorkflowSettings(rawWorkflows.scene, fallback.comfyui.workflows.scene, {
          workflowPath: legacyImageWorkflowPath,
          checkpointName: legacyImageCheckpointName
        }),
        object: normalizeComfyWorkflowSettings(rawWorkflows.object, fallback.comfyui.workflows.object, {
          workflowPath: legacyImageWorkflowPath,
          checkpointName: legacyImageCheckpointName
        }),
        storyboard: normalizeComfyWorkflowSettings(rawWorkflows.storyboard, fallback.comfyui.workflows.storyboard, {
          workflowPath: legacyImageWorkflowPath,
          checkpointName: legacyImageCheckpointName
        }),
        video: normalizeComfyWorkflowSettings(rawWorkflows.video, fallback.comfyui.workflows.video, {
          workflowPath: legacyVideoWorkflowPath,
          checkpointName: legacyVideoCheckpointName
        }),
        tts: normalizeComfyWorkflowSettings(rawWorkflows.tts, fallback.comfyui.workflows.tts)
      },
      pollIntervalMs: normalizePositiveInteger(rawComfyui.pollIntervalMs, fallback.comfyui.pollIntervalMs),
      timeoutMs: normalizePositiveInteger(rawComfyui.timeoutMs, fallback.comfyui.timeoutMs)
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

  return {
    id,
    sceneNumber,
    shotNumber,
    title: normalizeString(input?.title, `场景${sceneNumber}镜头${shotNumber}`),
    purpose: normalizeString(input?.purpose, '推进剧情'),
    durationSeconds: normalizePositiveInteger(input?.durationSeconds, settings.defaultShotDurationSeconds),
    dialogue,
    voiceover,
    camera: normalizeString(input?.camera, '中近景，稳定推进'),
    composition: normalizeString(input?.composition, '主体明确，突出人物情绪'),
    transitionHint: normalizeString(input?.transitionHint, 'cut'),
    firstFramePrompt: normalizeString(
      input?.firstFramePrompt,
      `${settings.visualStyle}，场景${sceneNumber}镜头${shotNumber}首帧`
    ),
    videoPrompt: normalizeString(
      input?.videoPrompt,
      `${settings.visualStyle}，场景${sceneNumber}镜头${shotNumber}视频动作描述`
    ),
    backgroundSoundPrompt: normalizeString(
      input?.backgroundSoundPrompt,
      `场景${sceneNumber}镜头${shotNumber}的背景声音设计，突出环境氛围、动作音效和空间层次，不包含人物对白。`
    ),
    speechPrompt: normalizeString(
      input?.speechPrompt,
      dialogue || voiceover
        ? `场景${sceneNumber}镜头${shotNumber}的中文台词/旁白配音设计。台词：${dialogue || '无'}；旁白：${voiceover || '无'}。要求情绪准确、节奏自然、贴合人物状态。`
        : `场景${sceneNumber}镜头${shotNumber}无台词和旁白，不生成语音内容。`
    )
  };
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
    assets: createEmptyStageState(),
    storyboard: createEmptyStageState(),
    images: createEmptyStageState(),
    videos: createEmptyStageState(),
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
