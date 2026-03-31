import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import {
  type AppSettings,
  type GeneratedAsset,
  type LogLevel,
  type Project,
  type ProjectRunState,
  type ReferenceAssetItem,
  type ReferenceAssetKind,
  type RunStage,
  type StageId,
  createIdleRunState,
  createEmptyReferenceLibrary,
  filterReferenceLibraryForShot,
  getDefaultShotDurationSeconds,
  getGenerationReferenceLibraryForShot,
  normalizeStoryboardShots,
  STAGES,
  STAGE_LABELS
} from '../shared/types.js';
import { fromStorageRelative, toStorageRelative } from './config.js';
import { getAppSettings, getRuntimeStatus } from './app-settings.js';
import {
  readProject,
  resolveProjectPath,
  writeProject,
  writeProjectFile
} from './storage.js';
import {
  extractReferenceLibraryFromScript,
  generateScriptFromText,
  generateStoryboardFromScript,
  type StoryboardPlanShot
} from './openai-client.js';
import {
  type ComfyOutputFile,
  type TemplateVariable,
  fetchComfyOutputFile,
  prepareComfyWorkflow,
  runComfyWorkflow,
  uploadAudioToComfy,
  uploadImageBufferToComfy,
  uploadImageToComfy
} from './comfyui.js';
import { extractLastFrame, getMediaDurationSeconds, stitchAudios, stitchVideos } from './video-editor.js';

const runningProjects = new Map<string, Promise<void>>();
const runningReferenceGenerations = new Map<string, Promise<void>>();
const cachedRunStates = new Map<string, ProjectRunState>();
const pauseRequestedProjects = new Set<string>();
const stopRequestedProjects = new Set<string>();
const projectAbortControllers = new Map<string, AbortController>();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const COMFY_DEBUG_DIR = path.join('.debug', 'comfy');

interface GenerationReferenceInputs {
  referenceContext: string;
  referenceVariables: Record<string, TemplateVariable>;
  referenceCount: number;
  referenceImageCount: number;
  referenceImages: string[];
}

interface TtsPlan {
  segments: TtsSegmentPlan[];
  plainText: string;
}

interface TtsSegmentPlan {
  speakerKey: string;
  text: string;
  prompt: string;
  referenceAudioAbsolutePath: string | null;
  outputKey: string;
  defaultSpeaker: string;
}

interface TtsReferenceAudioPlan {
  useReferenceAudio: boolean;
  narratorReferenceAudio: string;
  speaker1ReferenceAudio: string;
  speaker2ReferenceAudio: string;
}

interface PreparedShotTtsAudio {
  asset: GeneratedAsset | null;
  absolutePath: string | null;
  durationSeconds: number | null;
  useReferenceAudio: boolean;
  reusedExisting: boolean;
}

type ComfyOutputKind = 'image' | 'video' | 'audio';

const DEFAULT_CHARACTER_POSE_REFERENCE_PATH = path.resolve(
  process.cwd(),
  'config/reference-images/character-pose-three-view.png'
);
const DEFAULT_NO_REFERENCE_TTS_WORKFLOW_PATH = path.resolve(
  process.cwd(),
  'config/workflows/qwen3_tts_no_reference.template.json'
);
const DEFAULT_REFERENCE_AUDIO_TTS_WORKFLOW_PATH = path.resolve(
  process.cwd(),
  'config/workflows/qwen3_tts_dialogue.template.json'
);
const DEFAULT_SINGLE_FRAME_VIDEO_WORKFLOW_PATH = path.resolve(
  process.cwd(),
  'config/workflows/ltx_2.3_i2v_modular_api.template.json'
);
const DEFAULT_FIRST_LAST_FRAME_VIDEO_WORKFLOW_PATH = path.resolve(
  process.cwd(),
  'config/workflows/ltx_2.3_i2v_first_last_api.template.json'
);
const ZIMAGE_TEXT_TO_IMAGE_WORKFLOW_BASENAME = 'zimage_text_to_image.template.json';
const MAX_STORYBOARD_REFERENCE_IMAGES_PER_RUN = 3;
const MAX_STORYBOARD_REFERENCE_IMAGES_PER_CHAIN_RUN = 2;
const AUDIO_DRIVEN_VIDEO_PADDING_SECONDS = 0.25;
const NO_REFERENCE_TTS_VOICE_PRESETS = [
  {
    id: 'clear_young',
    instruction: '音色清亮干净，偏年轻，吐字利落，情绪反应灵敏。'
  },
  {
    id: 'steady_low',
    instruction: '音色偏低沉，气息稳定，节奏从容，整体更稳重。'
  },
  {
    id: 'soft_warm',
    instruction: '音色柔和温润，语气细腻，尾音自然收住，不过分用力。'
  },
  {
    id: 'cool_crisp',
    instruction: '音色冷静清脆，表达克制，停连分明，整体偏利落。'
  },
  {
    id: 'bright_lively',
    instruction: '音色明亮活泼，节奏稍快但清晰，带一点轻快感。'
  },
  {
    id: 'mature_textured',
    instruction: '音色更成熟，带轻微颗粒感，表达沉着，不要油腻夸张。'
  }
] as const;

function inferCharacterGenderHint(
  item: Pick<ReferenceAssetItem, 'genderHint' | 'summary' | 'generationPrompt'>
): string {
  const explicit = item.genderHint.trim();

  if (explicit) {
    return explicit;
  }

  const text = `${item.summary} ${item.generationPrompt}`;

  if (/女性|女人|女生|女孩|少女|女童|母亲|妈妈|妻子|太太|姐姐|妹妹|女儿|女士/.test(text)) {
    return '女性';
  }

  if (/男性|男人|男生|男孩|少年|男童|父亲|爸爸|丈夫|先生|哥哥|弟弟|儿子/.test(text)) {
    return '男性';
  }

  return '';
}

function inferCharacterAgeHint(
  item: Pick<ReferenceAssetItem, 'name' | 'ageHint' | 'summary' | 'generationPrompt'>
): string {
  const explicit = item.ageHint.trim();

  if (explicit) {
    return explicit;
  }

  const text = `${item.name} ${item.summary} ${item.generationPrompt}`;
  const explicitAgeMatch = text.match(/([0-9]{1,2}\s*岁(?:左右)?(?:[^\s，。,；;]*)?)/);

  if (explicitAgeMatch?.[1]) {
    return explicitAgeMatch[1].replace(/\s+/g, '');
  }

  if (/婴儿|宝宝/.test(text)) {
    return '婴儿';
  }

  if (/儿童|小孩|童年|孩童|男孩|女孩|小学生/.test(text)) {
    return '儿童';
  }

  if (/少年|少女|中学生/.test(text)) {
    return '少年';
  }

  if (/青年|年轻|大学生|二十多/.test(text)) {
    return '青年';
  }

  if (/成年|三十多|30岁|三十岁/.test(text)) {
    return '成年';
  }

  if (/中年|四十|五十/.test(text)) {
    return '中年';
  }

  if (/老年|老人|银发|六十|七十|八十/.test(text)) {
    return '老年';
  }

  return '';
}

function buildCharacterReferenceDetail(
  item: Pick<ReferenceAssetItem, 'name' | 'generationPrompt' | 'summary' | 'ethnicityHint' | 'genderHint' | 'ageHint'>
): string {
  const baseDetail = item.generationPrompt.trim() || item.summary.trim();
  const genderHint = inferCharacterGenderHint(item);
  const ageHint = inferCharacterAgeHint(item);
  const parts = [
    genderHint ? `性别：${genderHint}` : '',
    ageHint ? `年龄：${ageHint}` : '',
    item.ethnicityHint.trim() ? `人种/族裔提示：${item.ethnicityHint.trim()}` : '',
    baseDetail
  ].filter(Boolean);

  return parts.join('；');
}

function buildCharacterAssetWorkflowPrompt(
  characterName: string,
  prompt: string,
  ethnicityHint: string,
  genderHint: string,
  ageHint: string
): string {
  const trimmedPrompt = prompt.trim();
  const trimmedName = characterName.trim() || '角色';
  const resolvedGender =
    inferCharacterGenderHint({ genderHint, summary: '', generationPrompt: trimmedPrompt }) || '性别未说明';
  const resolvedAge =
    inferCharacterAgeHint({ name: trimmedName, ageHint, summary: '', generationPrompt: trimmedPrompt }) || '年龄未说明';
  const resolvedEthnicity = ethnicityHint.trim() || '人种未说明';
  const resolvedDescription = trimmedPrompt || '人物描述未说明';

  return `${trimmedName}的全身照，${resolvedGender}，${resolvedAge}，${resolvedEthnicity}，${resolvedDescription}`;
}

function now(): string {
  return new Date().toISOString();
}

function createLog(level: LogLevel, message: string) {
  return {
    id: crypto.randomUUID(),
    level,
    message,
    createdAt: now()
  };
}

function setStageStatus(
  project: Project,
  stage: StageId,
  status: 'idle' | 'running' | 'success' | 'error',
  error: string | null = null
): void {
  const current = project.stages[stage];
  project.stages[stage] = {
    status,
    startedAt: status === 'running' ? now() : current.startedAt,
    finishedAt: status === 'running' ? null : now(),
    error
  };
}

function resetStage(project: Project, stage: StageId): void {
  project.stages[stage] = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    error: null
  };
}

function appendLog(project: Project, message: string, level: LogLevel = 'info'): void {
  project.logs = [...project.logs, createLog(level, message)].slice(-300);
  project.updatedAt = now();
}

class PipelinePauseError extends Error {
  constructor(readonly stage: StageId) {
    super(`PAUSE_REQUESTED:${stage}`);
    this.name = 'PipelinePauseError';
  }
}

class PipelineStopError extends Error {
  constructor(readonly stage: StageId) {
    super(`STOP_REQUESTED:${stage}`);
    this.name = 'PipelineStopError';
  }
}

function syncProjectRunState(project: Project): void {
  const cached = cachedRunStates.get(project.id);

  if (cached) {
    project.runState = { ...cached };
  }
}

async function saveProject(project: Project): Promise<void> {
  syncProjectRunState(project);
  project.updatedAt = now();
  await writeProject(project);
}

async function persistProjectRunState(projectId: string, runState: ProjectRunState): Promise<void> {
  const project = await readProject(projectId);
  const nextRunState = { ...runState };
  cachedRunStates.set(projectId, nextRunState);
  project.runState = nextRunState;
  project.updatedAt = now();
  await writeProject(project);
}

function isPauseRequested(projectId: string): boolean {
  return pauseRequestedProjects.has(projectId);
}

function isStopRequested(projectId: string): boolean {
  return stopRequestedProjects.has(projectId);
}

function ensureProjectAbortController(projectId: string): AbortController {
  const controller = new AbortController();
  projectAbortControllers.set(projectId, controller);
  return controller;
}

function getProjectAbortSignal(projectId: string): AbortSignal | undefined {
  return projectAbortControllers.get(projectId)?.signal;
}

function clearProjectAbortController(projectId: string): void {
  projectAbortControllers.delete(projectId);
}

async function throwIfRunInterrupted(projectId: string, stage: StageId): Promise<void> {
  if (isStopRequested(projectId)) {
    throw new PipelineStopError(stage);
  }

  if (isPauseRequested(projectId)) {
    throw new PipelinePauseError(stage);
  }
}

async function persistReferenceLibrary(project: Project): Promise<void> {
  const libraryFile = await writeProjectFile(
    project.id,
    'references/reference-library.json',
    JSON.stringify(project.referenceLibrary, null, 2)
  );
  project.artifacts.referenceLibraryJson = libraryFile.relativePath;
}

async function persistStoryboard(project: Project, planShots: StoryboardPlanShot[] | null = null): Promise<void> {
  const storyboardFile = await writeProjectFile(
    project.id,
    'storyboard/storyboard.json',
    JSON.stringify(
      {
        plan: planShots
          ? {
              totalShots: planShots.length,
              shots: planShots.map((shot) => ({
                id: shot.id,
                sceneNumber: shot.sceneNumber,
                shotNumber: shot.shotNumber,
                title: shot.title,
                purpose: shot.purpose,
                durationSeconds: shot.durationSeconds,
                dialogueIdentifier: shot.dialogueIdentifier?.groupId
                  ? {
                      groupId: shot.dialogueIdentifier.groupId
                    }
                  : null,
                longTakeIdentifier: shot.longTakeIdentifier,
                overview: shot.overview
              }))
            }
          : null,
        shots: project.storyboard
      },
      null,
      2
    )
  );
  project.artifacts.storyboardJson = storyboardFile.relativePath;
}

function hasGeneratedMediaOutputs(project: Project): boolean {
  return Boolean(
    project.assets.images.length ||
      project.assets.lastImages.length ||
      project.assets.videos.length ||
      project.assets.finalVideo
  );
}

async function deleteStoredAsset(asset: GeneratedAsset | null): Promise<void> {
  if (!asset?.relativePath) {
    return;
  }

  try {
    await rm(fromStorageRelative(asset.relativePath), { force: true });
  } catch {
    // Ignore cleanup errors for temporary inputs.
  }
}

type ShotAssetStage = 'images' | 'lastImages' | 'audios' | 'videos';

function getShotAssetHistoryMap(project: Project, stage: ShotAssetStage) {
  if (stage === 'images') {
    return project.assets.imageHistory;
  }

  if (stage === 'lastImages') {
    return project.assets.lastImageHistory;
  }

  if (stage === 'audios') {
    return project.assets.audioHistory;
  }

  return project.assets.videoHistory;
}

function setShotAssetHistoryMap(
  project: Project,
  stage: ShotAssetStage,
  history: Project['assets']['imageHistory'] | Project['assets']['audioHistory'] | Project['assets']['videoHistory']
): void {
  if (stage === 'images') {
    project.assets.imageHistory = history;
    return;
  }

  if (stage === 'lastImages') {
    project.assets.lastImageHistory = history;
    return;
  }

  if (stage === 'audios') {
    project.assets.audioHistory = history;
    return;
  }

  project.assets.videoHistory = history;
}

function getShotAssetCollection(project: Project, stage: ShotAssetStage): GeneratedAsset[] {
  if (stage === 'images') {
    return project.assets.images;
  }

  if (stage === 'lastImages') {
    return project.assets.lastImages;
  }

  if (stage === 'audios') {
    return project.assets.audios;
  }

  return project.assets.videos;
}

function setShotAssetCollection(project: Project, stage: ShotAssetStage, assets: GeneratedAsset[]): void {
  if (stage === 'images') {
    project.assets.images = assets;
    return;
  }

  if (stage === 'lastImages') {
    project.assets.lastImages = assets;
    return;
  }

  if (stage === 'audios') {
    project.assets.audios = assets;
    return;
  }

  project.assets.videos = assets;
}

function getShotAssetHistory(project: Project, stage: ShotAssetStage, shotId: string): GeneratedAsset[] {
  return getShotAssetHistoryMap(project, stage)[shotId] ?? [];
}

function setShotAssetHistory(
  project: Project,
  stage: ShotAssetStage,
  shotId: string,
  history: GeneratedAsset[]
): void {
  const historyMap = {
    ...getShotAssetHistoryMap(project, stage)
  };

  if (history.length) {
    historyMap[shotId] = history;
  } else {
    delete historyMap[shotId];
  }

  setShotAssetHistoryMap(project, stage, historyMap);
}

function getActiveShotAsset(project: Project, stage: ShotAssetStage, shotId: string): GeneratedAsset | null {
  return getShotAssetCollection(project, stage).find((asset) => asset.shotId === shotId) ?? null;
}

function archiveShotAssetVersion(
  project: Project,
  stage: ShotAssetStage,
  shotId: string,
  asset: GeneratedAsset | null
): void {
  if (!asset) {
    return;
  }

  const history = getShotAssetHistory(project, stage, shotId);
  if (history.some((item) => item.relativePath === asset.relativePath)) {
    return;
  }

  setShotAssetHistory(project, stage, shotId, [asset, ...history]);
}

function removeShotAssetVersionFromHistory(
  project: Project,
  stage: ShotAssetStage,
  shotId: string,
  relativePath: string
): void {
  const history = getShotAssetHistory(project, stage, shotId).filter((asset) => asset.relativePath !== relativePath);
  setShotAssetHistory(project, stage, shotId, history);
}

function clearActiveShotAsset(
  project: Project,
  stage: ShotAssetStage,
  shotId: string,
  options: {
    archive?: boolean;
  } = {}
): GeneratedAsset | null {
  const current = getActiveShotAsset(project, stage, shotId);

  if (!current) {
    return null;
  }

  if (options.archive !== false) {
    archiveShotAssetVersion(project, stage, shotId, current);
  }

  setShotAssetCollection(
    project,
    stage,
    getShotAssetCollection(project, stage).filter((asset) => asset.shotId !== shotId)
  );

  return current;
}

function setActiveShotAsset(project: Project, stage: ShotAssetStage, shotId: string, nextAsset: GeneratedAsset): void {
  const current = getActiveShotAsset(project, stage, shotId);

  if (current && current.relativePath !== nextAsset.relativePath) {
    archiveShotAssetVersion(project, stage, shotId, current);
  }

  removeShotAssetVersionFromHistory(project, stage, shotId, nextAsset.relativePath);
  setShotAssetCollection(
    project,
    stage,
    [...getShotAssetCollection(project, stage).filter((asset) => asset.shotId !== shotId), nextAsset]
  );
}

function archiveAllActiveShotAssets(project: Project, stage: ShotAssetStage): void {
  for (const asset of getShotAssetCollection(project, stage)) {
    if (asset.shotId) {
      archiveShotAssetVersion(project, stage, asset.shotId, asset);
    }
  }

  setShotAssetCollection(project, stage, []);
}

function clearAllShotAssetHistory(project: Project, stage: ShotAssetStage): void {
  setShotAssetCollection(project, stage, []);
  setShotAssetHistoryMap(project, stage, {});
}

function clearAllReferenceFrameAssetHistory(project: Project): void {
  clearAllShotAssetHistory(project, 'images');
  clearAllShotAssetHistory(project, 'lastImages');
}

function archiveAllActiveReferenceFrameAssets(project: Project): void {
  archiveAllActiveShotAssets(project, 'images');
  archiveAllActiveShotAssets(project, 'lastImages');
}

function invalidateGeneratedMediaFromReferenceLibrary(project: Project): void {
  clearAllReferenceFrameAssetHistory(project);
  clearAllShotAssetHistory(project, 'audios');
  clearAllShotAssetHistory(project, 'videos');
  project.assets.finalVideo = null;
  resetStage(project, 'shots');
  resetStage(project, 'edit');
}

