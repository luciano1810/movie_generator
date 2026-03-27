import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
  generateStoryboardFromScript
} from './openai-client.js';
import {
  type ComfyOutputFile,
  type TemplateVariable,
  fetchComfyOutputFile,
  runComfyWorkflow,
  uploadImageBufferToComfy,
  uploadImageToComfy
} from './comfyui.js';
import { extractLastFrame, stitchVideos } from './video-editor.js';

const runningProjects = new Map<string, Promise<void>>();
const runningReferenceGenerations = new Map<string, Promise<void>>();
const cachedRunStates = new Map<string, ProjectRunState>();
const pauseRequestedProjects = new Set<string>();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);

interface GenerationReferenceInputs {
  referenceContext: string;
  referenceVariables: Record<string, TemplateVariable>;
  referenceCount: number;
  referenceImageCount: number;
  referenceImages: string[];
}

const DEFAULT_CHARACTER_POSE_REFERENCE_PATH = path.resolve(
  process.cwd(),
  'config/reference-images/character-pose-three-view.png'
);
const MAX_STORYBOARD_REFERENCE_IMAGES_PER_RUN = 3;
const MAX_STORYBOARD_REFERENCE_IMAGES_PER_CHAIN_RUN = 2;
const LTX_TARGET_LONG_SIDE = 720;
const LTX_DIMENSION_MULTIPLE = 16;

