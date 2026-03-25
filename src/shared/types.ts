export const STAGES = ['script', 'storyboard', 'images', 'videos', 'edit'] as const;

export type StageId = (typeof STAGES)[number];
export type RunStage = StageId | 'all';
export type StageStatus = 'idle' | 'running' | 'success' | 'error';
export type LogLevel = 'info' | 'warn' | 'error';

export interface AppSettings {
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  comfyui: {
    baseUrl: string;
    imageWorkflowPath: string;
    videoWorkflowPath: string;
    imageCheckpointName: string;
    videoCheckpointName: string;
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
  imageWorkflowExists: boolean;
  videoWorkflowExists: boolean;
  ffmpegReady: boolean;
}

export interface StageState {
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface ProjectSettings {
  language: string;
  tone: string;
  audience: string;
  visualStyle: string;
  negativePrompt: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
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
}

export interface GeneratedAsset {
  shotId: string | null;
  sceneNumber: number | null;
  relativePath: string;
  prompt: string;
  createdAt: string;
}

export interface ProjectArtifacts {
  scriptMarkdown: string | null;
  scriptJson: string | null;
  storyboardJson: string | null;
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
  artifacts: ProjectArtifacts;
  logs: ProjectLog[];
  runState: ProjectRunState;
}

export interface AppMeta {
  defaults: ProjectSettings;
  stages: Array<{ id: StageId; label: string }>;
  envStatus: RuntimeStatus;
  workflowPaths: {
    image: string;
    video: string;
  };
}

export const STAGE_LABELS: Record<StageId, string> = {
  script: '剧本生成',
  storyboard: '分镜生成',
  images: '图片生成',
  videos: '视频生成',
  edit: '视频剪辑'
};

export const DEFAULT_SETTINGS: ProjectSettings = {
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
    imageWorkflowPath: '',
    videoWorkflowPath: '',
    imageCheckpointName: '',
    videoCheckpointName: '',
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

export function normalizeSettings(input?: Partial<ProjectSettings>): ProjectSettings {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(input ?? {})
  };

  return {
    language: normalizeString(merged.language, DEFAULT_SETTINGS.language),
    tone: normalizeString(merged.tone, DEFAULT_SETTINGS.tone),
    audience: normalizeString(merged.audience, DEFAULT_SETTINGS.audience),
    visualStyle: normalizeString(merged.visualStyle, DEFAULT_SETTINGS.visualStyle),
    negativePrompt: normalizeString(merged.negativePrompt, DEFAULT_SETTINGS.negativePrompt),
    aspectRatio:
      merged.aspectRatio === '16:9' || merged.aspectRatio === '1:1' || merged.aspectRatio === '9:16'
        ? merged.aspectRatio
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
  const comfyui = {
    ...fallback.comfyui,
    ...(input?.comfyui ?? {})
  };
  const ffmpeg = {
    ...fallback.ffmpeg,
    ...(input?.ffmpeg ?? {})
  };

  return {
    llm: {
      baseUrl: normalizeEditableString(llm.baseUrl, fallback.llm.baseUrl),
      apiKey: normalizeEditableString(llm.apiKey, fallback.llm.apiKey),
      model: normalizeEditableString(llm.model, fallback.llm.model)
    },
    comfyui: {
      baseUrl: normalizeEditableString(comfyui.baseUrl, fallback.comfyui.baseUrl),
      imageWorkflowPath: normalizeEditableString(
        comfyui.imageWorkflowPath,
        fallback.comfyui.imageWorkflowPath
      ),
      videoWorkflowPath: normalizeEditableString(
        comfyui.videoWorkflowPath,
        fallback.comfyui.videoWorkflowPath
      ),
      imageCheckpointName: normalizeEditableString(
        comfyui.imageCheckpointName,
        fallback.comfyui.imageCheckpointName
      ),
      videoCheckpointName: normalizeEditableString(
        comfyui.videoCheckpointName,
        fallback.comfyui.videoCheckpointName
      ),
      pollIntervalMs: normalizePositiveInteger(comfyui.pollIntervalMs, fallback.comfyui.pollIntervalMs),
      timeoutMs: normalizePositiveInteger(comfyui.timeoutMs, fallback.comfyui.timeoutMs)
    },
    ffmpeg: {
      binaryPath: normalizeEditableString(ffmpeg.binaryPath, fallback.ffmpeg.binaryPath)
    }
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
    storyboard: createEmptyStageState(),
    images: createEmptyStageState(),
    videos: createEmptyStageState(),
    edit: createEmptyStageState()
  };
}