function resetDownstreamArtifacts(project: Project, stage: StageId): void {
  if (stage === 'script') {
    project.script = null;
    project.storyboard = [];
    clearAllReferenceFrameAssetHistory(project);
    clearAllShotAssetHistory(project, 'audios');
    clearAllShotAssetHistory(project, 'videos');
    project.assets.finalVideo = null;
    project.referenceLibrary = createEmptyReferenceLibrary();
    project.artifacts.scriptMarkdown = null;
    project.artifacts.scriptJson = null;
    project.artifacts.storyboardJson = null;
    project.artifacts.referenceLibraryJson = null;
    resetStage(project, 'assets');
    resetStage(project, 'storyboard');
    resetStage(project, 'shots');
    resetStage(project, 'edit');
    return;
  }

  if (stage === 'assets') {
    project.referenceLibrary = createEmptyReferenceLibrary();
    project.artifacts.referenceLibraryJson = null;
    invalidateGeneratedMediaFromReferenceLibrary(project);
    return;
  }

  if (stage === 'storyboard') {
    project.storyboard = [];
    clearAllReferenceFrameAssetHistory(project);
    clearAllShotAssetHistory(project, 'audios');
    clearAllShotAssetHistory(project, 'videos');
    project.assets.finalVideo = null;
    project.artifacts.storyboardJson = null;
    resetStage(project, 'shots');
    resetStage(project, 'edit');
    return;
  }

  if (stage === 'shots') {
    archiveAllActiveReferenceFrameAssets(project);
    archiveAllActiveShotAssets(project, 'videos');
    project.assets.finalVideo = null;
    resetStage(project, 'edit');
    return;
  }

  project.assets.finalVideo = null;
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

function setReferenceCollection(
  project: Project,
  kind: ReferenceAssetKind,
  items: ReferenceAssetItem[]
): void {
  if (kind === 'character') {
    project.referenceLibrary.characters = items;
    return;
  }

  if (kind === 'scene') {
    project.referenceLibrary.scenes = items;
    return;
  }

  project.referenceLibrary.objects = items;
}

function buildShotReferenceSelectionId(kind: ReferenceAssetKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

function getStoryboardShot(project: Project, shotId: string): Project['storyboard'][number] {
  const shot = project.storyboard.find((item) => item.id === shotId);

  if (!shot) {
    throw new Error(`未找到镜头 ${shotId}`);
  }

  return shot;
}

function getStoryboardShotIndex(project: Project, shotId: string): number {
  return project.storyboard.findIndex((item) => item.id === shotId);
}

function getPreviousStoryboardShot(
  project: Project,
  shotOrId: Project['storyboard'][number] | string
): Project['storyboard'][number] | null {
  const shotId = typeof shotOrId === 'string' ? shotOrId : shotOrId.id;
  const index = getStoryboardShotIndex(project, shotId);

  if (index <= 0) {
    return null;
  }

  return project.storyboard[index - 1] ?? null;
}

function shareSameLongTakeIdentifier(
  left: Pick<Project['storyboard'][number], 'longTakeIdentifier'> | null | undefined,
  right: Pick<Project['storyboard'][number], 'longTakeIdentifier'> | null | undefined
): boolean {
  return Boolean(left?.longTakeIdentifier && right?.longTakeIdentifier && left.longTakeIdentifier === right.longTakeIdentifier);
}

function isLongTakeContinuationShot(project: Project, shot: Project['storyboard'][number]): boolean {
  return shareSameLongTakeIdentifier(getPreviousStoryboardShot(project, shot), shot);
}

function getDownstreamLongTakeDependentShotIds(project: Project, shotId: string): string[] {
  const index = getStoryboardShotIndex(project, shotId);

  if (index === -1) {
    return [];
  }

  const dependentShotIds: string[] = [];
  let previousShot = project.storyboard[index] ?? null;

  for (let cursor = index + 1; cursor < project.storyboard.length; cursor += 1) {
    const nextShot = project.storyboard[cursor];

    if (!previousShot || !shareSameLongTakeIdentifier(previousShot, nextShot)) {
      break;
    }

    dependentShotIds.push(nextShot.id);
    previousShot = nextShot;
  }

  return dependentShotIds;
}

function getGenerationReferenceSelectionIds(
  project: Project,
  shot: Project['storyboard'][number]
): Set<string> {
  const referenceLibrary = getGenerationReferenceLibraryForShot(project.referenceLibrary, shot, project.script);
  const selectionIds = [
    ...referenceLibrary.characters.map((item) => buildShotReferenceSelectionId('character', item.id)),
    ...referenceLibrary.scenes.map((item) => buildShotReferenceSelectionId('scene', item.id)),
    ...referenceLibrary.objects.map((item) => buildShotReferenceSelectionId('object', item.id))
  ];

  return new Set(selectionIds);
}

function setShotReferenceSelections(
  shot: Project['storyboard'][number],
  nextSelections: {
    manualReferenceAssetIds?: string[];
    excludedReferenceAssetIds?: string[];
  }
): void {
  if (nextSelections.manualReferenceAssetIds) {
    shot.manualReferenceAssetIds = [...new Set(nextSelections.manualReferenceAssetIds)];
  }

  if (nextSelections.excludedReferenceAssetIds) {
    shot.excludedReferenceAssetIds = [...new Set(nextSelections.excludedReferenceAssetIds)];
  }
}

function invalidateGeneratedMediaFromStoryboardShotReferenceChange(
  project: Project,
  shotId: string
): {
  hadImageOutput: boolean;
  hadLastImageOutput: boolean;
  hadVideoOutput: boolean;
  hadFinalVideo: boolean;
  downstreamDependentShotIds: string[];
} {
  const downstreamDependentShotIds = getDownstreamLongTakeDependentShotIds(project, shotId);
  const hadImageOutput = Boolean(getActiveShotAsset(project, 'images', shotId));
  const hadLastImageOutput = Boolean(getActiveShotAsset(project, 'lastImages', shotId));
  const hadVideoOutput = Boolean(getActiveShotAsset(project, 'videos', shotId));
  const hadFinalVideo = Boolean(project.assets.finalVideo);

  clearActiveShotAsset(project, 'images', shotId);
  clearActiveShotAsset(project, 'lastImages', shotId);
  clearActiveShotAsset(project, 'videos', shotId);
  for (const dependentShotId of downstreamDependentShotIds) {
    clearActiveShotAsset(project, 'images', dependentShotId);
    clearActiveShotAsset(project, 'videos', dependentShotId);
  }
  project.assets.finalVideo = null;
  resetStage(project, 'shots');
  resetStage(project, 'edit');

  return {
    hadImageOutput,
    hadLastImageOutput,
    hadVideoOutput,
    hadFinalVideo,
    downstreamDependentShotIds
  };
}

function areReferenceSelectionSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function updateReferenceItem(
  project: Project,
  kind: ReferenceAssetKind,
  itemId: string,
  updater: (item: ReferenceAssetItem) => ReferenceAssetItem
): ReferenceAssetItem {
  const items = getReferenceCollection(project, kind);
  const index = items.findIndex((item) => item.id === itemId);

  if (index === -1) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  const nextItem = updater(items[index]);
  const nextItems = [...items];
  nextItems[index] = nextItem;
  setReferenceCollection(project, kind, nextItems);
  return nextItem;
}

function shouldUseUploadedReferenceImage(referenceImageRelativePath: string, useReferenceImage?: boolean): boolean {
  if (typeof useReferenceImage === 'boolean') {
    return Boolean(useReferenceImage && referenceImageRelativePath);
  }

  return Boolean(referenceImageRelativePath);
}

function getReferenceWorkflowKind(
  kind: ReferenceAssetKind,
  useReferenceImage: boolean
): 'character_asset' | 'reference_image_to_image' | 'text_to_image' {
  if (!useReferenceImage) {
    return 'text_to_image';
  }

  if (kind === 'character') {
    return 'character_asset';
  }

  return 'reference_image_to_image';
}

function hasConfiguredTtsWorkflow(appSettings: AppSettings): boolean {
  return getRuntimeStatus(appSettings).ttsWorkflowExists;
}

function shouldUseTtsWorkflow(project: Project, appSettings: AppSettings): boolean {
  return project.settings.useTtsWorkflow && hasConfiguredTtsWorkflow(appSettings);
}

function getAllReferenceItems(referenceLibrary: Project['referenceLibrary']): ReferenceAssetItem[] {
  return [
    ...referenceLibrary.characters,
    ...referenceLibrary.scenes,
    ...referenceLibrary.objects
  ];
}

function buildReferenceContext(referenceLibrary: Project['referenceLibrary']): string {
  const sections: string[] = [];
  const collections: Array<[ReferenceAssetKind, string, ReferenceAssetItem[]]> = [
    ['character', '角色参考', referenceLibrary.characters],
    ['scene', '场景参考', referenceLibrary.scenes],
    ['object', '物品参考', referenceLibrary.objects]
  ];

  for (const [kind, label, items] of collections) {
    const formatted = items
      .map((item) => {
        const detail =
          kind === 'character'
            ? buildCharacterReferenceDetail(item)
            : item.summary.trim() || item.generationPrompt.trim();
        return detail ? `${item.name}（${detail}）` : item.name;
      })
      .filter(Boolean);

    if (formatted.length) {
      sections.push(`${label}：${formatted.join('；')}`);
    }
  }

  return sections.join('\n');
}

function buildVideoCharacterReferencePrompt(
  project: Project,
  shot: Project['storyboard'][number]
): string {
  const hasSpeechContent = Boolean(shot.dialogue.trim() || shot.voiceover.trim());
  const referenceLibrary = getGenerationReferenceLibraryForShot(project.referenceLibrary, shot, project.script);
  const characters = referenceLibrary.characters
    .map((item) => ({
      name: item.name.trim(),
      detail: buildCharacterReferenceDetail(item)
    }))
    .filter((item) => item.name && item.detail);

  if (!characters.length) {
    return '';
  }

  const haystack = `${shot.dialogue}\n${shot.voiceover}\n${shot.videoPrompt}\n${shot.speechPrompt}`.toLowerCase();
  const matchedCharacters = hasSpeechContent
    ? characters.filter((item) => haystack.includes(item.name.toLowerCase()))
    : characters;
  const selectedCharacters = (matchedCharacters.length ? matchedCharacters : characters).slice(0, hasSpeechContent ? 4 : 6);

  return [
    hasSpeechContent ? '人物一致性与说话者识别：' : '人物一致性约束：',
    ...selectedCharacters.map((item) => `- ${item.name}：${item.detail}`),
    hasSpeechContent
      ? '上述设定属于硬约束：脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和气质保持稳定。镜头内如有对白或旁白，必须根据这些人物外观、身份和气质特征明确当前说话者，并让对应人物的口型、表情、动作与发声主体一致，不要只写角色名。'
      : '上述设定属于硬约束：脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和气质保持稳定，除非剧情明确要求，否则不要擅自换脸、换装或改变人物年龄感。'
  ].join('\n');
}

function buildFirstFrameCharacterReferencePrompt(
  project: Project,
  shot: Project['storyboard'][number]
): string {
  const referenceLibrary = getGenerationReferenceLibraryForShot(project.referenceLibrary, shot, project.script);
  const characters = referenceLibrary.characters
    .map((item) => ({
      name: item.name.trim(),
      detail: buildCharacterReferenceDetail(item)
    }))
    .filter((item) => item.name && item.detail)
    .slice(0, 6);

  if (!characters.length) {
    return '';
  }

  return [
    '人物一致性约束：',
    ...characters.map((item) => `- ${item.name}：${item.detail}`),
    '- 上述人物设定属于硬约束：脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和整体气质保持稳定；当前首帧里实际出镜的人物必须与这些设定一致，不要换脸、换装、换年龄感，也不要混入额外主角。'
  ].join('\n');
}

function sanitizeVideoPromptText(text: string): string {
  return text
    .trim()
    .replace(/[“”"「」『』]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function buildVideoShotDirectivePrompt(shot: Project['storyboard'][number]): string {
  return buildVideoShotDirectivePromptWithDuration(shot, shot.durationSeconds);
}

function buildVideoShotDirectivePromptWithDuration(
  shot: Project['storyboard'][number],
  durationSeconds: number
): string {
  const camera = sanitizeVideoPromptText(shot.camera);
  const composition = sanitizeVideoPromptText(shot.composition);

  return [
    '镜头要求：',
    camera ? `- 景别与运镜：${camera}` : '',
    composition ? `- 构图与主体：${composition}` : '',
    `- 时长节奏：按 ${durationSeconds} 秒镜头完整展开动作与表演，保留起势、过程、停顿和收势，不要在前半段过快完成全部信息，也不要突然硬切、突然停住或仓促收尾。`
  ]
    .filter(Boolean)
    .join('\n');
}

function buildVideoContinuityPrompt(): string {
  return [
    '连贯性要求：',
    '- 镜头内部优先通过人物走位、视线变化、前后景层次和轻微运镜推进节奏，不要频繁跳变构图或突然切到另一个状态。',
    '- 表演与动作要连续自然，保留细微停顿、呼吸感和余韵，避免生硬跳切感。',
    '- 必须严格承接首帧输入图里的角色位置、服装、道具、光线方向和空间关系，不要重新起镜或换一套画面状态。'
  ].join('\n');
}

function buildVideoQualityGuardPrompt(hasSpeechContent: boolean): string {
  return [
    '质量约束：',
    '- 人物脸型五官、发型发色、体型比例、服装主色、关键配饰和道具状态在整段镜头内保持稳定，不要中途漂移、闪变或替换人物。',
    '- 动作要符合真实受力、惯性和节奏，避免突然抽动、无意义抖动、瞬移、肢体穿模、手指数量异常和背景呼吸感。',
    hasSpeechContent
      ? '- 有语音时，只有正确的说话主体出现明显口型、下颌和呼吸节奏变化，其他人物不要误开口；口型、表情、视线和身体动作必须互相匹配。'
      : '- 无语音时，人物嘴部保持自然闭合或仅有呼吸性微动，不要出现无故张嘴、说话感或错误的人声表演。'
  ].join('\n');
}

async function uploadImageToComfyCached(
  localPath: string,
  cache: Map<string, string>,
  signal?: AbortSignal
): Promise<string> {
  const cached = cache.get(localPath);
  if (cached) {
    return cached;
  }

  const uploaded = await uploadImageToComfy(localPath, { signal });
  cache.set(localPath, uploaded);
  return uploaded;
}

async function buildGenerationReferenceInputs(
  project: Project,
  uploadCache: Map<string, string>,
  shot?: Project['storyboard'][number]
): Promise<GenerationReferenceInputs> {
  const signal = getProjectAbortSignal(project.id);
  const referenceLibrary = shot
    ? getGenerationReferenceLibraryForShot(project.referenceLibrary, shot, project.script)
    : project.referenceLibrary;
  const referenceContext = buildReferenceContext(referenceLibrary);
  const collections: Array<[ReferenceAssetKind, ReferenceAssetItem[]]> = [
    ['character', referenceLibrary.characters],
    ['scene', referenceLibrary.scenes],
    ['object', referenceLibrary.objects]
  ];
  const preparedByKind = {
    character: [] as Array<Record<string, TemplateVariable>>,
    scene: [] as Array<Record<string, TemplateVariable>>,
    object: [] as Array<Record<string, TemplateVariable>>
  };
  let referenceImageCount = 0;

  for (const [kind, items] of collections) {
    for (const item of items) {
      let inputImage = '';
      let relativePath = '';

      if (item.asset?.relativePath) {
        relativePath = item.asset.relativePath;
        inputImage = await uploadImageToComfyCached(fromStorageRelative(item.asset.relativePath), uploadCache, signal);
        referenceImageCount += 1;
      }

      preparedByKind[kind].push({
        kind,
        id: item.id,
        name: item.name,
        summary: item.summary,
        generation_prompt: kind === 'character' ? buildCharacterReferenceDetail(item) : item.generationPrompt,
        ethnicity_hint: item.ethnicityHint,
        input_image: inputImage,
        relative_path: relativePath
      });
    }
  }

  const referenceAssets = [...preparedByKind.character, ...preparedByKind.scene, ...preparedByKind.object];
  const characterReferenceImages = preparedByKind.character
    .map((item) => (typeof item.input_image === 'string' ? item.input_image : ''))
    .filter(Boolean);
  const sceneReferenceImages = preparedByKind.scene
    .map((item) => (typeof item.input_image === 'string' ? item.input_image : ''))
    .filter(Boolean);
  const objectReferenceImages = preparedByKind.object
    .map((item) => (typeof item.input_image === 'string' ? item.input_image : ''))
    .filter(Boolean);
  const referenceImages = [...sceneReferenceImages, ...characterReferenceImages, ...objectReferenceImages];
  const editImage1 = sceneReferenceImages[0] ?? characterReferenceImages[0] ?? objectReferenceImages[0] ?? '';
  const editImage2 = characterReferenceImages[0] ?? sceneReferenceImages[0] ?? objectReferenceImages[0] ?? editImage1;
  const editImage3 = objectReferenceImages[0] ?? characterReferenceImages[0] ?? sceneReferenceImages[0] ?? editImage2;

  return {
    referenceContext,
    referenceCount: getAllReferenceItems(referenceLibrary).length,
    referenceImageCount,
    referenceImages,
    referenceVariables: {
      reference_context: referenceContext,
      reference_count: getAllReferenceItems(referenceLibrary).length,
      reference_image_count: referenceImageCount,
      reference_assets: referenceAssets,
      reference_assets_json: JSON.stringify(referenceAssets),
      reference_images: referenceImages,
      reference_images_json: JSON.stringify(referenceImages),
      edit_image_1: editImage1,
      edit_image_2: editImage2,
      edit_image_3: editImage3,
      character_reference_assets: preparedByKind.character,
      character_reference_images: characterReferenceImages,
      character_reference_image: characterReferenceImages[0] ?? '',
      scene_reference_assets: preparedByKind.scene,
      scene_reference_images: sceneReferenceImages,
      scene_reference_image: sceneReferenceImages[0] ?? '',
      object_reference_assets: preparedByKind.object,
      object_reference_images: objectReferenceImages,
      object_reference_image: objectReferenceImages[0] ?? ''
    }
  };
}

function appendReferenceContext(prompt: string, referenceContext: string): string {
  if (!referenceContext.trim()) {
    return prompt;
  }

  return `${prompt}\n\n参考资产约束：\n${referenceContext}`;
}

type ReferenceFrameKind = 'start' | 'end';

function buildReferenceFrameGazePrompt(frameKind: ReferenceFrameKind): string {
  return frameKind === 'start'
    ? '人物眼神要求：如画面中出现人物，必须明确主要人物在镜头开始瞬间的眼神方向、注视对象和眼神状态，写清是在看谁、看向哪里，以及这种眼神传达出的情绪与心理张力；不要只写“看向前方”或只写表情。'
    : '人物眼神要求：如画面中出现人物，必须明确主要人物在镜头结束瞬间的眼神方向、注视对象和眼神状态，写清是在看谁、看向哪里，以及这种眼神传达出的情绪与心理张力；不要只写“看向前方”或只写表情。';
}

function buildReferenceFrameShotDirectivePrompt(
  shot: Project['storyboard'][number],
  frameKind: ReferenceFrameKind
): string {
  const frameLabel = frameKind === 'start' ? '起始参考帧' : '结束参考帧';
  const detailLines = [
    `- 镜头标题与作用：${shot.title.trim()}，${shot.purpose.trim()}`,
    `- 景别与机位：${shot.camera.trim()}`,
    `- 构图与主体：${shot.composition.trim()}`,
    frameKind === 'start'
      ? '- 定格要求：这是镜头开始瞬间的静态画面，要明确主体位置、朝向、视线方向、眼神焦点、眼神状态、表情、姿态、手部动作、关键道具状态，以及前景、中景、背景的空间层次。'
      : '- 定格要求：这是镜头结束瞬间的静态画面，要明确主体最终位置、朝向、视线方向、眼神焦点、眼神状态、表情、姿态、手部动作、关键道具状态，以及前景、中景、背景的空间层次。',
    frameKind === 'start'
      ? '- 画面要求：优先补足环境细节、时间光线、材质、氛围和人物起始动作，不要只写剧情概述，不要只写某人正在做某事这种过于简略的提示。'
      : '- 画面要求：优先补足环境细节、时间光线、材质、氛围和人物收束后的最终状态，不要只写剧情概述，不要只写某人做完某事这种过于简略的提示。'
  ];

  if (shot.dialogue.trim()) {
    detailLines.push(`- 对白语境：镜头相关台词为${shot.dialogue.trim()}。这句台词只用于帮助理解人物状态与冲突，不要直接生成字幕文字。`);
  }

  if (shot.voiceover.trim()) {
    detailLines.push(`- 旁白语境：镜头相关画外音为${shot.voiceover.trim()}。仅用于帮助理解情绪和信息，不要直接生成字幕文字。`);
  }

  return [`${frameLabel}画面要求：`, ...detailLines].join('\n');
}

function buildReferenceFrameQualityPrompt(
  workflow: 'storyboard_image' | 'text_to_image' | 'reference_image_to_image' | 'image_edit' | 'image_to_video',
  frameKind: ReferenceFrameKind
): string {
  const frameLabel = frameKind === 'start' ? '起始参考帧' : '结束参考帧';
  const parts = [
    `${frameLabel}质量要求：`,
    '- 输出必须是一张电影级写实静帧，不是概念草图、分镜示意图、海报、拼贴图、多联画、人物设定板或 UI 截图。',
    '- 主体边缘清晰，人物五官稳定，双眼对称，手部结构正确，道具形体完整；避免糊脸、崩手、重复人物、额外肢体、奇怪透视和背景漂移。',
    '- 画面要同时具备明确主体、可读动作定格、前中后景层次、可信光线方向、材质细节和空间深度，优先选择最能代表镜头开场信息的决定性瞬间。',
    '- 不要生成字幕、水印、logo、边框、贴纸、说明文字、时间戳，也不要做成二次元线稿感或低完成度草模感。'
  ];

  if (workflow === 'storyboard_image' || workflow === 'image_edit') {
    parts.push(
      '- 参考图只用于锁定人物身份、服装、场景和物品，不要照抄参考图构图，也不要把多张参考图机械拼接到同一张画面里。'
    );
  }

  return parts.join('\n');
}

function buildReferenceFrameWorkflowPrompt(
  project: Project,
  shot: Project['storyboard'][number],
  workflow: 'storyboard_image' | 'text_to_image' | 'reference_image_to_image' | 'image_edit' | 'image_to_video',
  frameKind: ReferenceFrameKind
): string {
  const basePrompt = (frameKind === 'start' ? shot.firstFramePrompt : shot.lastFramePrompt).trim();

  if (workflow === 'text_to_image') {
    return [basePrompt, buildReferenceFrameGazePrompt(frameKind)].filter(Boolean).join('\n\n');
  }

  const characterPrompt = buildFirstFrameCharacterReferencePrompt(project, shot);
  const parts = [
    buildReferenceFrameShotDirectivePrompt(shot, frameKind),
    basePrompt,
    buildReferenceFrameGazePrompt(frameKind),
    characterPrompt,
    buildReferenceFrameQualityPrompt(workflow, frameKind),
    frameKind === 'start'
      ? '补充要求：把镜头开场一瞬间写实地冻结成一张完整画面，优先具体化角色状态、空间关系和环境信息。'
      : '补充要求：把镜头结束一瞬间写实地冻结成一张完整画面，优先具体化角色收束状态、空间关系和环境信息。'
  ];

  if (workflow === 'storyboard_image' || workflow === 'image_edit') {
    parts.push(
      `生成要求：基于参考输入重新生成一张全新的镜头${frameKind === 'start' ? '起始' : '结束'}参考帧。`,
      '参考输入只用于提取人物身份、造型、服装、场景、物品和整体风格约束，不要把它当作待修补、待微调或待局部重绘的底图。',
      '最终结果必须是一张新的完整画面，可以重新组织机位、景别、构图、动作、光线和背景，但要保持参考信息中的关键设定一致。'
    );
  }

  return parts.filter(Boolean).join('\n\n');
}

function buildMergedVideoPrompt(
  project: Project,
  shot: Project['storyboard'][number],
  options: {
    includeSpeechPrompt: boolean;
    durationSeconds?: number;
  }
): string {
  const hasDialogueContent = Boolean(shot.dialogue.trim());
  const hasVoiceoverContent = Boolean(shot.voiceover.trim());
  const hasSpeechContent = hasDialogueContent || hasVoiceoverContent;
  const videoPrompt = sanitizeVideoPromptText(shot.videoPrompt);
  const characterPrompt = buildVideoCharacterReferencePrompt(project, shot);
  const backgroundSoundPrompt = sanitizeVideoPromptText(shot.backgroundSoundPrompt);
  const speechPrompt = sanitizeVideoPromptText(shot.speechPrompt);
  const inlineDialogueInstruction = buildInlineDialogueInstruction(project, shot);
  const inlineVoiceoverInstruction = buildInlineVoiceoverInstruction(shot);
  const parts = [
    buildVideoShotDirectivePromptWithDuration(shot, options.durationSeconds ?? shot.durationSeconds),
    videoPrompt,
    buildVideoContinuityPrompt(),
    buildVideoQualityGuardPrompt(hasDialogueContent)
  ];

  if (characterPrompt) {
    parts.push(characterPrompt);
  }

  if (hasSpeechContent) {
    parts.push(buildSpeechLanguageInstruction(project.settings.language, options.includeSpeechPrompt));

    if (backgroundSoundPrompt) {
      parts.push(
        options.includeSpeechPrompt
          ? `背景声音要求：${backgroundSoundPrompt}`
          : `背景声音要求：${backgroundSoundPrompt}。仅保留自然环境音、动作音和空间氛围声，不要额外生成独立对白人声。`
      );
    } else if (!options.includeSpeechPrompt) {
      parts.push('背景声音要求：保留自然环境音、动作音和空间氛围声，不要额外生成独立对白人声。');
    }

    if (hasDialogueContent) {
      parts.push(
        options.includeSpeechPrompt
          ? '说话者要求：如镜头中有人说话，必须通过人物外观、身份和气质特征明确发声主体，并让口型、表情、动作与台词同步。'
          : '口型表演要求：如镜头中有人说话，只表现正确说话主体的口型、呼吸、表情和身体伴随动作，不要额外生成独立对白人声；对白音轨会在后续单独处理。'
      );
    } else if (hasVoiceoverContent) {
      parts.push(
        options.includeSpeechPrompt
          ? '旁白表演要求：这是画外音/旁白，不要让镜头内人物强行对口型；画面情绪、节奏和反应要与旁白信息同步。'
          : '旁白表演要求：画面只需要承接画外音带来的情绪和节奏，不要额外生成独立对白人声，也不要让镜头内人物误开口。'
      );
    }
  } else {
    parts.push(
      backgroundSoundPrompt
        ? `声音要求：本镜头没有对白或旁白，不要出现人声或说话声；请生成自然、真实、连贯的背景环境音、动作音和空间氛围声。重点：${backgroundSoundPrompt}`
        : '声音要求：本镜头没有对白或旁白，不要出现人声或说话声；请生成自然、真实、连贯的背景环境音、动作音和空间氛围声。'
    );
  }

  if (options.includeSpeechPrompt) {
    if (inlineDialogueInstruction) {
      parts.push(
        `对白内容要求：严格按以下“人物描述：对白”关系执行，不要改写台词文字，也不要输出字幕：${inlineDialogueInstruction}`
      );
    }

    if (inlineVoiceoverInstruction) {
      parts.push(`旁白内容要求：${inlineVoiceoverInstruction}。这是画外音，不要强行让镜头内人物都对口型。`);
    }

    if (speechPrompt) {
      parts.push(`发声表演要求：${speechPrompt}`);
    }
  }

  return parts.filter(Boolean).join('\n\n');
}

function appendTransitionHint(prompt: string, shot: Project['storyboard'][number]): string {
  const transitionHint = sanitizeVideoPromptText(shot.transitionHint);

  if (!transitionHint) {
    return prompt;
  }

  return `${prompt}\n\n镜头衔接要求：${transitionHint}。优先通过动作延续、视线延续、空间方向延续或情绪延续自然进入下一镜，避免突兀跳切。`;
}

function getVideoWorkflowPrompt(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  options: {
    durationSeconds?: number;
  } = {}
): string {
  return sanitizeVideoPromptText(
    appendTransitionHint(
      buildMergedVideoPrompt(project, shot, {
        includeSpeechPrompt: !shouldUseTtsWorkflow(project, appSettings),
        durationSeconds: options.durationSeconds
      }),
      shot
    )
  );
}

function buildVideoNegativePrompt(baseNegativePrompt: string): string {
  const extraNegativePrompt =
    'subtitle, text overlay, logo, identity drift, face drift, temporal inconsistency, flickering, duplicate person, extra limbs, wrong mouth movement';

  return baseNegativePrompt.trim() ? `${baseNegativePrompt}, ${extraNegativePrompt}` : extraNegativePrompt;
}

function buildImageNegativePrompt(baseNegativePrompt: string): string {
  const extraNegativePrompt =
    'low quality, blurry, soft focus, out of frame, duplicate person, extra limbs, extra fingers, missing fingers, bad anatomy, asymmetrical eyes, deformed face, waxy skin, broken hands, fused fingers, bad perspective, collage, split screen, storyboard sheet, concept art page, sketch, text, subtitle, watermark, logo';

  return baseNegativePrompt.trim() ? `${baseNegativePrompt}, ${extraNegativePrompt}` : extraNegativePrompt;
}

function isSpeechPromptDisabled(speechPrompt: string): boolean {
  return /无语音内容|不生成语音|无需语音|无台词|无旁白|no spoken content|no speech|no dialogue|no voiceover|no narration|none\b/i.test(
    speechPrompt.trim()
  );
}

function normalizeTtsSpeechText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[“"'`]+|[”"'`]+$/g, '')
    .trim();
}

function sanitizeTtsInstructionText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .trim();
}

function describeProjectLanguage(language: string): string {
  const trimmed = language.trim() || 'zh-CN';
  const normalized = trimmed.toLowerCase();

  if (normalized.startsWith('zh')) {
    return `中文（${trimmed}）`;
  }

  if (normalized.startsWith('en')) {
    return `英语（${trimmed}）`;
  }

  if (normalized.startsWith('ja')) {
    return `日语（${trimmed}）`;
  }

  if (normalized.startsWith('ko')) {
    return `韩语（${trimmed}）`;
  }

  if (normalized.startsWith('fr')) {
    return `法语（${trimmed}）`;
  }

  if (normalized.startsWith('de')) {
    return `德语（${trimmed}）`;
  }

  if (normalized.startsWith('es')) {
    return `西班牙语（${trimmed}）`;
  }

  if (normalized.startsWith('ru')) {
    return `俄语（${trimmed}）`;
  }

  return trimmed;
}

function buildSpeechLanguageInstruction(language: string, includeSpeechPrompt: boolean): string {
  const languageLabel = describeProjectLanguage(language);

  return includeSpeechPrompt
    ? `语音语言要求：镜头中所有可听见的对白和旁白必须使用${languageLabel}；除非输入文本本身明确要求，不要自行切换成其他语言、方言或口音。`
    : `口型语言要求：如镜头中有人开口，口型、停连和面部发声节奏必须与${languageLabel}对白一致；不要表现成其他语言的说话节奏。`;
}

function getTtsRoleLabels(language: string): {
  primary: string;
  secondary: string;
  tertiary: string;
} {
  const normalized = language.trim().toLowerCase();

  if (normalized.startsWith('zh')) {
    return {
      primary: '说话人',
      secondary: '备用说话人一',
      tertiary: '备用说话人二'
    };
  }

  if (normalized.startsWith('ja')) {
    return {
      primary: '話者',
      secondary: '予備話者一',
      tertiary: '予備話者二'
    };
  }

  if (normalized.startsWith('ko')) {
    return {
      primary: '화자',
      secondary: '보조 화자 1',
      tertiary: '보조 화자 2'
    };
  }

  return {
    primary: 'Speaker',
    secondary: 'Backup Speaker 1',
    tertiary: 'Backup Speaker 2'
  };
}

function buildDialogueSpeakerDescription(
  speaker: string | null,
  referenceCharacter: ReferenceAssetItem | null
): string {
  const referenceDetail = referenceCharacter
    ? sanitizeVideoPromptText(
        buildCharacterReferenceDetail(referenceCharacter).split(referenceCharacter.name.trim()).join('该人物')
      )
        .replace(/[:：]/g, '，')
        .replace(/[;；]+/g, '，')
    : '';

  if (referenceDetail) {
    return referenceDetail;
  }

  if (speaker?.trim()) {
    return `镜头中名为${speaker.trim()}的人物`;
  }

  return '镜头中当前出声的人物';
}

function extractDialogueSegments(
  dialogue: string
): Array<{
  speaker: string | null;
  text: string;
}> {
  const lines = dialogue
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  return lines
    .map((line) => {
      const matched = line.match(/^([^:：]{1,20})[:：]\s*(.+)$/);

      if (matched) {
        return {
          speaker: matched[1].trim(),
          text: normalizeTtsSpeechText(matched[2])
        };
      }

      return {
        speaker: null,
        text: normalizeTtsSpeechText(line)
      };
    })
    .filter((segment) => Boolean(segment.text));
}

function hashSpeakerKey(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function findReferenceCharacterForDialogueSegment(
  characters: ReferenceAssetItem[],
  speaker: string | null
): ReferenceAssetItem | null {
  if (speaker) {
    return characters.find((item) => matchesReferenceName(item.name, speaker)) ?? null;
  }

  return characters.length === 1 ? characters[0] ?? null : null;
}

function buildTtsSpeakerKey(
  speaker: string | null,
  referenceCharacter: ReferenceAssetItem | null
): string {
  if (referenceCharacter) {
    return `character:${referenceCharacter.id}`;
  }

  if (speaker) {
    const normalizedSpeaker = normalizeReferenceSearchText(speaker);
    return normalizedSpeaker ? `speaker:${normalizedSpeaker}` : `speaker:${speaker.trim()}`;
  }

  return 'speaker:anonymous';
}

function buildNoReferenceTtsPrompt(
  speakerKey: string,
  referenceCharacter: ReferenceAssetItem | null,
  projectLanguage: string
): { prompt: string; defaultSpeaker: string } {
  const preset = NO_REFERENCE_TTS_VOICE_PRESETS[hashSpeakerKey(speakerKey) % NO_REFERENCE_TTS_VOICE_PRESETS.length];
  const characterHint = referenceCharacter
    ? sanitizeTtsInstructionText(
        buildCharacterReferenceDetail(referenceCharacter).split(referenceCharacter.name.trim()).join('该角色')
      )
    : '';

  return {
    prompt: [
      '只朗读输入文本中的对白正文，不要添加说话人名称、角色标签、括号说明、动作描述、旁白或额外补充。',
      `发音语言严格使用${describeProjectLanguage(projectLanguage)}；除非输入文本本身明确包含其他语言，不要自行切换语言、方言或口音。`,
      '情绪、停连和轻重音贴合当前这句对白，但整体保持自然口语，不要做成夸张播音腔。',
      `音色设定：${preset.instruction}`,
      characterHint ? `人物气质参考：${characterHint}。` : ''
    ]
      .filter(Boolean)
      .join(' '),
    defaultSpeaker: preset.id
  };
}

function buildTtsPlan(project: Project, shot: Project['storyboard'][number]): TtsPlan {
  if (isSpeechPromptDisabled(shot.speechPrompt)) {
    return {
      segments: [],
      plainText: ''
    };
  }

  const dialogueSegments = extractDialogueSegments(shot.dialogue.trim());
  if (!dialogueSegments.length) {
    return {
      segments: [],
      plainText: ''
    };
  }

  const referenceLibrary = getGenerationReferenceLibraryForShot(project.referenceLibrary, shot, project.script);
  const segments = dialogueSegments.map((segment, index) => {
    const referenceCharacter = findReferenceCharacterForDialogueSegment(referenceLibrary.characters, segment.speaker);
    const speakerKey = buildTtsSpeakerKey(segment.speaker, referenceCharacter);
    const noReferencePrompt = buildNoReferenceTtsPrompt(speakerKey, referenceCharacter, project.settings.language);

    return {
      speakerKey,
      text: segment.text,
      prompt: noReferencePrompt.prompt,
      referenceAudioAbsolutePath: referenceCharacter?.referenceAudio?.relativePath
        ? fromStorageRelative(referenceCharacter.referenceAudio.relativePath)
        : null,
      outputKey: `seg${String(index + 1).padStart(3, '0')}`,
      defaultSpeaker: noReferencePrompt.defaultSpeaker
    };
  });

  return {
    segments,
    plainText: segments.map((segment) => segment.text).join('\n')
  };
}

function buildInlineDialogueInstruction(project: Project, shot: Project['storyboard'][number]): string {
  const dialogueSegments = extractDialogueSegments(shot.dialogue.trim());

  if (!dialogueSegments.length) {
    return '';
  }

  const referenceLibrary = getGenerationReferenceLibraryForShot(project.referenceLibrary, shot, project.script);

  return dialogueSegments
    .map((segment) => {
      const referenceCharacter = findReferenceCharacterForDialogueSegment(referenceLibrary.characters, segment.speaker);
      return `${buildDialogueSpeakerDescription(segment.speaker, referenceCharacter)}：${segment.text}`;
    })
    .join('；');
}

function buildInlineVoiceoverInstruction(shot: Project['storyboard'][number]): string {
  const voiceover = normalizeTtsSpeechText(shot.voiceover.trim());

  if (!voiceover) {
    return '';
  }

  return `画外音/旁白：${voiceover}`;
}

function normalizeReferenceSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s"'`“”‘’「」『』（）()【】[\]{}<>《》，,。.!！？?；;：:/\\|_-]+/g, '')
    .trim();
}

function matchesReferenceName(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeReferenceSearchText(haystack);
  const normalizedNeedle = normalizeReferenceSearchText(needle);

  if (!normalizedHaystack || !normalizedNeedle) {
    return false;
  }

  return normalizedHaystack.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedHaystack);
}

async function uploadAudioToComfyCached(
  localPath: string,
  cache: Map<string, string>,
  signal?: AbortSignal
): Promise<string> {
  const cached = cache.get(localPath);
  if (cached) {
    return cached;
  }

  const uploaded = await uploadAudioToComfy(localPath, { signal });
  cache.set(localPath, uploaded);
  return uploaded;
}

async function buildTtsReferenceAudioPlan(
  segment: TtsSegmentPlan,
  uploadCache: Map<string, string>,
  signal?: AbortSignal
): Promise<TtsReferenceAudioPlan> {
  if (!segment.referenceAudioAbsolutePath) {
    return {
      useReferenceAudio: false,
      narratorReferenceAudio: '',
      speaker1ReferenceAudio: '',
      speaker2ReferenceAudio: ''
    };
  }

  const uploadedAudio = await uploadAudioToComfyCached(segment.referenceAudioAbsolutePath, uploadCache, signal);

  return {
    useReferenceAudio: true,
    narratorReferenceAudio: uploadedAudio,
    speaker1ReferenceAudio: uploadedAudio,
    speaker2ReferenceAudio: uploadedAudio
  };
}

function resolveTtsWorkflowPath(appSettings: AppSettings, useReferenceAudio: boolean): string {
  const configuredWorkflowPath = appSettings.comfyui.workflows.tts.workflowPath;

  if (
    configuredWorkflowPath === DEFAULT_NO_REFERENCE_TTS_WORKFLOW_PATH ||
    configuredWorkflowPath === DEFAULT_REFERENCE_AUDIO_TTS_WORKFLOW_PATH
  ) {
    return useReferenceAudio ? DEFAULT_REFERENCE_AUDIO_TTS_WORKFLOW_PATH : DEFAULT_NO_REFERENCE_TTS_WORKFLOW_PATH;
  }

  return configuredWorkflowPath;
}

function resolveVideoWorkflowPath(appSettings: AppSettings, useLastFrameReference: boolean): string {
  const firstLastFrameWorkflowPath = appSettings.comfyui.workflows.image_to_video_first_last.workflowPath;
  const firstFrameWorkflowPath = appSettings.comfyui.workflows.image_to_video_first_frame.workflowPath;
  const sharedConfiguredWorkflowPath =
    firstLastFrameWorkflowPath && firstLastFrameWorkflowPath === firstFrameWorkflowPath
      ? firstLastFrameWorkflowPath
      : '';

  if (
    sharedConfiguredWorkflowPath === DEFAULT_FIRST_LAST_FRAME_VIDEO_WORKFLOW_PATH ||
    sharedConfiguredWorkflowPath === DEFAULT_SINGLE_FRAME_VIDEO_WORKFLOW_PATH
  ) {
    return useLastFrameReference
      ? DEFAULT_FIRST_LAST_FRAME_VIDEO_WORKFLOW_PATH
      : DEFAULT_SINGLE_FRAME_VIDEO_WORKFLOW_PATH;
  }

  return useLastFrameReference
    ? firstLastFrameWorkflowPath || firstFrameWorkflowPath
    : firstFrameWorkflowPath || firstLastFrameWorkflowPath;
}

function hasConfiguredImageToVideoWorkflow(appSettings: AppSettings): boolean {
  return Boolean(
    appSettings.comfyui.workflows.image_to_video_first_last.workflowPath ||
      appSettings.comfyui.workflows.image_to_video_first_frame.workflowPath
  );
}

function buildTtsVariables(
  project: Project,
  shot: Project['storyboard'][number],
  segment: TtsSegmentPlan,
  referenceAudioPlan: TtsReferenceAudioPlan
) {
  const roleLabels = getTtsRoleLabels(project.settings.language);
  const ttsScript = `${roleLabels.primary}: ${segment.text}`;

  return {
    prompt: segment.prompt,
    speech_prompt: segment.prompt,
    dialogue: segment.text,
    voiceover: '',
    tts_script: ttsScript,
    tts_plain_text: segment.text,
    tts_role_1_name: roleLabels.primary,
    tts_role_2_name: roleLabels.secondary,
    tts_role_3_name: roleLabels.tertiary,
    tts_language: project.settings.language,
    narrator_reference_audio: referenceAudioPlan.narratorReferenceAudio,
    speaker_1_reference_audio: referenceAudioPlan.speaker1ReferenceAudio,
    speaker_2_reference_audio: referenceAudioPlan.speaker2ReferenceAudio,
    tts_default_speaker: segment.defaultSpeaker,
    negative_prompt: project.settings.negativePrompt,
    output_prefix: `${project.id}_${shot.id}_${segment.outputKey}_tts`,
    image_width: project.settings.imageWidth,
    image_height: project.settings.imageHeight,
    video_width: project.settings.videoWidth,
    video_height: project.settings.videoHeight,
    duration_seconds: shot.durationSeconds,
    fps: project.settings.fps,
    input_image: '',
    scene_number: shot.sceneNumber,
    shot_number: shot.shotNumber,
    seed: hashSpeakerKey(`${project.id}:${segment.speakerKey}`) % 9_000_000_000
  };
}

async function getTtsAudioDurationSeconds(
  absolutePath: string,
  appSettings: AppSettings,
  signal?: AbortSignal
): Promise<number | null> {
  if (!appSettings.ffmpeg.binaryPath) {
    return null;
  }

  return await getMediaDurationSeconds(absolutePath, { signal });
}

function getAudioDrivenVideoDurationSeconds(
  shot: Project['storyboard'][number],
  audioDurationSeconds: number | null
): number {
  if (!Number.isFinite(audioDurationSeconds) || !audioDurationSeconds || audioDurationSeconds <= 0) {
    return shot.durationSeconds;
  }

  const minimumAudioCoveredDuration = Math.ceil(audioDurationSeconds + AUDIO_DRIVEN_VIDEO_PADDING_SECONDS);
  return Math.max(1, shot.durationSeconds, minimumAudioCoveredDuration);
}

function resolveVideoGenerationDuration(
  project: Project,
  shot: Project['storyboard'][number],
  audioDurationSeconds: number | null
): {
  durationSeconds: number;
  requestedDurationSeconds: number;
  maxSegmentDurationSeconds: number;
  requiresSegmentStitching: boolean;
} {
  const requestedDurationSeconds = getAudioDrivenVideoDurationSeconds(shot, audioDurationSeconds);
  const maxSegmentDurationSeconds = getMaxVideoSegmentDurationSeconds(project);

  return {
    durationSeconds: requestedDurationSeconds,
    requestedDurationSeconds,
    maxSegmentDurationSeconds,
    requiresSegmentStitching: requestedDurationSeconds > maxSegmentDurationSeconds
  };
}

async function ensureShotTtsAudio(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  uploadCache: Map<string, string>,
  options: {
    reuseExisting?: boolean;
  } = {}
): Promise<PreparedShotTtsAudio> {
  const ttsPlan = buildTtsPlan(project, shot);

  if (!shouldUseTtsWorkflow(project, appSettings) || !ttsPlan.segments.length) {
    return {
      asset: null,
      absolutePath: null,
      durationSeconds: null,
      useReferenceAudio: false,
      reusedExisting: false
    };
  }

  const signal = getProjectAbortSignal(project.id);
  const useReferenceAudio = ttsPlan.segments.some((segment) => Boolean(segment.referenceAudioAbsolutePath));
  const existingAsset = options.reuseExisting === false ? null : getActiveShotAsset(project, 'audios', shot.id);

  if (existingAsset?.relativePath) {
    const absolutePath = fromStorageRelative(existingAsset.relativePath);

    if (existsSync(absolutePath)) {
      return {
        asset: existingAsset,
        absolutePath,
        durationSeconds: await getTtsAudioDurationSeconds(absolutePath, appSettings, signal),
        useReferenceAudio,
        reusedExisting: true
      };
    }

    clearActiveShotAsset(project, 'audios', shot.id, { archive: false });
  }

  const segmentAudioOutputs: Array<{ absolutePath: string; relativePath: string }> = [];

  for (const segment of ttsPlan.segments) {
    const referenceAudioPlan = await buildTtsReferenceAudioPlan(segment, uploadCache, signal);
    const ttsWorkflowPath = resolveTtsWorkflowPath(appSettings, referenceAudioPlan.useReferenceAudio);
    const outputFiles = await runProjectComfyWorkflow(
      project,
      ttsWorkflowPath,
      buildTtsVariables(project, shot, segment, referenceAudioPlan),
      {
        signal,
        label: `tts_${shot.id}_${segment.outputKey}`,
        outputKind: 'audio'
      }
    );
    const outputFile = pickOutputFile(outputFiles, 'audio');
    const buffer = await fetchComfyOutputFile(outputFile, { signal });
    const extension = path.extname(outputFile.filename) || '.wav';
    const savedSegment = await writeProjectFile(
      project.id,
      path.join('audio', shot.id, 'segments', `${segment.outputKey}${extension}`),
      buffer
    );
    segmentAudioOutputs.push(savedSegment);
  }

  let finalAudioAbsolutePath = segmentAudioOutputs[0]!.absolutePath;
  let finalAudioRelativePath = segmentAudioOutputs[0]!.relativePath;

  if (segmentAudioOutputs.length > 1) {
    const mergedAudioRelativePath = buildShotAssetOutputPath('audios', shot.id, '.wav');
    const mergedAudioAbsolutePath = resolveProjectPath(project.id, mergedAudioRelativePath);

    await stitchAudios(
      segmentAudioOutputs.map((item) => item.absolutePath),
      mergedAudioAbsolutePath,
      { signal }
    );

    finalAudioAbsolutePath = mergedAudioAbsolutePath;
    finalAudioRelativePath = toStorageRelative(mergedAudioAbsolutePath);
  }

  const asset = buildAsset(finalAudioRelativePath, ttsPlan.plainText, shot.sceneNumber, shot.id);

  setActiveShotAsset(project, 'audios', shot.id, asset);

  return {
    asset,
    absolutePath: finalAudioAbsolutePath,
    durationSeconds: await getTtsAudioDurationSeconds(finalAudioAbsolutePath, appSettings, signal),
    useReferenceAudio,
    reusedExisting: false
  };
}

function roundDownToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function isZimageTextToImageWorkflowPath(workflowPath: string | undefined): boolean {
  if (!workflowPath?.trim()) {
    return false;
  }

  return path.basename(workflowPath).toLowerCase() === ZIMAGE_TEXT_TO_IMAGE_WORKFLOW_BASENAME;
}

function resolveWorkflowImageDimensions(
  workflowPath: string | undefined,
  width: number,
  height: number
): { imageWidth: number; imageHeight: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));

  if (!isZimageTextToImageWorkflowPath(workflowPath)) {
    return {
      imageWidth: safeWidth,
      imageHeight: safeHeight
    };
  }

  return {
    imageWidth: roundDownToMultiple(Math.max(16, Math.round(safeWidth / 2)), 16),
    imageHeight: roundDownToMultiple(Math.max(16, Math.round(safeHeight / 2)), 16)
  };
}