function buildCharacterAssetWorkflowPrompt(prompt: string, hasReferenceImage: boolean): string {
  if (hasReferenceImage) {
    return '根据参考三视图生成提供人物图片的三视图';
  }

  const trimmedPrompt = prompt.trim();
  return trimmedPrompt
    ? `根据参考三视图生成提供人物的三视图，特点为${trimmedPrompt}`
    : '根据参考三视图生成提供人物的三视图';
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

async function throwIfPauseRequested(projectId: string, stage: StageId): Promise<void> {
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

function hasGeneratedMediaOutputs(project: Project): boolean {
  return Boolean(project.assets.images.length || project.assets.videos.length || project.assets.finalVideo);
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

type ShotAssetStage = 'images' | 'videos';

function getShotAssetHistoryMap(project: Project, stage: ShotAssetStage) {
  return stage === 'images' ? project.assets.imageHistory : project.assets.videoHistory;
}

function setShotAssetHistoryMap(
  project: Project,
  stage: ShotAssetStage,
  history: Project['assets']['imageHistory'] | Project['assets']['videoHistory']
): void {
  if (stage === 'images') {
    project.assets.imageHistory = history;
    return;
  }

  project.assets.videoHistory = history;
}

function getShotAssetCollection(project: Project, stage: ShotAssetStage): GeneratedAsset[] {
  return stage === 'images' ? project.assets.images : project.assets.videos;
}

function setShotAssetCollection(project: Project, stage: ShotAssetStage, assets: GeneratedAsset[]): void {
  if (stage === 'images') {
    project.assets.images = assets;
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

function invalidateGeneratedMediaFromReferenceLibrary(project: Project): void {
  clearAllShotAssetHistory(project, 'images');
  clearAllShotAssetHistory(project, 'videos');
  project.assets.finalVideo = null;
  resetStage(project, 'images');
  resetStage(project, 'videos');
  resetStage(project, 'edit');
}

function resetDownstreamArtifacts(project: Project, stage: StageId): void {
  if (stage === 'script') {
    project.script = null;
    project.storyboard = [];
    clearAllShotAssetHistory(project, 'images');
    clearAllShotAssetHistory(project, 'videos');
    project.assets.finalVideo = null;
    project.referenceLibrary = createEmptyReferenceLibrary();
    project.artifacts.scriptMarkdown = null;
    project.artifacts.scriptJson = null;
    project.artifacts.storyboardJson = null;
    project.artifacts.referenceLibraryJson = null;
    resetStage(project, 'assets');
    resetStage(project, 'storyboard');
    resetStage(project, 'images');
    resetStage(project, 'videos');
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
    clearAllShotAssetHistory(project, 'images');
    clearAllShotAssetHistory(project, 'videos');
    project.assets.finalVideo = null;
    project.artifacts.storyboardJson = null;
    resetStage(project, 'images');
    resetStage(project, 'videos');
    resetStage(project, 'edit');
    return;
  }

  if (stage === 'images') {
    archiveAllActiveShotAssets(project, 'images');
    archiveAllActiveShotAssets(project, 'videos');
    project.assets.finalVideo = null;
    resetStage(project, 'videos');
    resetStage(project, 'edit');
    return;
  }

  if (stage === 'videos') {
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

function getReferenceWorkflowKind(kind: ReferenceAssetKind): 'character_asset' | 'text_to_image' {
  if (kind === 'character') {
    return 'character_asset';
  }

  return 'text_to_image';
}

function hasConfiguredTtsWorkflow(appSettings: AppSettings): boolean {
  return getRuntimeStatus(appSettings).ttsWorkflowExists;
}

function getAllReferenceItems(project: Project): ReferenceAssetItem[] {
  return [
    ...project.referenceLibrary.characters,
    ...project.referenceLibrary.scenes,
    ...project.referenceLibrary.objects
  ];
}

function buildReferenceContext(project: Project): string {
  const sections: string[] = [];
  const collections: Array<[ReferenceAssetKind, string, ReferenceAssetItem[]]> = [
    ['character', '角色参考', project.referenceLibrary.characters],
    ['scene', '场景参考', project.referenceLibrary.scenes],
    ['object', '物品参考', project.referenceLibrary.objects]
  ];

  for (const [_kind, label, items] of collections) {
    const formatted = items
      .map((item) => {
        const detail = item.summary.trim() || item.generationPrompt.trim();
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
  const characters = project.referenceLibrary.characters
    .map((item) => ({
      name: item.name.trim(),
      detail: item.generationPrompt.trim() || item.summary.trim()
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
    hasSpeechContent ? '人物特征与说话者识别：' : '人物特征约束：',
    ...selectedCharacters.map((item) => `- ${item.name}：${item.detail}`),
    hasSpeechContent
      ? '镜头内如有对白或旁白，必须根据这些人物外观、身份和气质特征明确当前说话者，并让对应人物的口型、表情、动作与发声主体一致，不要只写角色名。'
      : '保持人物外观、服装和气质稳定一致。'
  ].join('\n');
}

async function uploadImageToComfyCached(localPath: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(localPath);
  if (cached) {
    return cached;
  }

  const uploaded = await uploadImageToComfy(localPath);
  cache.set(localPath, uploaded);
  return uploaded;
}

async function buildGenerationReferenceInputs(
  project: Project,
  uploadCache: Map<string, string>
): Promise<GenerationReferenceInputs> {
  const referenceContext = buildReferenceContext(project);
  const collections: Array<[ReferenceAssetKind, ReferenceAssetItem[]]> = [
    ['character', project.referenceLibrary.characters],
    ['scene', project.referenceLibrary.scenes],
    ['object', project.referenceLibrary.objects]
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
        inputImage = await uploadImageToComfyCached(fromStorageRelative(item.asset.relativePath), uploadCache);
        referenceImageCount += 1;
      }

      preparedByKind[kind].push({
        kind,
        id: item.id,
        name: item.name,
        summary: item.summary,
        generation_prompt: item.generationPrompt,
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
    referenceCount: getAllReferenceItems(project).length,
    referenceImageCount,
    referenceImages,
    referenceVariables: {
      reference_context: referenceContext,
      reference_count: getAllReferenceItems(project).length,
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

function buildFirstFrameWorkflowPrompt(
  shot: Project['storyboard'][number],
  workflow: 'storyboard_image' | 'text_to_image' | 'reference_image_to_image' | 'image_edit' | 'image_to_video'
): string {
  const basePrompt = shot.firstFramePrompt.trim();

  if (workflow !== 'storyboard_image' && workflow !== 'image_edit') {
    return basePrompt;
  }

  return [
    basePrompt,
    '生成要求：基于参考输入重新生成一张全新的镜头首帧。',
    '参考输入只用于提取人物身份、造型、服装、场景、物品和整体风格约束，不要把它当作待修补、待微调或待局部重绘的底图。',
    '最终结果必须是一张新的完整画面，可以重新组织机位、景别、构图、动作、光线和背景，但要保持参考信息中的关键设定一致。'
  ].join('\n\n');
}

function buildMergedVideoPrompt(
  project: Project,
  shot: Project['storyboard'][number],
  options: {
    includeSpeechPrompt: boolean;
  }
): string {
  const hasSpeechContent = Boolean(shot.dialogue.trim() || shot.voiceover.trim());
  const parts = [shot.videoPrompt.trim()];
  const characterPrompt = buildVideoCharacterReferencePrompt(project, shot);
  const backgroundSoundPrompt = shot.backgroundSoundPrompt.trim();
  const speechPrompt = shot.speechPrompt.trim();

  if (characterPrompt) {
    parts.push(characterPrompt);
  }

  if (hasSpeechContent) {
    if (backgroundSoundPrompt) {
      parts.push(
        options.includeSpeechPrompt
          ? `背景声音要求：${backgroundSoundPrompt}`
          : `背景声音要求：${backgroundSoundPrompt}。仅保留自然环境音、动作音和空间氛围声，不要额外生成独立对白人声。`
      );
    } else if (!options.includeSpeechPrompt) {
      parts.push('背景声音要求：保留自然环境音、动作音和空间氛围声，不要额外生成独立对白人声。');
    }

    parts.push('说话者要求：如镜头中有人说话，必须通过人物外观、身份和气质特征明确发声主体，并让口型、表情、动作与台词或旁白同步。');
  } else {
    parts.push(
      backgroundSoundPrompt
        ? `声音要求：本镜头没有对白或旁白，不要出现人声或说话声；请生成自然、真实、连贯的背景环境音、动作音和空间氛围声。重点：${backgroundSoundPrompt}`
        : '声音要求：本镜头没有对白或旁白，不要出现人声或说话声；请生成自然、真实、连贯的背景环境音、动作音和空间氛围声。'
    );
  }

  if (options.includeSpeechPrompt && speechPrompt) {
    parts.push(`台词/旁白要求：${speechPrompt}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

function appendTransitionHint(prompt: string, shot: Project['storyboard'][number]): string {
  const transitionHint = shot.transitionHint.trim();

  if (!transitionHint) {
    return prompt;
  }

  return `${prompt}\n\n镜头衔接要求：${transitionHint}`;
}

function getVideoWorkflowPrompt(project: Project, shot: Project['storyboard'][number], appSettings: AppSettings): string {
  return appendTransitionHint(
    buildMergedVideoPrompt(project, shot, {
      includeSpeechPrompt: !hasConfiguredTtsWorkflow(appSettings)
    }),
    shot
  );
}

function shouldGenerateTtsForShot(shot: Project['storyboard'][number]): boolean {
  const speechPrompt = shot.speechPrompt.trim();

  if (!speechPrompt) {
    return false;
  }

  if (!shot.dialogue.trim() && !shot.voiceover.trim()) {
    return !/无语音内容|不生成语音|无需语音|无台词|无旁白/.test(speechPrompt);
  }

  return true;
}

function buildTtsVariables(
  project: Project,
  shot: Project['storyboard'][number]
) {
  return {
    prompt: shot.speechPrompt,
    negative_prompt: project.settings.negativePrompt,
    output_prefix: `${project.id}_${shot.id}_tts`,
    image_width: project.settings.imageWidth,
    image_height: project.settings.imageHeight,
    video_width: project.settings.videoWidth,
    video_height: project.settings.videoHeight,
    duration_seconds: shot.durationSeconds,
    fps: project.settings.fps,
    input_image: '',
    scene_number: shot.sceneNumber,
    shot_number: shot.shotNumber,
    seed: Math.floor(Math.random() * 9_000_000_000)
  };
}

function roundDownToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
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
  const longSide = Math.min(LTX_TARGET_LONG_SIDE, Math.max(safeWidth, safeHeight));
  const shortSideRaw = (longSide * Math.min(safeWidth, safeHeight)) / Math.max(safeWidth, safeHeight);
  const shortSide = roundDownToMultiple(shortSideRaw, LTX_DIMENSION_MULTIPLE);
  const isLandscape = safeWidth >= safeHeight;

  return {
    frame_count: Math.max(2, Math.round(durationSeconds * safeFps) + 1),
    latent_video_width: isLandscape ? longSide : shortSide,
    latent_video_height: isLandscape ? shortSide : longSide
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
    outputPrefix?: string;
    promptOverride?: string;
    referenceContext?: string;
    referenceVariables?: Record<string, TemplateVariable>;
    seed?: number;
  } = {}
) {
  const durationSeconds = options.durationSeconds ?? shot.durationSeconds;

  return {
    prompt:
      appendReferenceContext(
        options.promptOverride ??
          (workflow === 'image_to_video'
            ? getVideoWorkflowPrompt(project, shot, appSettings)
            : buildFirstFrameWorkflowPrompt(shot, workflow)),
        options.referenceContext ?? ''
      ),
    negative_prompt: project.settings.negativePrompt,
    output_prefix: options.outputPrefix ?? `${project.id}_${shot.id}_${workflow}`,
    image_width: project.settings.imageWidth,
    image_height: project.settings.imageHeight,
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
  generationReferenceInputs: GenerationReferenceInputs
): Promise<{ buffer: Buffer; extension: string; passCount: number }> {
  const referencePasses = buildStoryboardReferencePasses(generationReferenceInputs.referenceImages);

  if (!referencePasses.length) {
    throw new Error('首帧生成工作流至少需要一张参考图。');
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
      `首帧生成 ${shot.title} 参考图批次 ${passIndex + 1}/${referencePasses.length}：注入 ${sourceReferenceImages.length} 张参考图。`
    );
    await saveProject(project);

    const outputFiles = await runComfyWorkflow(
      workflowPath,
      buildComfyVariables(project, shot, appSettings, 'storyboard_image', {
        outputPrefix: `${project.id}_${shot.id}_storyboard_image_pass_${passIndex + 1}`,
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: buildStoryboardReferencePassVariables(
          generationReferenceInputs.referenceVariables,
          effectiveInputImages,
          sourceReferenceImages,
          passIndex,
          referencePasses.length,
          generationReferenceInputs.referenceImageCount
        )
      })
    );

    const outputFile = pickOutputFile(outputFiles, 'image');
    latestBuffer = await fetchComfyOutputFile(outputFile);
    latestExtension = path.extname(outputFile.filename) || '.png';

    if (passIndex < referencePasses.length - 1) {
      previousPassImage = await uploadImageBufferToComfy(
        latestBuffer,
        `${project.id}_${shot.id}_storyboard_image_pass_${passIndex + 1}${latestExtension}`
      );
    }
  }

  if (!latestBuffer) {
    throw new Error('首帧生成工作流未返回任何图片输出。');
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
  return splitDurationIntoSegments(shot.durationSeconds, getMaxVideoSegmentDurationSeconds(project));
}

function requiresVideoStageFfmpeg(project: Project): boolean {
  return project.storyboard.some((shot) => getShotVideoSegmentDurations(project, shot).length > 1);
}

function buildSegmentVideoPrompt(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  segmentIndex: number,
  segmentCount: number
): string {
  const basePrompt = getVideoWorkflowPrompt(project, shot, appSettings);

  if (segmentCount <= 1) {
    return basePrompt;
  }

  if (segmentIndex === segmentCount - 1) {
    return `${basePrompt}\n\n本段是长镜头的收尾段，结尾画面必须收束到以下尾帧描述：${shot.lastFramePrompt}`;
  }

  return `${basePrompt}\n\n本段是长镜头的第 ${segmentIndex + 1}/${segmentCount} 段，保持人物、机位、动作与光线连续，暂时不要提前收束到最终尾帧。`;
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
  const folder = stage === 'images' ? 'images' : 'videos';
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

  if (stage === 'images') {
    if (!project.storyboard.length) {
      throw new Error('请先生成分镜，再生成图片。');
    }

    if (
      !appSettings.comfyui.workflows.storyboard_image.workflowPath &&
      !appSettings.comfyui.workflows.image_edit.workflowPath &&
      !appSettings.comfyui.workflows.text_to_image.workflowPath
    ) {
      throw new Error('系统设置中未配置 ComfyUI 首帧生成工作流或文生图工作流路径。');
    }

    return;
  }

  if (stage === 'videos') {
    if (!project.storyboard.length) {
      throw new Error('请先生成分镜，再生成视频片段。');
    }

    if (!project.assets.images.length) {
      throw new Error('请先生成图片，再生成视频片段。');
    }

    if (!appSettings.comfyui.workflows.image_to_video.workflowPath) {
      throw new Error('系统设置中未配置 ComfyUI 图生视频工作流路径。');
    }

    if (
      project.storyboard.some((shot) => getShotVideoSegmentDurations(project, shot).length > 1) &&
      !appSettings.comfyui.workflows.reference_image_to_image.workflowPath
    ) {
      throw new Error('存在长镜头分段生成需求，但未配置参考图生图工作流，无法生成尾帧图。');
    }

    if (requiresVideoStageFfmpeg(project) && !appSettings.ffmpeg.binaryPath) {
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

  const script = await generateScriptFromText(project.sourceText, project.settings);
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

  project.referenceLibrary = await extractReferenceLibraryFromScript(project.script, project.settings);
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
  } = {}
): Promise<void> {
  const appSettings = getAppSettings();
  const workflowKind = getReferenceWorkflowKind(kind);
  const workflow = appSettings.comfyui.workflows[workflowKind];

  if (!workflow.workflowPath) {
    throw new Error(`系统设置中未配置 ComfyUI ${assetWorkflowLabel(kind)}工作流路径。`);
  }

  let generationPrompt = '';
  let itemName = '';
  let referenceImageRelativePath = '';
  let temporaryReferenceImage: GeneratedAsset | null = null;

  updateReferenceItem(project, kind, itemId, (item) => {
    generationPrompt = prompt?.trim() || item.generationPrompt;
    itemName = item.name;
    referenceImageRelativePath = item.referenceImage?.relativePath ?? '';
    temporaryReferenceImage = item.referenceImage;

    return {
      ...item,
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
    const shouldUseReferenceImage =
      typeof options.useReferenceImage === 'boolean'
        ? Boolean(options.useReferenceImage && referenceImageRelativePath)
        : Boolean(referenceImageRelativePath);
    const uploadedReferenceImage = shouldUseReferenceImage
      ? await uploadImageToComfy(fromStorageRelative(referenceImageRelativePath))
      : '';
    const uploadedCharacterPoseImage =
      kind === 'character' && existsSync(DEFAULT_CHARACTER_POSE_REFERENCE_PATH)
        ? await uploadImageToComfy(DEFAULT_CHARACTER_POSE_REFERENCE_PATH)
        : '';
    const editImage1 = uploadedReferenceImage || uploadedCharacterPoseImage;
    const editImage2 = uploadedCharacterPoseImage;
    const editImage3 = uploadedCharacterPoseImage;
    const workflowPrompt =
      kind === 'character'
        ? buildCharacterAssetWorkflowPrompt(generationPrompt, shouldUseReferenceImage)
        : generationPrompt;

    const outputFiles = await runComfyWorkflow(workflow.workflowPath, {
      prompt: workflowPrompt,
      negative_prompt: project.settings.negativePrompt,
      output_prefix: `${project.id}_${kind}_${itemId}_reference`,
      image_width: project.settings.imageWidth,
      image_height: project.settings.imageHeight,
      video_width: project.settings.videoWidth,
      video_height: project.settings.videoHeight,
      duration_seconds: project.settings.defaultShotDurationSeconds,
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
    });

    const outputFile = pickOutputFile(outputFiles, 'image');
    const buffer = await fetchComfyOutputFile(outputFile);
    const extension = path.extname(outputFile.filename) || '.png';
    const saved = await writeProjectFile(project.id, buildReferenceAssetOutputPath(kind, itemId, extension), buffer);
    const hadGeneratedMedia = hasGeneratedMediaOutputs(project);

    updateReferenceItem(project, kind, itemId, (item) => ({
      ...item,
      generationPrompt,
      status: 'success',
      error: null,
      updatedAt: now(),
      referenceImage: shouldUseReferenceImage ? null : item.referenceImage,
      asset: buildAsset(saved.relativePath, generationPrompt, null, null),
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
            ? `${itemName}${assetKindLabel(kind)}已按参考图和固定三视图模板生成完成，临时参考图已清除；图片与视频产物已失效，请重新生成。`
            : `${itemName}${assetKindLabel(kind)}已按参考图和固定三视图模板生成完成，临时参考图已清除。`
          : hadGeneratedMedia
            ? `${itemName}${assetKindLabel(kind)}已按默认三视图姿态参考和固定三视图模板生成完成，图片与视频产物已失效，请重新生成。`
            : `${itemName}${assetKindLabel(kind)}已按默认三视图姿态参考和固定三视图模板生成完成。`
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
    const message = error instanceof Error ? error.message : '未知错误';

    updateReferenceItem(project, kind, itemId, (item) => ({
      ...item,
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
      ? `${item.name}${assetKindLabel(kind)}参考图已上传。下次会按参考图和固定三视图模板生成；生成成功后不会保留这张参考图。`
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

    const workflow = appSettings.comfyui.workflows[getReferenceWorkflowKind(kind)];
    if (!workflow.workflowPath) {
      skippedCount += items.length;
      appendLog(
        project,
        `未配置 ${assetWorkflowLabel(kind)} 工作流，跳过 ${items.length} 个${assetKindLabel(kind)}候选。`,
        'warn'
      );
      continue;
    }

    for (const item of items) {
      await throwIfPauseRequested(project.id, 'assets');

      try {
        await generateReferenceAssetForProject(project, kind, item.id);
        generatedCount += 1;
      } catch {
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
  await saveProject(project);

  const storyboard = await generateStoryboardFromScript(project.script, project.settings);
  project.storyboard = storyboard;

  const jsonFile = await writeProjectFile(
    project.id,
    'storyboard/storyboard.json',
    JSON.stringify({ shots: storyboard }, null, 2)
  );

  project.artifacts.storyboardJson = jsonFile.relativePath;
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
    throw new Error('系统设置中未配置 ComfyUI 首帧生成工作流或文生图工作流路径。');
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
    throw new Error('首帧生成工作流需要至少一张参考图；当前未找到可注入的参考图，且未配置文生图回退工作流。');
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
      ? `首帧生成将注入 ${generationReferenceInputs.referenceCount} 个资产库参考项，其中 ${generationReferenceInputs.referenceImageCount} 张参考图会作为工作流输入。`
      : '资产库暂无可用参考项，首帧生成将仅使用镜头 Prompt。',
    generationReferenceInputs.referenceCount ? 'info' : 'warn'
  );

  if (selectedWorkflow.type === 'storyboard_image') {
    appendLog(project, '首帧阶段使用 storyboard_image 首帧生成工作流。');
  } else if (selectedWorkflow.type === 'image_edit') {
    appendLog(project, '未单独配置 storyboard_image，首帧阶段回退到 legacy image_edit 工作流。', 'warn');
  } else if (hasEditInputs) {
    appendLog(project, '当前没有可用的首帧生成工作流，首帧阶段回退到 text_to_image，仅使用 Prompt 与参考上下文。', 'warn');
  } else {
    appendLog(project, '当前没有可注入的参考图，首帧阶段回退到 text_to_image 工作流。', 'warn');
  }
}

async function generateImageAssetForShot(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  selectedWorkflow: SelectedImageStageWorkflow,
  generationReferenceInputs: GenerationReferenceInputs
): Promise<GeneratedAsset> {
  let buffer: Buffer;
  let extension: string;

  if (selectedWorkflow.type === 'storyboard_image' || selectedWorkflow.type === 'image_edit') {
    const result = await runStoryboardImageWorkflowForShot(
      project,
      shot,
      appSettings,
      selectedWorkflow.workflowPath,
      generationReferenceInputs
    );
    buffer = result.buffer;
    extension = result.extension;

    if (result.passCount > 1) {
      appendLog(project, `${shot.title} 已按 ${result.passCount} 轮参考图批次完成首帧生成。`);
      await saveProject(project);
    }
  } else {
    const outputFiles = await runComfyWorkflow(
      selectedWorkflow.workflowPath,
      buildComfyVariables(project, shot, appSettings, selectedWorkflow.type, {
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: generationReferenceInputs.referenceVariables
      })
    );

    const outputFile = pickOutputFile(outputFiles, 'image');
    buffer = await fetchComfyOutputFile(outputFile);
    extension = path.extname(outputFile.filename) || '.png';
  }

  const saved = await writeProjectFile(project.id, buildShotAssetOutputPath('images', shot.id, extension), buffer);
  return buildAsset(saved.relativePath, shot.firstFramePrompt, shot.sceneNumber, shot.id);
}

async function generateVideoAssetForShot(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  generationReferenceInputs: GenerationReferenceInputs
): Promise<GeneratedAsset> {
  const workflowPath = appSettings.comfyui.workflows.image_to_video.workflowPath;

  if (!workflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 图生视频工作流路径。');
  }

  const imageAsset = getActiveShotAsset(project, 'images', shot.id);

  if (!imageAsset) {
    throw new Error(`镜头 ${shot.id} 缺少首帧图片，无法生成视频。`);
  }

  const segmentDurations = getShotVideoSegmentDurations(project, shot);
  const segmentCount = segmentDurations.length;
  const shotSeed = Math.floor(Math.random() * 9_000_000_000);

  if (segmentCount > 1) {
    appendLog(
      project,
      `镜头 ${shot.title} 为长镜头，将拆成 ${segmentCount} 段生成（总时长 ${shot.durationSeconds}s，每段最长 ${getMaxVideoSegmentDurationSeconds(project)}s），并使用首尾帧约束收束画面。`
    );
    await saveProject(project);
  }

  let currentInputImagePath = fromStorageRelative(imageAsset.relativePath);
  const segmentVideoPaths: string[] = [];
  let savedVideoRelativePath: string | null = null;
  let targetLastFrameImagePath = '';
  let uploadedTargetLastFrameImage = '';

  if (segmentCount > 1) {
    const lastFrameOutputFiles = await runComfyWorkflow(
      appSettings.comfyui.workflows.reference_image_to_image.workflowPath,
      buildComfyVariables(project, shot, appSettings, 'reference_image_to_image', {
        outputPrefix: `${project.id}_${shot.id}_lastframe`,
        promptOverride: shot.lastFramePrompt,
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: generationReferenceInputs.referenceVariables,
        seed: shotSeed
      })
    );
    const lastFrameOutputFile = pickOutputFile(lastFrameOutputFiles, 'image');
    const lastFrameBuffer = await fetchComfyOutputFile(lastFrameOutputFile);
    const lastFrameExtension = path.extname(lastFrameOutputFile.filename) || '.png';
    const lastFrameSaved = await writeProjectFile(
      project.id,
      path.join('.video-stage', shot.id, 'frames', `target-last${lastFrameExtension}`),
      lastFrameBuffer
    );
    targetLastFrameImagePath = lastFrameSaved.absolutePath;

    appendLog(project, `镜头 ${shot.title} 的尾帧图已生成，长镜头最后一段会向该尾帧收束。`);
    await saveProject(project);
  }

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    await throwIfPauseRequested(project.id, 'videos');

    const segmentDuration = segmentDurations[segmentIndex];
    const uploadedImage = await uploadImageToComfy(currentInputImagePath);
    const isFinalSegment = segmentIndex === segmentCount - 1;

    if (isFinalSegment && targetLastFrameImagePath && !uploadedTargetLastFrameImage) {
      uploadedTargetLastFrameImage = await uploadImageToComfy(targetLastFrameImagePath);
    }

    const outputFiles = await runComfyWorkflow(
      workflowPath,
      buildComfyVariables(project, shot, appSettings, 'image_to_video', {
        durationSeconds: segmentDuration,
        inputImage: uploadedImage,
        lastFrameImage: isFinalSegment ? uploadedTargetLastFrameImage : '',
        lastFramePrompt: shot.lastFramePrompt,
        outputPrefix:
          segmentCount === 1
            ? `${project.id}_${shot.id}_video`
            : `${project.id}_${shot.id}_video_seg${String(segmentIndex + 1).padStart(3, '0')}`,
        promptOverride: buildSegmentVideoPrompt(project, shot, appSettings, segmentIndex, segmentCount),
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: generationReferenceInputs.referenceVariables,
        seed: shotSeed
      })
    );

    const outputFile = pickOutputFile(outputFiles, 'video');
    const buffer = await fetchComfyOutputFile(outputFile);
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
      await extractLastFrame(segmentSaved.absolutePath, continuationFramePath);
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
    await stitchVideos(segmentVideoPaths, outputPath, project.settings.fps);
    savedVideoRelativePath = toStorageRelative(outputPath);
  }

  return buildAsset(savedVideoRelativePath, getVideoWorkflowPrompt(project, shot, appSettings), shot.sceneNumber, shot.id);
}

async function runImageStage(project: Project): Promise<void> {
  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成图片。');
  }

  const appSettings = getAppSettings();
  const referenceUploadCache = new Map<string, string>();
  const generationReferenceInputs = await buildGenerationReferenceInputs(project, referenceUploadCache);
  const selectedWorkflow = resolveImageStageWorkflow(appSettings, generationReferenceInputs);
  appendImageWorkflowLog(project, selectedWorkflow, generationReferenceInputs);
  await saveProject(project);

  for (let index = 0; index < project.storyboard.length; index += 1) {
    await throwIfPauseRequested(project.id, 'images');

    const shot = project.storyboard[index];
    appendLog(project, `首帧生成 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
    await saveProject(project);

    const imageAsset = await generateImageAssetForShot(project, shot, appSettings, selectedWorkflow, generationReferenceInputs);
    setActiveShotAsset(project, 'images', shot.id, imageAsset);
    await saveProject(project);
  }

  appendLog(project, '全部镜头首帧生成完成。');
}

async function runVideoStage(project: Project): Promise<void> {
  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成视频片段。');
  }

  if (!project.assets.images.length) {
    throw new Error('请先生成图片，再生成视频片段。');
  }

  const appSettings = getAppSettings();
  const workflow = appSettings.comfyui.workflows.image_to_video;
  if (!workflow.workflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 图生视频工作流路径。');
  }

  if (!hasConfiguredTtsWorkflow(appSettings)) {
    appendLog(project, '未配置独立 TTS 工作流，背景声音和台词 Prompt 将合并到视频工作流 Prompt。');
  }

  if (
    project.storyboard.some((shot) => getShotVideoSegmentDurations(project, shot).length > 1) &&
    !appSettings.comfyui.workflows.reference_image_to_image.workflowPath
  ) {
    throw new Error('存在长镜头分段生成需求，但未配置参考图生图工作流，无法生成尾帧图。');
  }

  if (requiresVideoStageFfmpeg(project) && !appSettings.ffmpeg.binaryPath) {
    throw new Error('存在长镜头分段生成需求，但未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定路径。');
  }

  const referenceUploadCache = new Map<string, string>();
  const generationReferenceInputs = await buildGenerationReferenceInputs(project, referenceUploadCache);
  appendLog(
    project,
    generationReferenceInputs.referenceCount
      ? `视频生成将注入 ${generationReferenceInputs.referenceCount} 个资产库参考项，其中 ${generationReferenceInputs.referenceImageCount} 张参考图会作为工作流输入。`
      : '资产库暂无可用参考项，视频生成将仅使用镜头 Prompt 和首尾帧。',
    generationReferenceInputs.referenceCount ? 'info' : 'warn'
  );
  await saveProject(project);

  for (let index = 0; index < project.storyboard.length; index += 1) {
    await throwIfPauseRequested(project.id, 'videos');

    const shot = project.storyboard[index];

    appendLog(project, `视频生成 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
    await saveProject(project);
    const videoAsset = await generateVideoAssetForShot(project, shot, appSettings, generationReferenceInputs);
    setActiveShotAsset(project, 'videos', shot.id, videoAsset);
    await saveProject(project);
  }

  appendLog(project, '全部视频片段生成完成。');
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
  const orderedAudioPaths: Array<string | null> = [];

  if (hasConfiguredTtsWorkflow(appSettings)) {
    appendLog(project, '已配置 TTS 工作流，开始为镜头生成配音音频。');
    await saveProject(project);

    for (let index = 0; index < project.storyboard.length; index += 1) {
      await throwIfPauseRequested(project.id, 'edit');

      const shot = project.storyboard[index];

      if (!shouldGenerateTtsForShot(shot)) {
        orderedAudioPaths.push(null);
        continue;
      }

      appendLog(project, `TTS 配音 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
      await saveProject(project);

      const outputFiles = await runComfyWorkflow(
        appSettings.comfyui.workflows.tts.workflowPath,
        buildTtsVariables(project, shot)
      );
      const outputFile = pickOutputFile(outputFiles, 'audio');
      const buffer = await fetchComfyOutputFile(outputFile);
      const extension = path.extname(outputFile.filename) || '.wav';
      const saved = await writeProjectFile(project.id, `audio/${shot.id}${extension}`, buffer);
      orderedAudioPaths.push(fromStorageRelative(saved.relativePath));
    }

    appendLog(project, '镜头配音音频生成完成，开始合成成片。');
    await saveProject(project);
  }

  await throwIfPauseRequested(project.id, 'edit');

  const outputPath = resolveProjectPath(project.id, 'output', 'final.mp4');
  await stitchVideos(
    orderedVideoAssets.map((asset) => fromStorageRelative(asset.relativePath)),
    outputPath,
    project.settings.fps,
    orderedAudioPaths
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
    if (stage === 'script') {
      await runScriptStage(project);
    } else if (stage === 'assets') {
      await runAssetStage(project);
    } else if (stage === 'storyboard') {
      await runStoryboardStage(project);
    } else if (stage === 'images') {
      await runImageStage(project);
    } else if (stage === 'videos') {
      await runVideoStage(project);
    } else {
      await runEditStage(project);
    }

    setStageStatus(project, stage, 'success');
    appendLog(project, `${STAGE_LABELS[stage]} 执行成功。`);
    await saveProject(project);
  } catch (error) {
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
    isPaused: false
  });
}

async function clearRunState(projectId: string): Promise<void> {
  pauseRequestedProjects.delete(projectId);
  await persistProjectRunState(projectId, createIdleRunState());
  cachedRunStates.delete(projectId);
}

async function runSingle(projectId: string, stage: StageId): Promise<void> {
  pauseRequestedProjects.delete(projectId);
  await setRunState(projectId, stage, stage);
  try {
    await executeStage(projectId, stage);
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

        throw error;
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
    isPaused: false
  };
  cachedRunStates.set(projectId, { ...project.runState });
  appendLog(project, '已请求暂停；系统会在当前阶段安全结束后暂停全流程。', 'warn');
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

async function executeStoryboardShotImageGeneration(projectId: string, shotId: string): Promise<void> {
  const project = await readProject(projectId);
  const shot = project.storyboard.find((item) => item.id === shotId);

  if (!shot) {
    throw new Error(`未找到镜头 ${shotId}`);
  }

  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成图片。');
  }

  const appSettings = getAppSettings();
  const referenceUploadCache = new Map<string, string>();
  const generationReferenceInputs = await buildGenerationReferenceInputs(project, referenceUploadCache);
  const selectedWorkflow = resolveImageStageWorkflow(appSettings, generationReferenceInputs);
  appendLog(project, `开始为镜头 ${shot.title} 单独执行首帧生成。`);
  appendImageWorkflowLog(project, selectedWorkflow, generationReferenceInputs);
  await saveProject(project);

  const imageAsset = await generateImageAssetForShot(project, shot, appSettings, selectedWorkflow, generationReferenceInputs);
  const replacedVideoAsset = clearActiveShotAsset(project, 'videos', shot.id);
  setActiveShotAsset(project, 'images', shot.id, imageAsset);
  project.assets.finalVideo = null;
  resetStage(project, 'videos');
  resetStage(project, 'edit');

  appendLog(
    project,
    replacedVideoAsset
      ? `镜头 ${shot.title} 的首帧图片已更新，原视频片段已移入历史版本，请重新生成或重新选择视频版本。`
      : `镜头 ${shot.title} 的首帧图片已更新，历史版本已保留。`
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

  if (!getActiveShotAsset(project, 'images', shot.id)) {
    throw new Error('请先为当前镜头生成或选择首帧图片，再生成视频片段。');
  }

  const appSettings = getAppSettings();
  if (!appSettings.comfyui.workflows.image_to_video.workflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 图生视频工作流路径。');
  }

  if (getShotVideoSegmentDurations(project, shot).length > 1 && !appSettings.comfyui.workflows.reference_image_to_image.workflowPath) {
    throw new Error('当前镜头需要长镜头分段生成，但未配置参考图生图工作流，无法生成尾帧图。');
  }

  if (getShotVideoSegmentDurations(project, shot).length > 1 && !appSettings.ffmpeg.binaryPath) {
    throw new Error('当前镜头需要长镜头分段生成，但未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定路径。');
  }

  if (!hasConfiguredTtsWorkflow(appSettings)) {
    appendLog(project, '未配置独立 TTS 工作流，背景声音和台词 Prompt 将合并到视频工作流 Prompt。');
  }

  const referenceUploadCache = new Map<string, string>();
  const generationReferenceInputs = await buildGenerationReferenceInputs(project, referenceUploadCache);
  appendLog(project, `开始为镜头 ${shot.title} 单独生成视频片段。`);
  appendLog(
    project,
    generationReferenceInputs.referenceCount
      ? `视频生成将注入 ${generationReferenceInputs.referenceCount} 个资产库参考项，其中 ${generationReferenceInputs.referenceImageCount} 张参考图会作为工作流输入。`
      : '资产库暂无可用参考项，视频生成将仅使用镜头 Prompt 和首尾帧。',
    generationReferenceInputs.referenceCount ? 'info' : 'warn'
  );
  await saveProject(project);

  const videoAsset = await generateVideoAssetForShot(project, shot, appSettings, generationReferenceInputs);
  setActiveShotAsset(project, 'videos', shot.id, videoAsset);
  project.assets.finalVideo = null;
  resetStage(project, 'edit');
  appendLog(project, `镜头 ${shot.title} 的视频片段已更新，历史版本已保留。`);
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
    project.assets.finalVideo = null;
    resetStage(project, 'videos');
    resetStage(project, 'edit');
    appendLog(project, `镜头 ${shot.title} 已切换到指定首帧版本；当前视频片段已失效，请重新生成或重新选择视频版本。`);
  } else {
    project.assets.finalVideo = null;
    resetStage(project, 'edit');
    appendLog(project, `镜头 ${shot.title} 已切换到指定视频版本，请重新执行视频剪辑。`);
  }

  await saveProject(project);
  return project;
}

export async function enqueueStoryboardShotImageGeneration(projectId: string, shotId: string): Promise<void> {
  await enqueueStageScopedProjectTask(
    projectId,
    'images',
    async () => {
      await executeStoryboardShotImageGeneration(projectId, shotId);
    },
    'Shot image generation'
  );
}

export async function enqueueStoryboardShotVideoGeneration(projectId: string, shotId: string): Promise<void> {
  await enqueueStageScopedProjectTask(
    projectId,
    'videos',
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

export async function updateStoryboardShotPrompts(
  projectId: string,
  shotId: string,
  input: {
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
  const ttsConfigured = hasConfiguredTtsWorkflow(getAppSettings());

  if (!shot) {
    throw new Error(`未找到镜头 ${shotId}`);
  }

  const changes: string[] = [];
  let shouldInvalidateImageOutputs = false;
  let shouldInvalidateVideoOutputs = false;
  let shouldInvalidateEditOutput = false;

  if (input.firstFramePrompt !== undefined) {
    const nextPrompt = input.firstFramePrompt.trim();
    if (!nextPrompt) {
      throw new Error('首帧 Prompt 不能为空。');
    }

    if (shot.firstFramePrompt !== nextPrompt) {
      shot.firstFramePrompt = nextPrompt;
      changes.push('首帧 Prompt');
      shouldInvalidateImageOutputs = true;
      shouldInvalidateVideoOutputs = true;
    }
  }

  if (input.lastFramePrompt !== undefined) {
    const nextPrompt = input.lastFramePrompt.trim();
    if (!nextPrompt) {
      throw new Error('尾帧 Prompt 不能为空。');
    }

    if (shot.lastFramePrompt !== nextPrompt) {
      shot.lastFramePrompt = nextPrompt;
      changes.push('尾帧 Prompt');
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
      if (!ttsConfigured) {
        shouldInvalidateVideoOutputs = true;
      }
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
        shouldInvalidateEditOutput = true;
      } else {
        shouldInvalidateVideoOutputs = true;
      }
    }
  }

  if (!changes.length) {
    return project;
  }

  if (shouldInvalidateImageOutputs) {
    clearActiveShotAsset(project, 'images', shotId);
    clearActiveShotAsset(project, 'videos', shotId);
    project.assets.finalVideo = null;
    resetStage(project, 'images');
    resetStage(project, 'videos');
    resetStage(project, 'edit');
  } else if (shouldInvalidateVideoOutputs) {
    clearActiveShotAsset(project, 'videos', shotId);
    project.assets.finalVideo = null;
    resetStage(project, 'videos');
    resetStage(project, 'edit');
  } else if (shouldInvalidateEditOutput) {
    project.assets.finalVideo = null;
    resetStage(project, 'edit');
  }

  appendLog(
    project,
    shouldInvalidateImageOutputs
      ? `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新生成相关首帧图片、视频片段和最终成片。`
      : shouldInvalidateVideoOutputs
      ? `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新生成相关视频片段和最终成片。`
      : shouldInvalidateEditOutput
        ? `镜头 ${shot.title} 的${changes.join('、')}已更新，请重新执行视频剪辑以更新配音。`
      : `镜头 ${shot.title} 的${changes.join('、')}已更新。`
  );
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

function assetWorkflowLabel(kind: ReferenceAssetKind): string {
  return kind === 'character' ? '人物资产' : '文生图';
}