function buildVideoWorkflowDerivedVariables(
  width: number,
  height: number,
  durationSeconds: number,
  fps: number
): Record<string, TemplateVariable> {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const safeFps = Math.max(1, Math.round(fps));
  const longSide = Math.max(safeWidth, safeHeight);
  const shortSide = Math.min(safeWidth, safeHeight);

  return {
    frame_count: Math.max(2, Math.round(durationSeconds * safeFps) + 1),
    latent_video_width: roundDownToMultiple(safeWidth, 16),
    latent_video_height: roundDownToMultiple(safeHeight, 16),
    video_long_side: longSide,
    video_short_side: shortSide,
    video_conditioning_long_side: Math.max(longSide, 1920)
  };
}

function buildComfyVariables(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  workflow: 'storyboard_image' | 'text_to_image' | 'reference_image_to_image' | 'image_edit' | 'image_to_video',
  options: {
    durationSeconds?: number;
    inputImage?: string;
    lastFrameImage?: string;
    lastFramePrompt?: string;
    frameKind?: ReferenceFrameKind;
    outputPrefix?: string;
    promptOverride?: string;
    referenceContext?: string;
    referenceVariables?: Record<string, TemplateVariable>;
    workflowPath?: string;
    seed?: number;
  } = {}
) {
  const durationSeconds = options.durationSeconds ?? shot.durationSeconds;
  const resolvedImageDimensions = resolveWorkflowImageDimensions(
    options.workflowPath,
    project.settings.imageWidth,
    project.settings.imageHeight
  );
  const negativePrompt =
    workflow === 'image_to_video'
      ? buildVideoNegativePrompt(project.settings.negativePrompt)
      : buildImageNegativePrompt(project.settings.negativePrompt);

  return {
    prompt:
      appendReferenceContext(
        options.promptOverride ??
          (workflow === 'image_to_video'
            ? getVideoWorkflowPrompt(project, shot, appSettings, {
                durationSeconds
              })
            : buildReferenceFrameWorkflowPrompt(project, shot, workflow, options.frameKind ?? 'start')),
        options.referenceContext ?? ''
      ),
    negative_prompt: negativePrompt,
    output_prefix: options.outputPrefix ?? `${project.id}_${shot.id}_${workflow}`,
    image_width: resolvedImageDimensions.imageWidth,
    image_height: resolvedImageDimensions.imageHeight,
    video_width: project.settings.videoWidth,
    video_height: project.settings.videoHeight,
    duration_seconds: durationSeconds,
    fps: project.settings.fps,
    ...buildVideoWorkflowDerivedVariables(
      project.settings.videoWidth,
      project.settings.videoHeight,
      durationSeconds,
      project.settings.fps
    ),
    input_image: options.inputImage ?? '',
    last_frame_image: options.lastFrameImage ?? '',
    last_frame_prompt: options.lastFramePrompt ?? shot.lastFramePrompt,
    ...(options.referenceVariables ?? {}),
      scene_number: shot.sceneNumber,
      shot_number: shot.shotNumber,
      seed: options.seed ?? Math.floor(Math.random() * 9_000_000_000)
  };
}

function buildStoryboardReferencePasses(referenceImages: string[]): string[][] {
  if (!referenceImages.length) {
    return [];
  }

  if (referenceImages.length <= MAX_STORYBOARD_REFERENCE_IMAGES_PER_RUN) {
    return [referenceImages];
  }

  const passes = [referenceImages.slice(0, MAX_STORYBOARD_REFERENCE_IMAGES_PER_RUN)];

  for (
    let index = MAX_STORYBOARD_REFERENCE_IMAGES_PER_RUN;
    index < referenceImages.length;
    index += MAX_STORYBOARD_REFERENCE_IMAGES_PER_CHAIN_RUN
  ) {
    passes.push(referenceImages.slice(index, index + MAX_STORYBOARD_REFERENCE_IMAGES_PER_CHAIN_RUN));
  }

  return passes;
}

function buildEditImageSlotVariables(referenceImages: string[]): Record<string, TemplateVariable> {
  const editImage1 = referenceImages[0] ?? '';
  const editImage2 = referenceImages[1] ?? editImage1;
  const editImage3 = referenceImages[2] ?? editImage2;

  return {
    input_image: editImage1,
    reference_image: editImage1,
    edit_image_1: editImage1,
    edit_image_2: editImage2,
    edit_image_3: editImage3
  };
}

function buildStoryboardReferencePassVariables(
  baseReferenceVariables: Record<string, TemplateVariable>,
  effectiveInputImages: string[],
  sourceReferenceImages: string[],
  passIndex: number,
  passCount: number,
  totalReferenceImageCount: number
): Record<string, TemplateVariable> {
  return {
    ...baseReferenceVariables,
    ...buildEditImageSlotVariables(effectiveInputImages),
    reference_batch_index: passIndex + 1,
    reference_batch_total: passCount,
    reference_batch_size: sourceReferenceImages.length,
    reference_batch_images: sourceReferenceImages,
    reference_total_image_count: totalReferenceImageCount
  };
}

async function runStoryboardImageWorkflowForShot(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  workflowPath: string,
  generationReferenceInputs: GenerationReferenceInputs,
  frameKind: ReferenceFrameKind
): Promise<{ buffer: Buffer; extension: string; passCount: number }> {
  const signal = getProjectAbortSignal(project.id);
  const referencePasses = buildStoryboardReferencePasses(generationReferenceInputs.referenceImages);

  if (!referencePasses.length) {
    throw new Error('参考帧生成工作流至少需要一张参考图。');
  }

  let latestBuffer: Buffer | null = null;
  let latestExtension = '.png';
  let previousPassImage = '';

  for (let passIndex = 0; passIndex < referencePasses.length; passIndex += 1) {
    const sourceReferenceImages = referencePasses[passIndex];
    const effectiveInputImages =
      passIndex === 0 ? sourceReferenceImages : [previousPassImage, ...sourceReferenceImages].filter(Boolean);

    appendLog(
      project,
      `参考帧生成 ${shot.title}${frameKind === 'start' ? '起始' : '结束'}参考图批次 ${passIndex + 1}/${referencePasses.length}：注入 ${sourceReferenceImages.length} 张参考图。`
    );
    await saveProject(project);

    const outputFiles = await runProjectComfyWorkflow(
      project,
      workflowPath,
      buildComfyVariables(project, shot, appSettings, 'storyboard_image', {
        frameKind,
        workflowPath,
        outputPrefix: `${project.id}_${shot.id}_${frameKind}_storyboard_image_pass_${passIndex + 1}`,
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: buildStoryboardReferencePassVariables(
          generationReferenceInputs.referenceVariables,
          effectiveInputImages,
          sourceReferenceImages,
          passIndex,
          referencePasses.length,
          generationReferenceInputs.referenceImageCount
        )
      }),
      {
        signal,
        label: `storyboard_${shot.id}_${frameKind}_pass_${passIndex + 1}`,
        outputKind: 'image'
      }
    );

    const outputFile = pickOutputFile(outputFiles, 'image');
    latestBuffer = await fetchComfyOutputFile(outputFile, { signal });
    latestExtension = path.extname(outputFile.filename) || '.png';

    if (passIndex < referencePasses.length - 1) {
      previousPassImage = await uploadImageBufferToComfy(
        latestBuffer,
        `${project.id}_${shot.id}_storyboard_image_pass_${passIndex + 1}${latestExtension}`,
        { signal }
      );
    }
  }

  if (!latestBuffer) {
    throw new Error('参考帧生成工作流未返回任何图片输出。');
  }

  return {
    buffer: latestBuffer,
    extension: latestExtension,
    passCount: referencePasses.length
  };
}

function getMaxVideoSegmentDurationSeconds(project: Project): number {
  return Math.max(
    1,
    getAppSettings().comfyui.maxVideoSegmentDurationSeconds || project.settings.maxVideoSegmentDurationSeconds
  );
}

function getVideoSegmentDurations(project: Project, durationSeconds: number): number[] {
  return splitDurationIntoSegments(durationSeconds, getMaxVideoSegmentDurationSeconds(project));
}

function splitDurationIntoSegments(totalDurationSeconds: number, maxSegmentDurationSeconds: number): number[] {
  if (totalDurationSeconds <= maxSegmentDurationSeconds) {
    return [totalDurationSeconds];
  }

  const segmentCount = Math.ceil(totalDurationSeconds / maxSegmentDurationSeconds);
  const baseDuration = Math.floor(totalDurationSeconds / segmentCount);
  const remainder = totalDurationSeconds % segmentCount;

  return Array.from({ length: segmentCount }, (_value, index) => baseDuration + (index < remainder ? 1 : 0));
}

function getShotVideoSegmentDurations(project: Project, shot: Project['storyboard'][number]): number[] {
  return getVideoSegmentDurations(project, shot.durationSeconds);
}

function requiresVideoStageFfmpeg(project: Project): boolean {
  return project.storyboard.some((shot) => getShotVideoSegmentDurations(project, shot).length > 1);
}

function buildSegmentVideoPrompt(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  segmentIndex: number,
  segmentCount: number,
  segmentDurationSeconds: number,
  useLastFrameReference: boolean
): string {
  const basePrompt = getVideoWorkflowPrompt(project, shot, appSettings, {
    durationSeconds: segmentDurationSeconds
  });
  const lastFramePrompt = sanitizeVideoPromptText(shot.lastFramePrompt);

  if (!useLastFrameReference) {
    return basePrompt;
  }

  if (segmentCount <= 1) {
    return lastFramePrompt
      ? `${basePrompt}\n\n镜头收束要求：镜头结尾必须自然落到以下尾帧状态，不要突然停帧、突然黑场或卡住动作：${lastFramePrompt}`
      : basePrompt;
  }

  if (segmentIndex === segmentCount - 1) {
    return `${basePrompt}\n\n本段是长镜头的收尾段，动作、表演和运镜必须自然减速并收束到以下尾帧描述，不要突然停帧或骤然切换：${lastFramePrompt}`;
  }

  return `${basePrompt}\n\n本段是长镜头的第 ${segmentIndex + 1}/${segmentCount} 段，保持人物、机位、动作、表演与光线连续，让动作自然延续并留出下一段承接空间，暂时不要提前收束到最终尾帧，也不要突然切断当前动作。`;
}

function pickOutputFile(files: ComfyOutputFile[], kind: 'image' | 'video' | 'audio'): ComfyOutputFile {
  const matcher =
    kind === 'image' ? IMAGE_EXTENSIONS : kind === 'video' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;
  const selected = files.find((file) => matcher.has(path.extname(file.filename).toLowerCase()));

  if (!selected) {
    throw new Error(
      `ComfyUI 未返回可用的${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}文件。`
    );
  }

  return selected;
}

function sanitizeComfyDebugLabel(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return sanitized || 'run';
}

function buildComfyDebugBaseName(label: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}_${sanitizeComfyDebugLabel(label)}_${crypto.randomUUID().slice(0, 8)}`;
}

function serializeComfyDebugError(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    };
  }

  return {
    name: 'Error',
    message: String(error),
    stack: null
  };
}

function tryPickOutputFile(files: ComfyOutputFile[], kind: ComfyOutputKind): ComfyOutputFile | null {
  try {
    return pickOutputFile(files, kind);
  } catch {
    return null;
  }
}

async function writeComfyDebugFile(
  projectId: string,
  baseName: string,
  suffix: 'request' | 'result',
  payload: unknown
): Promise<string | null> {
  try {
    const saved = await writeProjectFile(
      projectId,
      path.join(COMFY_DEBUG_DIR, `${baseName}.${suffix}.json`),
      JSON.stringify(payload, null, 2)
    );
    return saved.relativePath;
  } catch (error) {
    console.warn(`Failed to write Comfy debug file for project ${projectId}:`, error);
    return null;
  }
}

async function runProjectComfyWorkflow(
  project: Project,
  workflowPath: string,
  variables: Record<string, TemplateVariable>,
  options: {
    signal?: AbortSignal;
    label: string;
    outputKind?: ComfyOutputKind;
  } = {
    label: 'comfy'
  }
): Promise<ComfyOutputFile[]> {
  const createdAt = now();
  const baseName = buildComfyDebugBaseName(options.label);
  let requestDebugPath: string | null = null;

  try {
    const preparedWorkflow = await prepareComfyWorkflow(workflowPath, variables);
    requestDebugPath = await writeComfyDebugFile(project.id, baseName, 'request', {
      createdAt,
      label: options.label,
      workflowPath,
      outputKind: options.outputKind ?? null,
      resolvedPrompt: typeof variables.prompt === 'string' ? variables.prompt : null,
      variables,
      requestBody: {
        prompt: preparedWorkflow
      }
    });
  } catch (error) {
    await writeComfyDebugFile(project.id, baseName, 'result', {
      createdAt,
      failedAt: now(),
      label: options.label,
      workflowPath,
      outputKind: options.outputKind ?? null,
      error: serializeComfyDebugError(error)
    });
    throw error;
  }

  try {
    const outputFiles = await runComfyWorkflow(workflowPath, variables, {
      signal: options.signal
    });
    const selectedOutputFile = options.outputKind ? tryPickOutputFile(outputFiles, options.outputKind) : null;

    await writeComfyDebugFile(project.id, baseName, 'result', {
      createdAt,
      completedAt: now(),
      label: options.label,
      workflowPath,
      outputKind: options.outputKind ?? null,
      requestDebugPath,
      outputFiles,
      selectedOutputFile
    });

    return outputFiles;
  } catch (error) {
    await writeComfyDebugFile(project.id, baseName, 'result', {
      createdAt,
      failedAt: now(),
      label: options.label,
      workflowPath,
      outputKind: options.outputKind ?? null,
      requestDebugPath,
      error: serializeComfyDebugError(error)
    });
    throw error;
  }
}

function buildAsset(
  relativePath: string,
  prompt: string,
  sceneNumber: number | null,
  shotId: string | null
): GeneratedAsset {
  return {
    relativePath,
    prompt,
    sceneNumber,
    shotId,
    createdAt: now()
  };
}

function buildShotAssetOutputPath(
  stage: ShotAssetStage,
  shotId: string,
  extension: string
): string {
  const folder =
    stage === 'images'
      ? path.join('images', 'start')
      : stage === 'lastImages'
        ? path.join('images', 'end')
        : stage === 'audios'
          ? 'audio'
          : 'videos';
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  return path.join(folder, shotId, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${normalizedExtension}`);
}

function buildReferenceAssetOutputPath(
  kind: ReferenceAssetKind,
  itemId: string,
  extension: string
): string {
  const folderName = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'objects';
  return path.join('references', folderName, itemId, `${Date.now()}${extension}`);
}

function getMissingVideoShotIds(project: Project): string[] {
  return project.storyboard
    .filter((shot) => !project.assets.videos.some((asset) => asset.shotId === shot.id))
    .map((shot) => shot.id);
}

function assertStagePreconditions(project: Project, stage: StageId): void {
  if (stage === 'script') {
    if (!project.sourceText.trim()) {
      throw new Error('项目缺少原始文字内容，无法生成剧本。');
    }

    return;
  }

  if (stage === 'assets') {
    if (!project.script) {
      throw new Error('请先生成剧本，再执行资产生成。');
    }

    return;
  }

  if (stage === 'storyboard') {
    if (!project.script) {
      throw new Error('请先生成剧本，再生成分镜。');
    }

    return;
  }

  const appSettings = getAppSettings();
  const useTtsWorkflow = shouldUseTtsWorkflow(project, appSettings);

  if (stage === 'shots') {
    if (!project.storyboard.length) {
      throw new Error('请先生成分镜，再生成镜头。');
    }

    if (!hasConfiguredImageToVideoWorkflow(appSettings)) {
      throw new Error('系统设置中未配置 ComfyUI 视频生成工作流路径，请至少配置首帧视频或首尾帧视频。');
    }

    const requiresReferenceFrameGeneration = project.storyboard.some(
      (shot) => !isLongTakeContinuationShot(project, shot) || shot.useLastFrameReference
    );

    if (
      requiresReferenceFrameGeneration &&
      !appSettings.comfyui.workflows.storyboard_image.workflowPath &&
      !appSettings.comfyui.workflows.image_edit.workflowPath &&
      !appSettings.comfyui.workflows.text_to_image.workflowPath
    ) {
      throw new Error('系统设置中未配置 ComfyUI 参考帧生成工作流或文生图工作流路径。');
    }

    if (!useTtsWorkflow && requiresVideoStageFfmpeg(project) && !appSettings.ffmpeg.binaryPath) {
      throw new Error('存在长镜头分段生成需求，但未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定路径。');
    }

    return;
  }

  if (!project.assets.videos.length) {
    throw new Error('请先生成视频片段，再执行剪辑。');
  }

  const missingShotIds = getMissingVideoShotIds(project);
  if (missingShotIds.length) {
    throw new Error(`仍有 ${missingShotIds.length} 个镜头缺少视频片段：${missingShotIds.join(', ')}`);
  }

  if (!appSettings.ffmpeg.binaryPath) {
    throw new Error('未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定可执行文件路径。');
  }
}

async function runScriptStage(project: Project): Promise<void> {
  if (!project.sourceText.trim()) {
    throw new Error('项目缺少原始文字内容，无法生成剧本。');
  }

  appendLog(project, '开始调用文本模型生成剧本。');
  await saveProject(project);

  const script = await generateScriptFromText(project.sourceText, project.settings, {
    signal: getProjectAbortSignal(project.id)
  });
  project.script = script;

  const markdownFile = await writeProjectFile(project.id, 'script/script.md', script.markdown);
  const jsonFile = await writeProjectFile(project.id, 'script/script.json', JSON.stringify(script, null, 2));

  project.artifacts.scriptMarkdown = markdownFile.relativePath;
  project.artifacts.scriptJson = jsonFile.relativePath;

  appendLog(project, `剧本生成完成，共 ${script.scenes.length} 场戏。`);
}

async function extractReferenceLibraryForProject(project: Project): Promise<void> {
  if (!project.script) {
    throw new Error('请先生成剧本，再提取资产候选。');
  }

  appendLog(project, '开始提取角色、场景和关键物品候选。');
  await saveProject(project);

  project.referenceLibrary = await extractReferenceLibraryFromScript(project.script, project.settings, {
    signal: getProjectAbortSignal(project.id)
  });
  await persistReferenceLibrary(project);

  appendLog(
    project,
    `资产候选提取完成：角色 ${project.referenceLibrary.characters.length} 个，场景 ${project.referenceLibrary.scenes.length} 个，物品 ${project.referenceLibrary.objects.length} 个。`
  );
}

async function generateReferenceAssetForProject(
  project: Project,
  kind: ReferenceAssetKind,
  itemId: string,
  prompt?: string,
  options: {
    useReferenceImage?: boolean;
    ethnicityHint?: string;
  } = {}
): Promise<void> {
  const appSettings = getAppSettings();
  const signal = getProjectAbortSignal(project.id);

  let generationPrompt = '';
  let itemName = '';
  let ethnicityHint = '';
  let genderHint = '';
  let ageHint = '';
  let referenceImageRelativePath = '';
  let temporaryReferenceImage: GeneratedAsset | null = null;

  updateReferenceItem(project, kind, itemId, (item) => {
    generationPrompt = prompt?.trim() || item.generationPrompt;
    itemName = item.name;
    ethnicityHint = kind === 'character' ? (options.ethnicityHint?.trim() ?? item.ethnicityHint.trim()) : item.ethnicityHint;
    genderHint = item.genderHint.trim();
    ageHint = item.ageHint.trim();
    referenceImageRelativePath = item.referenceImage?.relativePath ?? '';
    temporaryReferenceImage = item.referenceImage;

    return {
      ...item,
      ethnicityHint,
      generationPrompt,
      status: 'running',
      error: null,
      updatedAt: now()
    };
  });
  appendLog(project, `开始生成${itemName}${assetKindLabel(kind)}参考图。`);
  await persistReferenceLibrary(project);
  await saveProject(project);

  try {
    const shouldUseReferenceImage = shouldUseUploadedReferenceImage(referenceImageRelativePath, options.useReferenceImage);
    const workflowKind = getReferenceWorkflowKind(kind, shouldUseReferenceImage);
    const workflow = appSettings.comfyui.workflows[workflowKind];

    if (!workflow.workflowPath) {
      throw new Error(`系统设置中未配置 ComfyUI ${assetWorkflowLabel(workflowKind)}工作流路径。`);
    }

    const uploadedReferenceImage = shouldUseReferenceImage
      ? await uploadImageToComfy(fromStorageRelative(referenceImageRelativePath), { signal })
      : '';
    const uploadedCharacterPoseImage =
      kind === 'character' && shouldUseReferenceImage && existsSync(DEFAULT_CHARACTER_POSE_REFERENCE_PATH)
        ? await uploadImageToComfy(DEFAULT_CHARACTER_POSE_REFERENCE_PATH, { signal })
        : '';
    const editImage1 = uploadedReferenceImage;
    const editImage2 = uploadedCharacterPoseImage || uploadedReferenceImage;
    const editImage3 = uploadedCharacterPoseImage || uploadedReferenceImage;
    const workflowPrompt =
      kind === 'character'
        ? buildCharacterAssetWorkflowPrompt(
            itemName,
            generationPrompt,
            ethnicityHint,
            genderHint,
            ageHint
          )
        : generationPrompt;
    const resolvedImageDimensions = resolveWorkflowImageDimensions(
      workflow.workflowPath,
      project.settings.imageWidth,
      project.settings.imageHeight
    );

    const outputFiles = await runProjectComfyWorkflow(
      project,
      workflow.workflowPath,
      {
        prompt: workflowPrompt,
        negative_prompt: project.settings.negativePrompt,
        output_prefix: `${project.id}_${kind}_${itemId}_reference`,
        image_width: resolvedImageDimensions.imageWidth,
        image_height: resolvedImageDimensions.imageHeight,
        video_width: project.settings.videoWidth,
        video_height: project.settings.videoHeight,
        duration_seconds: getDefaultShotDurationSeconds(project.settings),
        fps: project.settings.fps,
        input_image: uploadedReferenceImage,
        reference_image: uploadedReferenceImage,
        reference_images: [uploadedReferenceImage, uploadedCharacterPoseImage].filter(Boolean),
        edit_image_1: editImage1,
        edit_image_2: editImage2,
        edit_image_3: editImage3,
        scene_number: 0,
        shot_number: 0,
        seed: Math.floor(Math.random() * 9_000_000_000)
      },
      {
        signal,
        label: `reference_${kind}_${itemId}_${workflowKind}`,
        outputKind: 'image'
      }
    );

    const outputFile = pickOutputFile(outputFiles, 'image');
    const buffer = await fetchComfyOutputFile(outputFile, { signal });
    const extension = path.extname(outputFile.filename) || '.png';
    const saved = await writeProjectFile(project.id, buildReferenceAssetOutputPath(kind, itemId, extension), buffer);
    const hadGeneratedMedia = hasGeneratedMediaOutputs(project);

    updateReferenceItem(project, kind, itemId, (item) => ({
      ...item,
      ethnicityHint,
      generationPrompt,
      status: 'success',
      error: null,
      updatedAt: now(),
      referenceImage: shouldUseReferenceImage ? null : item.referenceImage,
      asset: buildAsset(saved.relativePath, workflowPrompt, null, null),
      assetHistory: item.asset
        ? [
            item.asset,
            ...item.assetHistory.filter((candidate) => candidate.relativePath !== item.asset?.relativePath)
          ]
        : item.assetHistory
    }));
    if (shouldUseReferenceImage) {
      await deleteStoredAsset(temporaryReferenceImage);
    }
    invalidateGeneratedMediaFromReferenceLibrary(project);
    appendLog(
      project,
      kind === 'character'
        ? shouldUseReferenceImage
          ? hadGeneratedMedia
            ? `${itemName}${assetKindLabel(kind)}已按用户参考图生成完成，临时参考图已清除；图片与视频产物已失效，请重新生成。`
            : `${itemName}${assetKindLabel(kind)}已按用户参考图生成完成，临时参考图已清除。`
          : hadGeneratedMedia
            ? `${itemName}${assetKindLabel(kind)}已按 Prompt 生成完成，图片与视频产物已失效，请重新生成。`
            : `${itemName}${assetKindLabel(kind)}已按 Prompt 生成完成。`
        : shouldUseReferenceImage
          ? hadGeneratedMedia
            ? `${itemName}${assetKindLabel(kind)}已按“参考图 + Prompt”生成并保存到资产库，临时参考图已清除；图片与视频产物已失效，请重新生成。`
            : `${itemName}${assetKindLabel(kind)}已按“参考图 + Prompt”生成并保存到资产库，临时参考图已清除。`
          : hadGeneratedMedia
            ? `${itemName}${assetKindLabel(kind)}参考图生成完成，图片与视频产物已失效，请重新生成。`
            : `${itemName}${assetKindLabel(kind)}参考图生成完成。`,
      hadGeneratedMedia ? 'warn' : 'info'
    );
  } catch (error) {
    if (isStopRequested(project.id)) {
      updateReferenceItem(project, kind, itemId, (item) => ({
        ...item,
        ethnicityHint,
        generationPrompt,
        status: item.asset ? 'success' : 'idle',
        error: null,
        updatedAt: now()
      }));
      await persistReferenceLibrary(project);
      await saveProject(project);
      throw error;
    }

    const message = error instanceof Error ? error.message : '未知错误';

    updateReferenceItem(project, kind, itemId, (item) => ({
      ...item,
      ethnicityHint,
      generationPrompt,
      status: 'error',
      error: message,
      updatedAt: now()
    }));
    appendLog(project, `${itemName}${assetKindLabel(kind)}参考图生成失败：${message}`, 'error');
    await persistReferenceLibrary(project);
    await saveProject(project);
    throw error;
  }

  await persistReferenceLibrary(project);
  await saveProject(project);
}

function guessImageExtension(filename: string, mimeType: string): string {
  const fromName = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(fromName)) {
    return fromName;
  }

  if (mimeType === 'image/png') {
    return '.png';
  }

  if (mimeType === 'image/webp') {
    return '.webp';
  }

  if (mimeType === 'image/gif') {
    return '.gif';
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return '.jpg';
  }

  return '.png';
}

function guessAudioExtension(filename: string, mimeType: string): string {
  const fromName = path.extname(filename).toLowerCase();
  if (AUDIO_EXTENSIONS.has(fromName)) {
    return fromName;
  }

  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav' || mimeType === 'audio/wave') {
    return '.wav';
  }

  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') {
    return '.mp3';
  }

  if (mimeType === 'audio/mp4' || mimeType === 'audio/m4a' || mimeType === 'audio/x-m4a') {
    return '.m4a';
  }

  if (mimeType === 'audio/aac') {
    return '.aac';
  }

  if (mimeType === 'audio/ogg') {
    return '.ogg';
  }

  if (mimeType === 'audio/flac') {
    return '.flac';
  }

  return '.wav';
}

function invalidateAudioDrivenOutputsFromReferenceAudio(project: Project): {
  hadVideoOutputs: boolean;
  hadFinalVideo: boolean;
} {
  const hadVideoOutputs = Boolean(project.assets.videos.length);
  const hadFinalVideo = Boolean(project.assets.finalVideo);
  clearAllShotAssetHistory(project, 'audios');
  archiveAllActiveShotAssets(project, 'videos');
  project.assets.finalVideo = null;
  resetStage(project, 'shots');
  resetStage(project, 'edit');
  return {
    hadVideoOutputs,
    hadFinalVideo
  };
}

export async function uploadReferenceImageForAsset(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string,
  input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }
): Promise<Project> {
  const project = await readProject(projectId);
  const item = getReferenceCollection(project, kind).find((candidate) => candidate.id === itemId);

  if (!item) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  const extension = guessImageExtension(input.filename, input.mimeType);
  const saved = await writeProjectFile(
    project.id,
    path.join('references', 'uploads', kind, `${itemId}${extension}`),
    input.buffer
  );
  const previousReferenceImage = item.referenceImage;

  updateReferenceItem(project, kind, itemId, (current) => ({
    ...current,
    status: current.asset ? 'success' : 'idle',
    updatedAt: now(),
    referenceImage: buildAsset(saved.relativePath, '用户上传参考图', null, null),
    error: null
  }));

  if (previousReferenceImage && previousReferenceImage.relativePath !== saved.relativePath) {
    await deleteStoredAsset(previousReferenceImage);
  }

  appendLog(
    project,
    kind === 'character'
      ? `${item.name}${assetKindLabel(kind)}参考图已上传。下次会按用户上传参考图生成；生成成功后不会保留这张参考图。`
      : `${item.name}${assetKindLabel(kind)}参考图已上传。你可以继续只用 Prompt 生成，也可以在下次生成时使用“参考图 + Prompt”；生成成功后不会保留这张参考图。`
  );
  await persistReferenceLibrary(project);
  await saveProject(project);
  return project;
}

export async function removeReferenceImageForAsset(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string
): Promise<Project> {
  const project = await readProject(projectId);
  const item = getReferenceCollection(project, kind).find((candidate) => candidate.id === itemId);

  if (!item) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  if (!item.referenceImage) {
    return project;
  }

  const previousReferenceImage = item.referenceImage;

  updateReferenceItem(project, kind, itemId, (current) => ({
    ...current,
    status: current.asset ? 'success' : 'idle',
    error: null,
    updatedAt: now(),
    referenceImage: null
  }));
  await deleteStoredAsset(previousReferenceImage);

  appendLog(
    project,
    `${item.name}${assetKindLabel(kind)}上传参考图已移除。`
  );
  await persistReferenceLibrary(project);
  await saveProject(project);
  return project;
}

export async function uploadReferenceAudioForAsset(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string,
  input: {
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }
): Promise<Project> {
  if (kind !== 'character') {
    throw new Error('只有角色资产支持上传参考音频。');
  }

  const project = await readProject(projectId);
  const item = getReferenceCollection(project, kind).find((candidate) => candidate.id === itemId);

  if (!item) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  const extension = guessAudioExtension(input.filename, input.mimeType);
  const saved = await writeProjectFile(
    project.id,
    path.join('references', 'uploads', kind, `${itemId}-voice${extension}`),
    input.buffer
  );
  const previousReferenceAudio = item.referenceAudio;
  const invalidation = invalidateAudioDrivenOutputsFromReferenceAudio(project);

  updateReferenceItem(project, kind, itemId, (current) => ({
    ...current,
    status: current.asset ? 'success' : 'idle',
    updatedAt: now(),
    referenceAudio: buildAsset(saved.relativePath, '用户上传参考音频', null, null),
    error: null
  }));

  if (previousReferenceAudio && previousReferenceAudio.relativePath !== saved.relativePath) {
    await deleteStoredAsset(previousReferenceAudio);
  }

  appendLog(
    project,
    invalidation.hadVideoOutputs || invalidation.hadFinalVideo
      ? `${item.name}${assetKindLabel(kind)}参考音频已上传；后续会先按角色参考音频生成配音，再据此匹配视频时长。原视频片段与成片已失效，请重新生成视频并重新剪辑。`
      : `${item.name}${assetKindLabel(kind)}参考音频已上传；后续会先按角色参考音频生成配音，再据此匹配视频时长。`,
    invalidation.hadVideoOutputs || invalidation.hadFinalVideo ? 'warn' : 'info'
  );
  await persistReferenceLibrary(project);
  await saveProject(project);
  return project;
}

export async function removeReferenceAudioForAsset(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string
): Promise<Project> {
  if (kind !== 'character') {
    throw new Error('只有角色资产支持移除参考音频。');
  }

  const project = await readProject(projectId);
  const item = getReferenceCollection(project, kind).find((candidate) => candidate.id === itemId);

  if (!item) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  if (!item.referenceAudio) {
    return project;
  }

  const previousReferenceAudio = item.referenceAudio;
  const invalidation = invalidateAudioDrivenOutputsFromReferenceAudio(project);

  updateReferenceItem(project, kind, itemId, (current) => ({
    ...current,
    status: current.asset ? 'success' : 'idle',
    error: null,
    updatedAt: now(),
    referenceAudio: null
  }));
  await deleteStoredAsset(previousReferenceAudio);

  appendLog(
    project,
    invalidation.hadVideoOutputs || invalidation.hadFinalVideo
      ? `${item.name}${assetKindLabel(kind)}上传参考音频已移除；后续会回退到无参考音频版 TTS，并按不短于配音的新镜头时长重新生成视频。原视频片段与成片已失效，请重新生成视频并重新剪辑。`
      : `${item.name}${assetKindLabel(kind)}上传参考音频已移除；后续会回退到无参考音频版 TTS，并按不短于配音的新镜头时长重新生成视频。`,
    invalidation.hadVideoOutputs || invalidation.hadFinalVideo ? 'warn' : 'info'
  );
  await persistReferenceLibrary(project);
  await saveProject(project);
  return project;
}

export async function selectLibraryAssetForReferenceItem(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string,
  input: {
    sourceProjectId: string;
    sourceItemId: string;
    sourceKind?: ReferenceAssetKind;
  }
): Promise<Project> {
  const sourceProjectId = input.sourceProjectId.trim();
  const sourceItemId = input.sourceItemId.trim();
  const sourceKind = input.sourceKind ?? kind;

  if (!sourceProjectId || !sourceItemId) {
    throw new Error('素材来源参数不完整。');
  }

  if (sourceKind !== kind) {
    throw new Error('只能为当前类别选择同类素材。');
  }

  const project = await readProject(projectId);
  const sourceProject = sourceProjectId === projectId ? project : await readProject(sourceProjectId);
  const sourceItem = getReferenceCollection(sourceProject, sourceKind).find((candidate) => candidate.id === sourceItemId);
  const currentItem = getReferenceCollection(project, kind).find((candidate) => candidate.id === itemId);

  if (!currentItem) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  if (!sourceItem?.asset) {
    throw new Error('指定素材不存在，或该素材尚未生成可用图片。');
  }

  if (currentItem.asset?.relativePath === sourceItem.asset.relativePath) {
    return project;
  }

  const hadGeneratedMedia = hasGeneratedMediaOutputs(project);
  const selectedAsset = {
    ...sourceItem.asset
  };

  updateReferenceItem(project, kind, itemId, (item) => ({
    ...item,
    status: 'success',
    error: null,
    updatedAt: now(),
    asset: selectedAsset,
    assetHistory: item.asset
      ? [
          item.asset,
          ...item.assetHistory.filter(
            (candidate) =>
              candidate.relativePath !== item.asset?.relativePath &&
              candidate.relativePath !== selectedAsset.relativePath
          )
        ]
      : item.assetHistory.filter((candidate) => candidate.relativePath !== selectedAsset.relativePath)
  }));

  invalidateGeneratedMediaFromReferenceLibrary(project);
  appendLog(
    project,
    hadGeneratedMedia
      ? `${currentItem.name}${assetKindLabel(kind)}已从资产库选用素材“${sourceItem.name}”，图片与视频产物已失效，请重新生成。`
      : `${currentItem.name}${assetKindLabel(kind)}已从资产库选用素材“${sourceItem.name}”。`,
    hadGeneratedMedia ? 'warn' : 'info'
  );
  await persistReferenceLibrary(project);
  await saveProject(project);
  return project;
}

async function runAssetStage(project: Project): Promise<void> {
  await extractReferenceLibraryForProject(project);

  const appSettings = getAppSettings();
  const referenceGroups: Array<[ReferenceAssetKind, ReferenceAssetItem[]]> = [
    ['character', project.referenceLibrary.characters],
    ['scene', project.referenceLibrary.scenes],
    ['object', project.referenceLibrary.objects]
  ];

  if (!referenceGroups.some(([, items]) => items.length)) {
    appendLog(project, '未提取到可生成的参考资产，资产阶段结束。', 'warn');
    return;
  }

  let generatedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const [kind, items] of referenceGroups) {
    if (!items.length) {
      continue;
    }

    for (const item of items) {
      await throwIfRunInterrupted(project.id, 'assets');

      const shouldUseReferenceImage = shouldUseUploadedReferenceImage(item.referenceImage?.relativePath ?? '');
      const workflowKind = getReferenceWorkflowKind(kind, shouldUseReferenceImage);
      const workflow = appSettings.comfyui.workflows[workflowKind];

      if (!workflow.workflowPath) {
        skippedCount += 1;
        appendLog(
          project,
          `未配置 ${assetWorkflowLabel(workflowKind)} 工作流，跳过 ${item.name}${assetKindLabel(kind)}候选。`,
          'warn'
        );
        continue;
      }

      try {
        await generateReferenceAssetForProject(project, kind, item.id);
        generatedCount += 1;
      } catch (error) {
        if (isStopRequested(project.id)) {
          throw error;
        }

        failedCount += 1;
      }
    }
  }

  appendLog(
    project,
    `资产生成阶段完成：成功 ${generatedCount} 个，失败 ${failedCount} 个，跳过 ${skippedCount} 个。`,
    failedCount > 0 || skippedCount > 0 ? 'warn' : 'info'
  );
}

async function runStoryboardStage(project: Project): Promise<void> {
  if (!project.script) {
    throw new Error('请先生成剧本，再生成分镜。');
  }

  appendLog(project, '开始根据剧本拆解分镜。');
  project.storyboard = [];
  let storyboardPlan: StoryboardPlanShot[] | null = null;
  await persistStoryboard(project, storyboardPlan);
  await saveProject(project);

  const storyboard = await generateStoryboardFromScript(project.script, project.settings, {
    signal: getProjectAbortSignal(project.id),
    referenceLibrary: project.referenceLibrary,
    onPlanGenerated: async ({ planShots, totalShots }) => {
      await throwIfRunInterrupted(project.id, 'storyboard');
      storyboardPlan = planShots;
      await persistStoryboard(project, storyboardPlan);
      const shotsByScene = planShots.reduce<Map<number, number>>((map, shot) => {
        map.set(shot.sceneNumber, (map.get(shot.sceneNumber) ?? 0) + 1);
        return map;
      }, new Map());
      appendLog(
        project,
        `分镜规划完成，共 ${totalShots} 个镜头。场景分布：${Array.from(shotsByScene.entries())
          .map(([sceneNumber, count]) => `场景 ${sceneNumber} ${count} 个`)
          .join('；')}`
      );
      await saveProject(project);
    },
    onShotStart: async ({ scene, shotPlan, globalShotIndex, totalShots }) => {
      await throwIfRunInterrupted(project.id, 'storyboard');
      appendLog(project, `分镜生成 ${globalShotIndex}/${totalShots}: 场景 ${scene.sceneNumber} 镜头 ${shotPlan.shotNumber} ${shotPlan.title}`);
      await saveProject(project);
    },
    onShotGenerated: async ({ scene, shot, storyboard: partialStoryboard, completedShots, totalShots }) => {
      project.storyboard = partialStoryboard;
      await persistStoryboard(project, storyboardPlan);
      appendLog(
        project,
        `镜头生成完成：场景 ${scene.sceneNumber} 镜头 ${shot.shotNumber} ${shot.title}，当前已完成 ${completedShots}/${totalShots} 个镜头，累计已保存 ${partialStoryboard.length} 个镜头。`
      );
      await saveProject(project);
    }
  });
  project.storyboard = storyboard;
  await persistStoryboard(project, storyboardPlan);
  appendLog(
    project,
    `分镜生成完成，共 ${storyboard.length} 个镜头，总时长 ${storyboard.at(-1)?.endTimecode ?? '00:00'}。`
  );
}

interface SelectedImageStageWorkflow {
  type: 'storyboard_image' | 'image_edit' | 'text_to_image';
  workflowPath: string;
}

function resolveImageStageWorkflow(
  appSettings: AppSettings,
  generationReferenceInputs: GenerationReferenceInputs
): SelectedImageStageWorkflow {
  const storyboardImageWorkflow = appSettings.comfyui.workflows.storyboard_image;
  const imageEditWorkflow = appSettings.comfyui.workflows.image_edit;
  const textToImageWorkflow = appSettings.comfyui.workflows.text_to_image;

  if (!storyboardImageWorkflow.workflowPath && !imageEditWorkflow.workflowPath && !textToImageWorkflow.workflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 参考帧生成工作流或文生图工作流路径。');
  }

  const hasEditInputs = generationReferenceInputs.referenceImages.length > 0;
  const preferredStoryboardWorkflow = storyboardImageWorkflow.workflowPath
    ? {
        type: 'storyboard_image' as const,
        workflowPath: storyboardImageWorkflow.workflowPath
      }
    : imageEditWorkflow.workflowPath
      ? {
          type: 'image_edit' as const,
          workflowPath: imageEditWorkflow.workflowPath
        }
      : null;
  const selectedWorkflow = hasEditInputs && preferredStoryboardWorkflow
    ? preferredStoryboardWorkflow
    : {
        type: 'text_to_image' as const,
        workflowPath: textToImageWorkflow.workflowPath
      };

  if (!selectedWorkflow.workflowPath) {
    throw new Error('参考帧生成工作流需要至少一张参考图；当前未找到可注入的参考图，且未配置文生图回退工作流。');
  }

  return selectedWorkflow;
}

function appendImageWorkflowLog(
  project: Project,
  selectedWorkflow: SelectedImageStageWorkflow,
  generationReferenceInputs: GenerationReferenceInputs
): void {
  const hasEditInputs = generationReferenceInputs.referenceImages.length > 0;

  appendLog(
    project,
    generationReferenceInputs.referenceCount
      ? `参考帧生成将注入 ${generationReferenceInputs.referenceCount} 个资产库参考项，其中 ${generationReferenceInputs.referenceImageCount} 张参考图会作为工作流输入。`
      : '资产库暂无可用参考项，参考帧生成将仅使用镜头 Prompt。',
    generationReferenceInputs.referenceCount ? 'info' : 'warn'
  );

  if (selectedWorkflow.type === 'storyboard_image') {
    appendLog(project, '参考帧阶段使用 storyboard_image 工作流。');
  } else if (selectedWorkflow.type === 'image_edit') {
    appendLog(project, '未单独配置 storyboard_image，参考帧阶段回退到 legacy image_edit 工作流。', 'warn');
  } else if (hasEditInputs) {
    appendLog(project, '当前没有可用的参考帧生成工作流，参考帧阶段回退到 text_to_image，仅使用 Prompt 与参考上下文。', 'warn');
  } else {
    appendLog(project, '当前没有可注入的参考图，参考帧阶段回退到 text_to_image 工作流。', 'warn');
  }

  if (selectedWorkflow.type === 'text_to_image' && isZimageTextToImageWorkflowPath(selectedWorkflow.workflowPath)) {
    appendLog(project, '当前 text_to_image 使用 zimage 模板；由于模板自带像素放大，输入分辨率会自动按目标值的一半传入。');
  }
}

async function generateReferenceFrameAssetForShot(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  selectedWorkflow: SelectedImageStageWorkflow,
  generationReferenceInputs: GenerationReferenceInputs,
  frameKind: ReferenceFrameKind
): Promise<GeneratedAsset> {
  const signal = getProjectAbortSignal(project.id);
  const generationPrompt = appendReferenceContext(
    buildReferenceFrameWorkflowPrompt(project, shot, selectedWorkflow.type, frameKind),
    generationReferenceInputs.referenceContext
  );
  let buffer: Buffer;
  let extension: string;

  if (selectedWorkflow.type === 'storyboard_image' || selectedWorkflow.type === 'image_edit') {
    const result = await runStoryboardImageWorkflowForShot(
      project,
      shot,
      appSettings,
      selectedWorkflow.workflowPath,
      generationReferenceInputs,
      frameKind
    );
    buffer = result.buffer;
    extension = result.extension;

    if (result.passCount > 1) {
      appendLog(
        project,
        `${shot.title} 的${frameKind === 'start' ? '起始' : '结束'}参考帧已按 ${result.passCount} 轮参考图批次生成完成。`
      );
      await saveProject(project);
    }
  } else {
    const outputFiles = await runProjectComfyWorkflow(
      project,
      selectedWorkflow.workflowPath,
      buildComfyVariables(project, shot, appSettings, selectedWorkflow.type, {
        frameKind,
        workflowPath: selectedWorkflow.workflowPath,
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: generationReferenceInputs.referenceVariables
      }),
      {
        signal,
        label: `reference_frame_${shot.id}_${frameKind}_${selectedWorkflow.type}`,
        outputKind: 'image'
      }
    );

    const outputFile = pickOutputFile(outputFiles, 'image');
    buffer = await fetchComfyOutputFile(outputFile, { signal });
    extension = path.extname(outputFile.filename) || '.png';
  }

  const saved = await writeProjectFile(
    project.id,
    buildShotAssetOutputPath(frameKind === 'start' ? 'images' : 'lastImages', shot.id, extension),
    buffer
  );
  return buildAsset(saved.relativePath, generationPrompt, shot.sceneNumber, shot.id);
}

async function generateVideoAssetForShot(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  generationReferenceInputs: GenerationReferenceInputs,
  ttsUploadCache: Map<string, string>
): Promise<GeneratedAsset> {
  const signal = getProjectAbortSignal(project.id);
  const imageAsset = getActiveShotAsset(project, 'images', shot.id);
  const lastImageAsset = shot.useLastFrameReference ? getActiveShotAsset(project, 'lastImages', shot.id) : null;

  if (!imageAsset) {
    throw new Error(`镜头 ${shot.id} 缺少起始参考帧，无法生成视频。`);
  }

  if (shot.useLastFrameReference && !lastImageAsset) {
    throw new Error(`镜头 ${shot.id} 需要结束参考帧，但当前未生成结束参考帧图片。`);
  }

  const workflowPath = resolveVideoWorkflowPath(appSettings, Boolean(lastImageAsset));

  if (!workflowPath) {
    throw new Error('系统设置中未配置当前镜头可用的视频工作流路径，请检查首帧视频和首尾帧视频设定。');
  }

  const preparedTtsAudio = await ensureShotTtsAudio(project, shot, appSettings, ttsUploadCache);
  const resolvedDuration = resolveVideoGenerationDuration(project, shot, preparedTtsAudio.durationSeconds);
  const effectiveDurationSeconds = resolvedDuration.durationSeconds;
  const segmentDurations = getVideoSegmentDurations(project, effectiveDurationSeconds);
  const segmentCount = segmentDurations.length;
  const shotSeed = Math.floor(Math.random() * 9_000_000_000);

  if (segmentCount > 1 && !appSettings.ffmpeg.binaryPath) {
    throw new Error('当前镜头按“原镜头时长与语音时长中的较大值”计算后需要长镜头分段生成，但未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定路径。');
  }

  if (preparedTtsAudio.asset) {
    const ttsModeLabel = preparedTtsAudio.useReferenceAudio ? '角色参考音频' : '无参考音频默认音色';
    const ttsSourceLabel = preparedTtsAudio.reusedExisting ? '复用已生成配音' : '先生成配音';

    if (preparedTtsAudio.durationSeconds !== null) {
      appendLog(
        project,
        resolvedDuration.requiresSegmentStitching
          ? `镜头 ${shot.title} 已${ttsSourceLabel}（${ttsModeLabel}），语音时长约 ${preparedTtsAudio.durationSeconds.toFixed(2)} 秒；由于系统设置规定单段视频最长 ${resolvedDuration.maxSegmentDurationSeconds} 秒，本次会按总时长 ${effectiveDurationSeconds} 秒拆成 ${segmentCount} 段生成并自动拼接，避免在成片里靠尾帧静止补时长。`
          : `镜头 ${shot.title} 已${ttsSourceLabel}（${ttsModeLabel}），语音时长约 ${preparedTtsAudio.durationSeconds.toFixed(2)} 秒；本次视频将按原分镜时长与语音时长中的较大值生成，当前为 ${effectiveDurationSeconds} 秒。`
      );
    } else {
      appendLog(
        project,
        `镜头 ${shot.title} 已${ttsSourceLabel}（${ttsModeLabel}），但当前无法读取语音时长；本次视频先沿用分镜设定的 ${shot.durationSeconds} 秒。`,
        'warn'
      );
    }
    await saveProject(project);
  } else if (resolvedDuration.requiresSegmentStitching) {
    appendLog(
      project,
      `镜头 ${shot.title} 的目标时长 ${resolvedDuration.requestedDurationSeconds} 秒超过单段上限 ${resolvedDuration.maxSegmentDurationSeconds} 秒；本次会按总时长 ${effectiveDurationSeconds} 秒拆成 ${segmentCount} 段生成并自动拼接。`
    );
    await saveProject(project);
  }

  if (segmentCount > 1) {
    appendLog(
      project,
      `镜头 ${shot.title} 为长镜头，将拆成 ${segmentCount} 段生成（总时长 ${effectiveDurationSeconds}s，每段最长 ${getMaxVideoSegmentDurationSeconds(project)}s）${
        lastImageAsset ? '，并在最后一段使用结束参考帧收束画面。' : '。'
      }`
    );
    await saveProject(project);
  }

  let currentInputImagePath = fromStorageRelative(imageAsset.relativePath);
  const segmentVideoPaths: string[] = [];
  let savedVideoRelativePath: string | null = null;
  let targetLastFrameImagePath = lastImageAsset ? fromStorageRelative(lastImageAsset.relativePath) : '';
  let uploadedTargetLastFrameImage = '';

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    await throwIfRunInterrupted(project.id, 'shots');

    const segmentDuration = segmentDurations[segmentIndex];
    const uploadedImage = await uploadImageToComfy(currentInputImagePath, { signal });
    const isFinalSegment = segmentIndex === segmentCount - 1;

    if (isFinalSegment && targetLastFrameImagePath && !uploadedTargetLastFrameImage) {
      uploadedTargetLastFrameImage = await uploadImageToComfy(targetLastFrameImagePath, { signal });
    }

    const outputFiles = await runProjectComfyWorkflow(
      project,
      workflowPath,
      buildComfyVariables(project, shot, appSettings, 'image_to_video', {
        durationSeconds: segmentDuration,
        inputImage: uploadedImage,
        lastFrameImage: isFinalSegment ? uploadedTargetLastFrameImage : '',
        lastFramePrompt: shot.useLastFrameReference ? shot.lastFramePrompt : '',
        outputPrefix:
          segmentCount === 1
            ? `${project.id}_${shot.id}_video`
            : `${project.id}_${shot.id}_video_seg${String(segmentIndex + 1).padStart(3, '0')}`,
        promptOverride: buildSegmentVideoPrompt(
          project,
          shot,
          appSettings,
          segmentIndex,
          segmentCount,
          segmentDuration,
          Boolean(targetLastFrameImagePath)
        ),
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: generationReferenceInputs.referenceVariables,
        seed: shotSeed
      }),
      {
        signal,
        label: `video_${shot.id}_seg_${segmentIndex + 1}_of_${segmentCount}`,
        outputKind: 'video'
      }
    );

    const outputFile = pickOutputFile(outputFiles, 'video');
    const buffer = await fetchComfyOutputFile(outputFile, { signal });
    const extension = path.extname(outputFile.filename) || '.mp4';

    if (segmentCount === 1) {
      const saved = await writeProjectFile(project.id, buildShotAssetOutputPath('videos', shot.id, extension), buffer);
      savedVideoRelativePath = saved.relativePath;
      continue;
    }

    const segmentSaved = await writeProjectFile(
      project.id,
      path.join(
        '.video-stage',
        shot.id,
        'segments',
        `segment-${String(segmentIndex + 1).padStart(3, '0')}${extension}`
      ),
      buffer
    );
    segmentVideoPaths.push(segmentSaved.absolutePath);

    if (segmentIndex < segmentCount - 1) {
      const continuationFramePath = resolveProjectPath(
        project.id,
        '.video-stage',
        shot.id,
        'frames',
        `segment-${String(segmentIndex + 1).padStart(3, '0')}-last.png`
      );
      await extractLastFrame(segmentSaved.absolutePath, continuationFramePath, { signal });
      currentInputImagePath = continuationFramePath;

      appendLog(
        project,
        `镜头 ${shot.title} 已完成第 ${segmentIndex + 1}/${segmentCount} 段，下一段将复用上一段尾帧作为首帧。`
      );
      await saveProject(project);
    }
  }

  if (!savedVideoRelativePath) {
    const outputRelativePath = buildShotAssetOutputPath('videos', shot.id, '.mp4');
    const outputPath = resolveProjectPath(project.id, outputRelativePath);
    appendLog(project, `镜头 ${shot.title} 分段生成完成，开始拼接 ${segmentCount} 段视频。`);
    await saveProject(project);
    await stitchVideos(segmentVideoPaths, outputPath, project.settings.fps, [], { signal });
    savedVideoRelativePath = toStorageRelative(outputPath);
  }

  return buildAsset(
    savedVideoRelativePath,
    getVideoWorkflowPrompt(project, shot, appSettings, {
      durationSeconds: effectiveDurationSeconds
    }),
    shot.sceneNumber,
    shot.id
  );
}

async function generateStartFrameFromPreviousShotVideo(
  project: Project,
  shot: Project['storyboard'][number]
): Promise<GeneratedAsset> {
  const previousShot = getPreviousStoryboardShot(project, shot);
  const previousVideoAsset = previousShot ? getActiveShotAsset(project, 'videos', previousShot.id) : null;

  if (!previousShot || !previousVideoAsset) {
    throw new Error(`镜头 ${shot.title} 标记为长镜头续接，但前一个镜头还没有可用视频片段。`);
  }

  const signal = getProjectAbortSignal(project.id);
  const temporaryFramePath = resolveProjectPath(project.id, '.video-stage', shot.id, 'reused-start-frame.png');
  await rm(temporaryFramePath, { force: true });
  await rm(path.dirname(temporaryFramePath), { recursive: true, force: true });
  await mkdir(path.dirname(temporaryFramePath), { recursive: true });
  await extractLastFrame(fromStorageRelative(previousVideoAsset.relativePath), temporaryFramePath, { signal });
  const buffer = await readFile(temporaryFramePath);
  const saved = await writeProjectFile(project.id, buildShotAssetOutputPath('images', shot.id, '.png'), buffer);

  return buildAsset(
    saved.relativePath,
    `复用上一镜头 ${previousShot.title} 的视频尾帧作为当前镜头起始参考帧。`,
    shot.sceneNumber,
    shot.id
  );
}

async function generateShotMedia(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  referenceUploadCache: Map<string, string>,
  ttsReferenceAudioUploadCache: Map<string, string>
): Promise<void> {
  const generationReferenceInputs = await buildGenerationReferenceInputs(project, referenceUploadCache, shot);
  const isLongTakeContinuation = isLongTakeContinuationShot(project, shot);
  let selectedWorkflow: SelectedImageStageWorkflow | null = null;

  if (isLongTakeContinuation) {
    const previousShot = getPreviousStoryboardShot(project, shot);
    appendLog(
      project,
      `镜头 ${shot.title} 与上一镜头共享长镜头标识 ${shot.longTakeIdentifier}，起始参考帧将直接复用 ${previousShot?.title ?? '上一镜头'} 视频尾帧。`
    );
    await saveProject(project);
    const startFrameAsset = await generateStartFrameFromPreviousShotVideo(project, shot);
    setActiveShotAsset(project, 'images', shot.id, startFrameAsset);
  } else {
    selectedWorkflow = resolveImageStageWorkflow(appSettings, generationReferenceInputs);
    appendImageWorkflowLog(project, selectedWorkflow, generationReferenceInputs);
    await saveProject(project);
    const startFrameAsset = await generateReferenceFrameAssetForShot(
      project,
      shot,
      appSettings,
      selectedWorkflow,
      generationReferenceInputs,
      'start'
    );
    setActiveShotAsset(project, 'images', shot.id, startFrameAsset);
  }

  if (shot.useLastFrameReference) {
    if (!selectedWorkflow) {
      selectedWorkflow = resolveImageStageWorkflow(appSettings, generationReferenceInputs);
      appendImageWorkflowLog(project, selectedWorkflow, generationReferenceInputs);
    }

    appendLog(project, `镜头 ${shot.title} 需要结束参考帧，开始补生成结束参考帧。`);
    await saveProject(project);
    const endFrameAsset = await generateReferenceFrameAssetForShot(
      project,
      shot,
      appSettings,
      selectedWorkflow,
      generationReferenceInputs,
      'end'
    );
    setActiveShotAsset(project, 'lastImages', shot.id, endFrameAsset);
  } else {
    clearActiveShotAsset(project, 'lastImages', shot.id);
  }

  appendLog(
    project,
    generationReferenceInputs.referenceCount
      ? `视频生成将注入 ${generationReferenceInputs.referenceCount} 个匹配当前镜头的资产库参考项，其中 ${generationReferenceInputs.referenceImageCount} 张参考图会作为工作流输入。`
      : `当前镜头没有匹配到可用参考项，视频生成将仅使用镜头 Prompt 和${shot.useLastFrameReference ? '参考帧' : isLongTakeContinuation ? '上一镜头尾帧' : '起始参考帧'}。`,
    generationReferenceInputs.referenceCount ? 'info' : 'warn'
  );
  await saveProject(project);
  const videoAsset = await generateVideoAssetForShot(
    project,
    shot,
    appSettings,
    generationReferenceInputs,
    ttsReferenceAudioUploadCache
  );
  setActiveShotAsset(project, 'videos', shot.id, videoAsset);
}

async function runShotsStage(project: Project): Promise<void> {
  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成镜头。');
  }

  const appSettings = getAppSettings();
  const useTtsWorkflow = shouldUseTtsWorkflow(project, appSettings);
  if (!hasConfiguredImageToVideoWorkflow(appSettings)) {
    throw new Error('系统设置中未配置 ComfyUI 视频生成工作流路径，请至少配置首帧视频或首尾帧视频。');
  }

  if (!project.settings.useTtsWorkflow) {
    appendLog(project, '当前项目已关闭 TTS；台词/旁白将并入视频工作流 Prompt，视频直接生成包含台词的片段。');
  } else if (!hasConfiguredTtsWorkflow(appSettings)) {
    appendLog(project, '未配置独立 TTS 工作流，背景声音和台词 Prompt 将合并到视频工作流 Prompt。');
  }

  if (!useTtsWorkflow && requiresVideoStageFfmpeg(project) && !appSettings.ffmpeg.binaryPath) {
    throw new Error('存在长镜头分段生成需求，但未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定路径。');
  }

  const referenceUploadCache = new Map<string, string>();
  const ttsReferenceAudioUploadCache = new Map<string, string>();

  for (let index = 0; index < project.storyboard.length; index += 1) {
    await throwIfRunInterrupted(project.id, 'shots');

    const shot = project.storyboard[index];
    appendLog(project, `镜头生成 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
    await saveProject(project);
    await generateShotMedia(project, shot, appSettings, referenceUploadCache, ttsReferenceAudioUploadCache);
    await saveProject(project);
  }

  appendLog(project, '全部镜头参考帧与视频片段生成完成。');
}

async function runEditStage(project: Project): Promise<void> {
  if (!project.assets.videos.length) {
    throw new Error('请先生成视频片段，再执行剪辑。');
  }

  const missingShotIds = getMissingVideoShotIds(project);
  if (missingShotIds.length) {
    throw new Error(`仍有 ${missingShotIds.length} 个镜头缺少视频片段：${missingShotIds.join(', ')}`);
  }

  const orderedVideoAssets = project.storyboard.map((shot) => {
    const asset = project.assets.videos.find((item) => item.shotId === shot.id);

    if (!asset) {
      throw new Error(`镜头 ${shot.id} 缺少视频片段，无法执行剪辑。`);
    }

    return asset;
  });

  appendLog(project, `开始拼接 ${orderedVideoAssets.length} 个视频片段。`);
  await saveProject(project);

  const appSettings = getAppSettings();
  const useTtsWorkflow = shouldUseTtsWorkflow(project, appSettings);
  const signal = getProjectAbortSignal(project.id);
  const orderedAudioPaths: Array<string | null> = [];
  const ttsReferenceAudioUploadCache = new Map<string, string>();

  if (useTtsWorkflow) {
    appendLog(project, '已配置 TTS 工作流，开始为镜头准备配音音频。');
    await saveProject(project);

    for (let index = 0; index < project.storyboard.length; index += 1) {
      await throwIfRunInterrupted(project.id, 'edit');

      const shot = project.storyboard[index];
      const preparedTtsAudio = await ensureShotTtsAudio(project, shot, appSettings, ttsReferenceAudioUploadCache);

      if (!preparedTtsAudio.asset || !preparedTtsAudio.absolutePath) {
        orderedAudioPaths.push(null);
        continue;
      }

      appendLog(
        project,
        `TTS 配音 ${index + 1}/${project.storyboard.length}: ${shot.title}（${
          preparedTtsAudio.reusedExisting ? '复用预生成配音' : '本阶段补生成配音'
        }，${preparedTtsAudio.useReferenceAudio ? '角色参考音频' : '无参考音频默认音色'}）`
      );
      await saveProject(project);
      orderedAudioPaths.push(preparedTtsAudio.absolutePath);

      try {
        const resolvedAudioDurationSeconds =
          preparedTtsAudio.durationSeconds ?? (await getMediaDurationSeconds(preparedTtsAudio.absolutePath, { signal }));
        const [audioDurationSeconds, videoDurationSeconds] = await Promise.all([
          Promise.resolve(resolvedAudioDurationSeconds),
          getMediaDurationSeconds(fromStorageRelative(orderedVideoAssets[index].relativePath), { signal })
        ]);
        const durationDelta = audioDurationSeconds - videoDurationSeconds;

        if (durationDelta > 0.05) {
          appendLog(
            project,
            `镜头 ${shot.title} 的对白时长约 ${audioDurationSeconds.toFixed(2)} 秒，超过视频片段 ${videoDurationSeconds.toFixed(2)} 秒；最终剪辑会自动延长尾帧 ${durationDelta.toFixed(2)} 秒以容纳完整对白。`
          );
          await saveProject(project);
        }
      } catch (error) {
        appendLog(
          project,
          `镜头 ${shot.title} 的音视频时长预检失败，剪辑阶段将继续尝试自动对齐：${error instanceof Error ? error.message : String(error)}`,
          'warn'
        );
        await saveProject(project);
      }
    }

    appendLog(project, '镜头配音音频已准备完成，开始合成成片。');
    await saveProject(project);
  } else if (!project.settings.useTtsWorkflow) {
    appendLog(project, '当前项目已关闭 TTS，最终成片将直接使用视频片段自身的声音轨。');
    await saveProject(project);
  }

  await throwIfRunInterrupted(project.id, 'edit');

  const outputPath = resolveProjectPath(project.id, 'output', 'final.mp4');
  await stitchVideos(
    orderedVideoAssets.map((asset) => fromStorageRelative(asset.relativePath)),
    outputPath,
    project.settings.fps,
    orderedAudioPaths,
    {
      signal
    }
  );

  project.assets.finalVideo = buildAsset(
    path.join('projects', project.id, 'output', 'final.mp4').split(path.sep).join('/'),
    '最终成片',
    null,
    null
  );

  appendLog(project, '视频剪辑完成，已导出完整成片。');
}

async function executeStage(projectId: string, stage: StageId): Promise<void> {
  const project = await readProject(projectId);
  assertStagePreconditions(project, stage);
  resetDownstreamArtifacts(project, stage);
  setStageStatus(project, stage, 'running');
  appendLog(project, `${STAGE_LABELS[stage]} 开始执行。`);
  await saveProject(project);

  try {
    await throwIfRunInterrupted(projectId, stage);

    if (stage === 'script') {
      await runScriptStage(project);
    } else if (stage === 'assets') {
      await runAssetStage(project);
    } else if (stage === 'storyboard') {
      await runStoryboardStage(project);
    } else if (stage === 'shots') {
      await runShotsStage(project);
    } else {
      await runEditStage(project);
    }

    setStageStatus(project, stage, 'success');
    appendLog(project, `${STAGE_LABELS[stage]} 执行成功。`);
    await saveProject(project);
  } catch (error) {
    if (isStopRequested(projectId)) {
      setStageStatus(project, stage, 'idle');
      appendLog(project, `${STAGE_LABELS[stage]} 已停止。`, 'warn');
      await saveProject(project);
      throw new PipelineStopError(stage);
    }

    if (error instanceof PipelinePauseError) {
      setStageStatus(project, stage, 'idle');
      appendLog(project, `${STAGE_LABELS[stage]} 已暂停，等待继续执行。`, 'warn');
      await saveProject(project);
      throw error;
    }

    const message = error instanceof Error ? error.message : '未知错误';
    setStageStatus(project, stage, 'error', message);
    appendLog(project, `${STAGE_LABELS[stage]} 执行失败: ${message}`, 'error');
    await saveProject(project);
    throw error;
  }
}

async function executeReferenceGeneration(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string,
  prompt?: string,
  options: {
    useReferenceImage?: boolean;
    ethnicityHint?: string;
  } = {}
): Promise<void> {
  const project = await readProject(projectId);
  await generateReferenceAssetForProject(project, kind, itemId, prompt, options);
}

async function setRunState(projectId: string, requestedStage: RunStage | null, currentStage: StageId | null): Promise<void> {
  const project = await readProject(projectId);
  await persistProjectRunState(projectId, {
    isRunning: Boolean(requestedStage),
    requestedStage,
    currentStage,
    startedAt: requestedStage ? project.runState.startedAt ?? now() : null,
    pauseRequested: false,
    stopRequested: false,
    isPaused: false
  });
}

async function clearRunState(projectId: string): Promise<void> {
  pauseRequestedProjects.delete(projectId);
  stopRequestedProjects.delete(projectId);
  clearProjectAbortController(projectId);
  await persistProjectRunState(projectId, createIdleRunState());
  cachedRunStates.delete(projectId);
}

async function runSingle(projectId: string, stage: StageId): Promise<void> {
  pauseRequestedProjects.delete(projectId);
  stopRequestedProjects.delete(projectId);
  ensureProjectAbortController(projectId);
  await setRunState(projectId, stage, stage);
  try {
    await executeStage(projectId, stage);
  } catch (error) {
    if (error instanceof PipelineStopError) {
      return;
    }

    throw error;
  } finally {
    await clearRunState(projectId);
  }
}

async function pauseProjectRun(projectId: string, currentStage: StageId): Promise<void> {
  pauseRequestedProjects.delete(projectId);
  const project = await readProject(projectId);
  project.runState = {
    isRunning: false,
    requestedStage: 'all',
    currentStage,
    startedAt: project.runState.startedAt ?? now(),
    pauseRequested: false,
    stopRequested: false,
    isPaused: true
  };
  cachedRunStates.set(projectId, { ...project.runState });
  appendLog(project, '全流程已暂停，可稍后继续执行。', 'warn');
  await saveProject(project);
}

function getRemainingStages(project: Project): StageId[] {
  return STAGES.filter((stage) => project.stages[stage].status !== 'success');
}

async function runStageSequence(projectId: string, stages: StageId[]): Promise<void> {
  pauseRequestedProjects.delete(projectId);
  stopRequestedProjects.delete(projectId);
  ensureProjectAbortController(projectId);
  await setRunState(projectId, 'all', null);

  let paused = false;

  try {
    for (const stage of stages) {
      await setRunState(projectId, 'all', stage);

      try {
        await executeStage(projectId, stage);
      } catch (error) {
        if (error instanceof PipelinePauseError) {
          paused = true;
          await pauseProjectRun(projectId, stage);
          return;
        }

        if (error instanceof PipelineStopError) {
          return;
        }

        throw error;
      }

      if (isStopRequested(projectId)) {
        return;
      }

      if (isPauseRequested(projectId)) {
        paused = true;
        await pauseProjectRun(projectId, stage);
        return;
      }
    }
  } finally {
    if (!paused) {
      await clearRunState(projectId);
    }
  }
}

async function runAll(projectId: string): Promise<void> {
  await runStageSequence(projectId, [...STAGES]);
}

async function resumeAll(projectId: string): Promise<void> {
  const project = await readProject(projectId);
  const remainingStages = getRemainingStages(project);

  if (!remainingStages.length) {
    throw new Error('当前项目没有可继续执行的阶段。');
  }

  await runStageSequence(projectId, remainingStages);
}

export function isProjectRunning(projectId: string): boolean {
  return runningProjects.has(projectId);
}

export function isReferenceGenerationRunning(projectId: string): boolean {
  return runningReferenceGenerations.has(projectId);
}

export async function enqueueProjectRun(projectId: string, stage: RunStage): Promise<void> {
  if (runningProjects.has(projectId)) {
    throw new Error('当前项目已有任务在运行。');
  }

  const runner = (stage === 'all' ? runAll(projectId) : runSingle(projectId, stage))
    .catch((error) => {
      console.error(`Pipeline execution failed for ${projectId}:`, error);
    })
    .finally(() => {
      runningProjects.delete(projectId);
    });

  runningProjects.set(projectId, runner);
  await Promise.resolve();
}

export async function requestProjectRunPause(projectId: string): Promise<void> {
  if (!runningProjects.has(projectId)) {
    throw new Error('当前项目没有正在执行的全流程任务。');
  }

  const project = await readProject(projectId);

  if (!project.runState.isRunning || project.runState.requestedStage !== 'all') {
    throw new Error('只有执行全流程时才能暂停。');
  }

  if (project.runState.pauseRequested) {
    return;
  }

  pauseRequestedProjects.add(projectId);
  project.runState = {
    ...project.runState,
    pauseRequested: true,
    stopRequested: false,
    isPaused: false
  };
  cachedRunStates.set(projectId, { ...project.runState });
  appendLog(project, '已请求暂停；系统会在当前阶段安全结束后暂停全流程。', 'warn');
  await saveProject(project);
}

export async function requestProjectRunStop(projectId: string): Promise<void> {
  if (!runningProjects.has(projectId)) {
    throw new Error('当前项目没有正在执行的任务。');
  }

  const project = await readProject(projectId);

  if (project.runState.stopRequested) {
    return;
  }

  stopRequestedProjects.add(projectId);
  projectAbortControllers.get(projectId)?.abort();
  project.runState = {
    ...project.runState,
    pauseRequested: false,
    stopRequested: true,
    isPaused: false
  };
  cachedRunStates.set(projectId, { ...project.runState });
  appendLog(project, '已请求停止；系统正在中断当前任务。', 'warn');
  await saveProject(project);
}

export async function resumeProjectRun(projectId: string): Promise<void> {
  if (runningProjects.has(projectId)) {
    throw new Error('当前项目已有任务在运行。');
  }

  const project = await readProject(projectId);

  if (!project.runState.isPaused || project.runState.requestedStage !== 'all') {
    throw new Error('当前项目没有可继续的全流程任务。');
  }

  const runner = resumeAll(projectId)
    .catch((error) => {
      console.error(`Pipeline resume failed for ${projectId}:`, error);
    })
    .finally(() => {
      runningProjects.delete(projectId);
    });

  runningProjects.set(projectId, runner);
  await Promise.resolve();
}

export async function continueProjectRun(projectId: string): Promise<void> {
  if (runningProjects.has(projectId)) {
    throw new Error('当前项目已有任务在运行。');
  }

  const project = await readProject(projectId);
  const remainingStages = getRemainingStages(project);

  if (!remainingStages.length) {
    throw new Error('当前项目已全部完成，无需继续执行。');
  }

  const runner = runStageSequence(projectId, remainingStages)
    .catch((error) => {
      console.error(`Pipeline continuation failed for ${projectId}:`, error);
    })
    .finally(() => {
      runningProjects.delete(projectId);
    });

  runningProjects.set(projectId, runner);
  await Promise.resolve();
}

async function enqueueStageScopedProjectTask(
  projectId: string,
  stage: StageId,
  task: () => Promise<void>,
  errorLabel: string
): Promise<void> {
  if (runningProjects.has(projectId)) {
    throw new Error('当前项目已有任务在运行。');
  }

  const runner = (async () => {
    await setRunState(projectId, stage, stage);
    try {
      await task();
    } finally {
      await clearRunState(projectId);
    }
  })()
    .catch((error) => {
      console.error(`${errorLabel} failed for ${projectId}:`, error);
    })
    .finally(() => {
      runningProjects.delete(projectId);
    });

  runningProjects.set(projectId, runner);
  await Promise.resolve();
}

export async function enqueueReferenceGeneration(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string,
  prompt?: string,
  options: {
    useReferenceImage?: boolean;
    ethnicityHint?: string;
  } = {}
): Promise<void> {
  if (runningReferenceGenerations.has(projectId)) {
    throw new Error('当前项目已有参考资产任务在运行。');
  }

  const runner = executeReferenceGeneration(projectId, kind, itemId, prompt, options)
    .catch((error) => {
      console.error(`Reference asset generation failed for ${projectId}/${kind}/${itemId}:`, error);
    })
    .finally(() => {
      runningReferenceGenerations.delete(projectId);
    });

  runningReferenceGenerations.set(projectId, runner);
  await Promise.resolve();
}

function invalidateDownstreamLongTakeDependentOutputs(
  project: Project,
  shotId: string
): {
  dependentShotIds: string[];
  hadImageOutput: boolean;
  hadVideoOutput: boolean;
} {
  const dependentShotIds = getDownstreamLongTakeDependentShotIds(project, shotId);
  let hadImageOutput = false;
  let hadVideoOutput = false;

  for (const dependentShotId of dependentShotIds) {
    hadImageOutput = Boolean(getActiveShotAsset(project, 'images', dependentShotId)) || hadImageOutput;
    hadVideoOutput = Boolean(getActiveShotAsset(project, 'videos', dependentShotId)) || hadVideoOutput;
    clearActiveShotAsset(project, 'images', dependentShotId);
    clearActiveShotAsset(project, 'videos', dependentShotId);
  }

  return {
    dependentShotIds,
    hadImageOutput,
    hadVideoOutput
  };
}

async function executeStoryboardShotImageGeneration(projectId: string, shotId: string): Promise<void> {
  const project = await readProject(projectId);
  const shot = project.storyboard.find((item) => item.id === shotId);

  if (!shot) {
    throw new Error(`未找到镜头 ${shotId}`);
  }

  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成镜头。');
  }

  const appSettings = getAppSettings();
  const referenceUploadCache = new Map<string, string>();
  const ttsReferenceAudioUploadCache = new Map<string, string>();
  appendLog(project, `开始为镜头 ${shot.title} 单独执行镜头生成（参考帧 + 视频片段）。`);
  await saveProject(project);

  await generateShotMedia(project, shot, appSettings, referenceUploadCache, ttsReferenceAudioUploadCache);
  const downstreamInvalidation = invalidateDownstreamLongTakeDependentOutputs(project, shot.id);
  project.assets.finalVideo = null;
  resetStage(project, 'shots');
  resetStage(project, 'edit');

  appendLog(
    project,
    downstreamInvalidation.dependentShotIds.length
      ? `镜头 ${shot.title} 已完成重新生成；受长镜头续接影响，后续镜头 ${downstreamInvalidation.dependentShotIds.join(', ')} 的首帧和视频已失效，请按顺序重新生成。`
      : `镜头 ${shot.title} 的参考帧与视频片段已更新，历史版本已保留。`
  );
  await saveProject(project);
}

async function executeStoryboardShotVideoGeneration(projectId: string, shotId: string): Promise<void> {
  const project = await readProject(projectId);
  const shot = project.storyboard.find((item) => item.id === shotId);

  if (!shot) {
    throw new Error(`未找到镜头 ${shotId}`);
  }

  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成视频片段。');
  }

  if (isLongTakeContinuationShot(project, shot) && !getActiveShotAsset(project, 'images', shot.id)) {
    const startFrameAsset = await generateStartFrameFromPreviousShotVideo(project, shot);
    setActiveShotAsset(project, 'images', shot.id, startFrameAsset);
  }

  if (!getActiveShotAsset(project, 'images', shot.id)) {
    throw new Error('请先为当前镜头生成或选择起始参考帧，再生成视频片段。');
  }

  if (shot.useLastFrameReference && !getActiveShotAsset(project, 'lastImages', shot.id)) {
    throw new Error('当前镜头需要结束参考帧；请先重新生成参考帧后再生成视频片段。');
  }

  const appSettings = getAppSettings();
  const useTtsWorkflow = shouldUseTtsWorkflow(project, appSettings);
  if (!hasConfiguredImageToVideoWorkflow(appSettings)) {
    throw new Error('系统设置中未配置 ComfyUI 视频生成工作流路径，请至少配置首帧视频或首尾帧视频。');
  }

  if (!useTtsWorkflow && getShotVideoSegmentDurations(project, shot).length > 1 && !appSettings.ffmpeg.binaryPath) {
    throw new Error('当前镜头需要长镜头分段生成，但未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定路径。');
  }

  if (!project.settings.useTtsWorkflow) {
    appendLog(project, '当前项目已关闭 TTS；台词/旁白将并入视频工作流 Prompt，视频直接生成包含台词的片段。');
  } else if (!hasConfiguredTtsWorkflow(appSettings)) {
    appendLog(project, '未配置独立 TTS 工作流，背景声音和台词 Prompt 将合并到视频工作流 Prompt。');
  }

  const referenceUploadCache = new Map<string, string>();
  const ttsReferenceAudioUploadCache = new Map<string, string>();
  const generationReferenceInputs = await buildGenerationReferenceInputs(project, referenceUploadCache, shot);
  appendLog(project, `开始为镜头 ${shot.title} 单独生成视频片段。`);
  appendLog(
    project,
    generationReferenceInputs.referenceCount
      ? `视频生成将注入 ${generationReferenceInputs.referenceCount} 个匹配当前镜头的资产库参考项，其中 ${generationReferenceInputs.referenceImageCount} 张参考图会作为工作流输入。`
      : `当前镜头没有匹配到可用参考项，视频生成将仅使用镜头 Prompt 和${shot.useLastFrameReference ? '参考帧' : '起始参考帧'}。`,
    generationReferenceInputs.referenceCount ? 'info' : 'warn'
  );
  await saveProject(project);

  const videoAsset = await generateVideoAssetForShot(
    project,
    shot,
    appSettings,
    generationReferenceInputs,
    ttsReferenceAudioUploadCache
  );
  setActiveShotAsset(project, 'videos', shot.id, videoAsset);
  const downstreamInvalidation = invalidateDownstreamLongTakeDependentOutputs(project, shot.id);
  project.assets.finalVideo = null;
  resetStage(project, 'shots');
  resetStage(project, 'edit');
  appendLog(
    project,
    downstreamInvalidation.dependentShotIds.length
      ? `镜头 ${shot.title} 的视频片段已更新；受长镜头续接影响，后续镜头 ${downstreamInvalidation.dependentShotIds.join(', ')} 的首帧和视频已失效，请按顺序重新生成。`
      : `镜头 ${shot.title} 的视频片段已更新，历史版本已保留。`
  );
  await saveProject(project);
}

function findShotAssetVersion(
  project: Project,
  stage: ShotAssetStage,
  shotId: string,
  relativePath: string
): GeneratedAsset | null {
  const active = getActiveShotAsset(project, stage, shotId);

  if (active?.relativePath === relativePath) {
    return active;
  }

  return getShotAssetHistory(project, stage, shotId).find((asset) => asset.relativePath === relativePath) ?? null;
}

async function selectStoryboardShotAssetVersion(
  projectId: string,
  stage: ShotAssetStage,
  shotId: string,
  relativePath: string
): Promise<Project> {
  const project = await readProject(projectId);
  const shot = project.storyboard.find((item) => item.id === shotId);

  if (!shot) {
    throw new Error(`未找到镜头 ${shotId}`);
  }

  const nextAsset = findShotAssetVersion(project, stage, shotId, relativePath.trim());

  if (!nextAsset) {
    throw new Error('指定版本不存在。');
  }

  const currentAsset = getActiveShotAsset(project, stage, shotId);
  if (currentAsset?.relativePath === nextAsset.relativePath) {
    return project;
  }

  setActiveShotAsset(project, stage, shotId, nextAsset);

  if (stage === 'images') {
    clearActiveShotAsset(project, 'videos', shotId);
    const downstreamInvalidation = invalidateDownstreamLongTakeDependentOutputs(project, shotId);
    project.assets.finalVideo = null;
    resetStage(project, 'shots');
    resetStage(project, 'edit');
    appendLog(
      project,
      downstreamInvalidation.dependentShotIds.length
        ? `镜头 ${shot.title} 已切换到指定起始参考帧版本；当前镜头以及后续长镜头续接镜头 ${downstreamInvalidation.dependentShotIds.join(', ')} 的视频已失效，请按顺序重新生成。`
        : `镜头 ${shot.title} 已切换到指定起始参考帧版本；当前视频片段已失效，请重新生成或重新选择视频版本。`
    );
  } else {
    const downstreamInvalidation = invalidateDownstreamLongTakeDependentOutputs(project, shotId);
    project.assets.finalVideo = null;
    resetStage(project, 'shots');
    resetStage(project, 'edit');
    appendLog(
      project,
      downstreamInvalidation.dependentShotIds.length
        ? `镜头 ${shot.title} 已切换到指定视频版本；后续长镜头续接镜头 ${downstreamInvalidation.dependentShotIds.join(', ')} 的首帧和视频已失效，请按顺序重新生成。`
        : `镜头 ${shot.title} 已切换到指定视频版本，请重新执行视频剪辑。`
    );
  }

  await saveProject(project);
  return project;
}

export async function enqueueStoryboardShotImageGeneration(projectId: string, shotId: string): Promise<void> {
  await enqueueStageScopedProjectTask(
    projectId,
    'shots',
    async () => {
      await executeStoryboardShotImageGeneration(projectId, shotId);
    },
    'Shot image generation'
  );
}

export async function enqueueStoryboardShotVideoGeneration(projectId: string, shotId: string): Promise<void> {
  await enqueueStageScopedProjectTask(
    projectId,
    'shots',
    async () => {
      await executeStoryboardShotVideoGeneration(projectId, shotId);
    },
    'Shot video generation'
  );
}

export async function selectStoryboardShotImageVersion(
  projectId: string,
  shotId: string,
  relativePath: string
): Promise<Project> {
  return await selectStoryboardShotAssetVersion(projectId, 'images', shotId, relativePath);
}

export async function selectStoryboardShotVideoVersion(
  projectId: string,
  shotId: string,
  relativePath: string
): Promise<Project> {
  return await selectStoryboardShotAssetVersion(projectId, 'videos', shotId, relativePath);
}

export async function addReferenceAssetToStoryboardShot(
  projectId: string,
  shotId: string,
  kind: ReferenceAssetKind,
  itemId: string
): Promise<Project> {
  const project = await readProject(projectId);
  const shot = getStoryboardShot(project, shotId);
  const item = getReferenceCollection(project, kind).find((candidate) => candidate.id === itemId);

  if (!item) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  if (!item.asset) {
    throw new Error('该参考资产尚未生成可用参考图，暂时不能加入镜头参考图列表。');
  }

  const selectionId = buildShotReferenceSelectionId(kind, itemId);
  const beforeSelections = getGenerationReferenceSelectionIds(project, shot);
  setShotReferenceSelections(shot, {
    manualReferenceAssetIds: [...shot.manualReferenceAssetIds, selectionId],
    excludedReferenceAssetIds: shot.excludedReferenceAssetIds.filter((value) => value !== selectionId)
  });
  const afterSelections = getGenerationReferenceSelectionIds(project, shot);

  if (areReferenceSelectionSetsEqual(beforeSelections, afterSelections)) {
    return project;
  }

  const invalidation = invalidateGeneratedMediaFromStoryboardShotReferenceChange(project, shotId);
  appendLog(
    project,
    invalidation.hadImageOutput || invalidation.hadLastImageOutput || invalidation.hadVideoOutput || invalidation.hadFinalVideo
      ? invalidation.downstreamDependentShotIds.length
        ? `镜头 ${shot.title} 已加入${assetKindLabel(kind)}参考图“${item.name}”；当前镜头及后续长镜头续接镜头 ${invalidation.downstreamDependentShotIds.join(', ')} 的参考帧、视频片段和最终成片已失效，请重新生成。`
        : `镜头 ${shot.title} 已加入${assetKindLabel(kind)}参考图“${item.name}”；相关参考帧、视频片段和最终成片已失效，请重新生成。`
      : `镜头 ${shot.title} 已加入${assetKindLabel(kind)}参考图“${item.name}”；后续参考帧与视频生成会注入这张参考图。`,
    invalidation.hadImageOutput || invalidation.hadLastImageOutput || invalidation.hadVideoOutput || invalidation.hadFinalVideo
      ? 'warn'
      : 'info'
  );
  await persistStoryboard(project);
  await saveProject(project);
  return project;
}

export async function removeReferenceAssetFromStoryboardShot(
  projectId: string,
  shotId: string,
  kind: ReferenceAssetKind,
  itemId: string
): Promise<Project> {
  const project = await readProject(projectId);
  const shot = getStoryboardShot(project, shotId);
  const item = getReferenceCollection(project, kind).find((candidate) => candidate.id === itemId);

  if (!item) {
    throw new Error(`未找到 ${kind} 资产项 ${itemId}`);
  }

  const selectionId = buildShotReferenceSelectionId(kind, itemId);
  const beforeSelections = getGenerationReferenceSelectionIds(project, shot);
  const autoMatchedLibrary = filterReferenceLibraryForShot(project.referenceLibrary, shot, project.script);
  const explicitlySelected = shot.referenceAssetIds.includes(selectionId);
  const autoMatched =
    explicitlySelected ||
    (kind === 'character' ? autoMatchedLibrary.characters : kind === 'scene' ? autoMatchedLibrary.scenes : autoMatchedLibrary.objects)
      .some((candidate) => candidate.id === itemId);

  setShotReferenceSelections(shot, {
    manualReferenceAssetIds: shot.manualReferenceAssetIds.filter((value) => value !== selectionId),
    excludedReferenceAssetIds: autoMatched
      ? [...shot.excludedReferenceAssetIds, selectionId]
      : shot.excludedReferenceAssetIds.filter((value) => value !== selectionId)
  });
  const afterSelections = getGenerationReferenceSelectionIds(project, shot);

  if (areReferenceSelectionSetsEqual(beforeSelections, afterSelections)) {
    return project;
  }

  const invalidation = invalidateGeneratedMediaFromStoryboardShotReferenceChange(project, shotId);
  appendLog(
    project,
    invalidation.hadImageOutput || invalidation.hadLastImageOutput || invalidation.hadVideoOutput || invalidation.hadFinalVideo
      ? invalidation.downstreamDependentShotIds.length
        ? `镜头 ${shot.title} 已移除${assetKindLabel(kind)}参考图“${item.name}”；当前镜头及后续长镜头续接镜头 ${invalidation.downstreamDependentShotIds.join(', ')} 的参考帧、视频片段和最终成片已失效，请重新生成。`
        : `镜头 ${shot.title} 已移除${assetKindLabel(kind)}参考图“${item.name}”；相关参考帧、视频片段和最终成片已失效，请重新生成。`
      : `镜头 ${shot.title} 已移除${assetKindLabel(kind)}参考图“${item.name}”。`,
    invalidation.hadImageOutput || invalidation.hadLastImageOutput || invalidation.hadVideoOutput || invalidation.hadFinalVideo
      ? 'warn'
      : 'info'
  );
  await persistStoryboard(project);
  await saveProject(project);
  return project;
}

export async function updateStoryboardShotPrompts(
  projectId: string,
  shotId: string,
  input: {
    durationSeconds?: number;
    firstFramePrompt?: string;
    lastFramePrompt?: string;
    transitionHint?: string;
    videoPrompt?: string;
    backgroundSoundPrompt?: string;
    speechPrompt?: string;
  }
): Promise<Project> {
  const project = await readProject(projectId);
  const shot = project.storyboard.find((item) => item.id === shotId);
  const ttsConfigured = shouldUseTtsWorkflow(project, getAppSettings());

  if (!shot) {
    throw new Error(`未找到镜头 ${shotId}`);
  }

  const changes: string[] = [];
  let shouldInvalidateStartFrameOutputs = false;
  let shouldInvalidateLastFrameOutputs = false;
  let shouldInvalidateAudioOutputs = false;
  let shouldInvalidateVideoOutputs = false;
  let shouldInvalidateEditOutput = false;
  let shouldRecalculateStoryboardTimeline = false;

  if (input.durationSeconds !== undefined) {
    const parsedDuration = Number(input.durationSeconds);

    if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) {
      throw new Error('镜头时长必须为正整数秒。');
    }

    const nextDuration = Math.round(parsedDuration);

    if (shot.durationSeconds !== nextDuration) {
      shot.durationSeconds = nextDuration;
      changes.push('镜头时长');
      shouldInvalidateVideoOutputs = true;
      shouldRecalculateStoryboardTimeline = true;
    }
  }

  if (input.firstFramePrompt !== undefined) {
    const nextPrompt = input.firstFramePrompt.trim();
    if (!nextPrompt) {
      throw new Error('起始参考帧 Prompt 不能为空。');
    }

    if (shot.firstFramePrompt !== nextPrompt) {
      shot.firstFramePrompt = nextPrompt;
      changes.push('起始参考帧 Prompt');
      shouldInvalidateStartFrameOutputs = true;
      shouldInvalidateVideoOutputs = true;
    }
  }

  if (input.lastFramePrompt !== undefined) {
    const nextPrompt = input.lastFramePrompt.trim();
    if (shot.useLastFrameReference && !nextPrompt) {
      throw new Error('结束参考帧 Prompt 不能为空。');
    }

    if (shot.useLastFrameReference && shot.lastFramePrompt !== nextPrompt) {
      shot.lastFramePrompt = nextPrompt;
      changes.push('结束参考帧 Prompt');
      shouldInvalidateLastFrameOutputs = true;
      shouldInvalidateVideoOutputs = true;
    }
  }

  if (input.transitionHint !== undefined) {
    const nextHint = input.transitionHint.trim();
    if (!nextHint) {
      throw new Error('转场提示不能为空。');
    }

    if (shot.transitionHint !== nextHint) {
      shot.transitionHint = nextHint;
      changes.push('转场提示');
      shouldInvalidateVideoOutputs = true;
    }
  }

  if (input.videoPrompt !== undefined) {
    const nextPrompt = input.videoPrompt.trim();
    if (!nextPrompt) {
      throw new Error('视频生成 Prompt 不能为空。');
    }

    if (shot.videoPrompt !== nextPrompt) {
      shot.videoPrompt = nextPrompt;
      changes.push('视频 Prompt');
      shouldInvalidateVideoOutputs = true;
    }
  }

  if (input.backgroundSoundPrompt !== undefined) {
    const nextPrompt = input.backgroundSoundPrompt.trim();
    if (!nextPrompt) {
      throw new Error('背景声音 Prompt 不能为空。');
    }

    if (shot.backgroundSoundPrompt !== nextPrompt) {
      shot.backgroundSoundPrompt = nextPrompt;
      changes.push('背景声音 Prompt');
      shouldInvalidateVideoOutputs = true;
    }
  }

  if (input.speechPrompt !== undefined) {
    const nextPrompt = input.speechPrompt.trim();
    if (!nextPrompt) {
      throw new Error('台词/旁白 Prompt 不能为空。');
    }

    if (shot.speechPrompt !== nextPrompt) {
      shot.speechPrompt = nextPrompt;
      changes.push('台词/旁白 Prompt');
      if (ttsConfigured) {
        shouldInvalidateAudioOutputs = true;
        shouldInvalidateVideoOutputs = true;
      } else {
        shouldInvalidateVideoOutputs = true;
      }
    }
  }

  if (!changes.length) {
    return project;
  }

  if (shouldRecalculateStoryboardTimeline) {
    project.storyboard = normalizeStoryboardShots(project.storyboard, project.settings);
  }

  const downstreamInvalidation =
    shouldInvalidateStartFrameOutputs || shouldInvalidateLastFrameOutputs || shouldInvalidateVideoOutputs
      ? invalidateDownstreamLongTakeDependentOutputs(project, shotId)
      : {
          dependentShotIds: [] as string[],
          hadImageOutput: false,
          hadVideoOutput: false
        };

  if (shouldInvalidateStartFrameOutputs || shouldInvalidateLastFrameOutputs) {
    if (shouldInvalidateStartFrameOutputs) {
      clearActiveShotAsset(project, 'images', shotId);
    }
    if (shouldInvalidateLastFrameOutputs) {
      clearActiveShotAsset(project, 'lastImages', shotId);
    }
    if (shouldInvalidateAudioOutputs) {
      clearActiveShotAsset(project, 'audios', shotId, { archive: false });
      setShotAssetHistory(project, 'audios', shotId, []);
    }
    clearActiveShotAsset(project, 'videos', shotId);
    project.assets.finalVideo = null;
    resetStage(project, 'shots');
    resetStage(project, 'edit');
  } else if (shouldInvalidateVideoOutputs) {
    if (shouldInvalidateAudioOutputs) {
      clearActiveShotAsset(project, 'audios', shotId, { archive: false });
      setShotAssetHistory(project, 'audios', shotId, []);
    }
    clearActiveShotAsset(project, 'videos', shotId);
    project.assets.finalVideo = null;
    resetStage(project, 'shots');
    resetStage(project, 'edit');
  } else if (shouldInvalidateAudioOutputs) {
    clearActiveShotAsset(project, 'audios', shotId, { archive: false });
    setShotAssetHistory(project, 'audios', shotId, []);
    project.assets.finalVideo = null;
    resetStage(project, 'edit');
  } else if (shouldInvalidateEditOutput) {
    project.assets.finalVideo = null;
    resetStage(project, 'edit');
  }

  appendLog(
    project,
    shouldInvalidateStartFrameOutputs || shouldInvalidateLastFrameOutputs
      ? downstreamInvalidation.dependentShotIds.length
        ? `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新生成当前镜头及后续长镜头续接镜头 ${downstreamInvalidation.dependentShotIds.join(', ')} 的参考帧、视频片段和最终成片。`
        : `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新生成相关参考帧、视频片段和最终成片。`
      : shouldInvalidateVideoOutputs
      ? downstreamInvalidation.dependentShotIds.length
        ? `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新生成当前镜头及后续长镜头续接镜头 ${downstreamInvalidation.dependentShotIds.join(', ')} 的视频片段和最终成片。`
        : `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新生成相关视频片段和最终成片。`
      : shouldInvalidateEditOutput
        ? `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新执行视频剪辑以更新配音。`
      : `镜头 ${shot.title} 的${changes.join('、')}已更新。`
  );
  await persistStoryboard(project);
  await saveProject(project);
  return project;
}

function assetKindLabel(kind: ReferenceAssetKind): string {
  if (kind === 'character') {
    return '角色';
  }

  if (kind === 'scene') {
    return '场景';
  }

  return '物品';
}

function assetWorkflowLabel(workflowKind: 'character_asset' | 'reference_image_to_image' | 'text_to_image'): string {
  if (workflowKind === 'character_asset') {
    return '人物资产';
  }

  if (workflowKind === 'reference_image_to_image') {
    return '参考图生图';
  }

  return '文生图';
}
