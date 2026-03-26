import path from 'node:path';
import crypto from 'node:crypto';
import {
  type AppSettings,
  type GeneratedAsset,
  type LogLevel,
  type Project,
  type ReferenceAssetItem,
  type ReferenceAssetKind,
  type RunStage,
  type StageId,
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
  uploadImageToComfy
} from './comfyui.js';
import { extractLastFrame, stitchVideos } from './video-editor.js';

const runningProjects = new Map<string, Promise<void>>();
const runningReferenceGenerations = new Map<string, Promise<void>>();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);

interface GenerationReferenceInputs {
  referenceContext: string;
  referenceVariables: Record<string, TemplateVariable>;
  referenceCount: number;
  referenceImageCount: number;
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

async function saveProject(project: Project): Promise<void> {
  project.updatedAt = now();
  await writeProject(project);
}

async function persistReferenceLibrary(project: Project): Promise<void> {
  const libraryFile = await writeProjectFile(
    project.id,
    'references/reference-library.json',
    JSON.stringify(project.referenceLibrary, null, 2)
  );
  project.artifacts.referenceLibraryJson = libraryFile.relativePath;
}

function invalidateGeneratedMediaFromReferenceLibrary(project: Project): void {
  project.assets.images = [];
  project.assets.videos = [];
  project.assets.finalVideo = null;
  resetStage(project, 'images');
  resetStage(project, 'videos');
  resetStage(project, 'edit');
}

function resetDownstreamArtifacts(project: Project, stage: StageId): void {
  if (stage === 'script') {
    project.script = null;
    project.storyboard = [];
    project.assets.images = [];
    project.assets.videos = [];
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
    project.assets.images = [];
    project.assets.videos = [];
    project.assets.finalVideo = null;
    project.artifacts.storyboardJson = null;
    resetStage(project, 'images');
    resetStage(project, 'videos');
    resetStage(project, 'edit');
    return;
  }

  if (stage === 'images') {
    project.assets.images = [];
    project.assets.videos = [];
    project.assets.finalVideo = null;
    resetStage(project, 'videos');
    resetStage(project, 'edit');
    return;
  }

  if (stage === 'videos') {
    project.assets.videos = [];
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
  const referenceImages = [...characterReferenceImages, ...sceneReferenceImages, ...objectReferenceImages];

  return {
    referenceContext,
    referenceCount: getAllReferenceItems(project).length,
    referenceImageCount,
    referenceVariables: {
      reference_context: referenceContext,
      reference_count: getAllReferenceItems(project).length,
      reference_image_count: referenceImageCount,
      reference_assets: referenceAssets,
      reference_assets_json: JSON.stringify(referenceAssets),
      reference_images: referenceImages,
      reference_images_json: JSON.stringify(referenceImages),
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

function buildMergedVideoPrompt(shot: Project['storyboard'][number]): string {
  const parts = [shot.videoPrompt.trim()];
  const backgroundSoundPrompt = shot.backgroundSoundPrompt.trim();
  const speechPrompt = shot.speechPrompt.trim();

  if (backgroundSoundPrompt) {
    parts.push(`背景声音要求：${backgroundSoundPrompt}`);
  }

  if (speechPrompt) {
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
  if (hasConfiguredTtsWorkflow(appSettings)) {
    return appendTransitionHint(shot.videoPrompt, shot);
  }

  return appendTransitionHint(buildMergedVideoPrompt(shot), shot);
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

function buildComfyVariables(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  workflow: 'reference_image_to_image' | 'image_to_video',
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
  return {
    prompt:
      appendReferenceContext(
        options.promptOverride ??
          (workflow === 'reference_image_to_image'
            ? shot.firstFramePrompt
            : getVideoWorkflowPrompt(project, shot, appSettings)),
        options.referenceContext ?? ''
      ),
    negative_prompt: project.settings.negativePrompt,
    output_prefix: options.outputPrefix ?? `${project.id}_${shot.id}_${workflow}`,
    image_width: project.settings.imageWidth,
    image_height: project.settings.imageHeight,
    video_width: project.settings.videoWidth,
    video_height: project.settings.videoHeight,
    duration_seconds: options.durationSeconds ?? shot.durationSeconds,
    fps: project.settings.fps,
    input_image: options.inputImage ?? '',
    last_frame_image: options.lastFrameImage ?? '',
    last_frame_prompt: options.lastFramePrompt ?? shot.lastFramePrompt,
    ...(options.referenceVariables ?? {}),
    scene_number: shot.sceneNumber,
    shot_number: shot.shotNumber,
    seed: options.seed ?? Math.floor(Math.random() * 9_000_000_000)
  };
}

function getMaxVideoSegmentDurationSeconds(project: Project): number {
  return Math.max(1, project.settings.maxVideoSegmentDurationSeconds);
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

    if (!appSettings.comfyui.workflows.reference_image_to_image.workflowPath) {
      throw new Error('系统设置中未配置 ComfyUI 参考图生图工作流路径。');
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
  prompt?: string
): Promise<void> {
  const appSettings = getAppSettings();
  const workflowKind = getReferenceWorkflowKind(kind);
  const workflow = appSettings.comfyui.workflows[workflowKind];

  if (!workflow.workflowPath) {
    throw new Error(`系统设置中未配置 ComfyUI ${assetWorkflowLabel(kind)}工作流路径。`);
  }

  let generationPrompt = '';
  let itemName = '';

  updateReferenceItem(project, kind, itemId, (item) => {
    generationPrompt = prompt?.trim() || item.generationPrompt;
    itemName = item.name;

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
    const outputFiles = await runComfyWorkflow(workflow.workflowPath, {
      prompt: generationPrompt,
      negative_prompt: project.settings.negativePrompt,
      output_prefix: `${project.id}_${kind}_${itemId}_reference`,
      image_width: project.settings.imageWidth,
      image_height: project.settings.imageHeight,
      video_width: project.settings.videoWidth,
      video_height: project.settings.videoHeight,
      duration_seconds: project.settings.defaultShotDurationSeconds,
      fps: project.settings.fps,
      input_image: '',
      scene_number: 0,
      shot_number: 0,
      seed: Math.floor(Math.random() * 9_000_000_000)
    });

    const outputFile = pickOutputFile(outputFiles, 'image');
    const buffer = await fetchComfyOutputFile(outputFile);
    const extension = path.extname(outputFile.filename) || '.png';
    const folderName = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'objects';
    const saved = await writeProjectFile(project.id, `references/${folderName}/${itemId}${extension}`, buffer);
    const hadGeneratedMedia = Boolean(project.assets.images.length || project.assets.videos.length || project.assets.finalVideo);

    updateReferenceItem(project, kind, itemId, (item) => ({
      ...item,
      generationPrompt,
      status: 'success',
      error: null,
      updatedAt: now(),
      asset: buildAsset(saved.relativePath, generationPrompt, null, null)
    }));
    invalidateGeneratedMediaFromReferenceLibrary(project);
    appendLog(
      project,
      hadGeneratedMedia
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

async function runImageStage(project: Project): Promise<void> {
  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成图片。');
  }

  const appSettings = getAppSettings();
  const workflow = appSettings.comfyui.workflows.reference_image_to_image;
  if (!workflow.workflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 参考图生图工作流路径。');
  }

  const referenceUploadCache = new Map<string, string>();
  const generationReferenceInputs = await buildGenerationReferenceInputs(project, referenceUploadCache);
  appendLog(
    project,
    generationReferenceInputs.referenceCount
      ? `图片生成将注入 ${generationReferenceInputs.referenceCount} 个资产库参考项，其中 ${generationReferenceInputs.referenceImageCount} 张参考图会作为工作流输入。`
      : '资产库暂无可用参考项，图片生成将仅使用镜头 Prompt。',
    generationReferenceInputs.referenceCount ? 'info' : 'warn'
  );
  await saveProject(project);

  project.assets.images = [];
  await saveProject(project);

  for (let index = 0; index < project.storyboard.length; index += 1) {
    const shot = project.storyboard[index];
    appendLog(project, `图片生成 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
    await saveProject(project);

    const outputFiles = await runComfyWorkflow(
      workflow.workflowPath,
      buildComfyVariables(project, shot, appSettings, 'reference_image_to_image', {
        referenceContext: generationReferenceInputs.referenceContext,
        referenceVariables: generationReferenceInputs.referenceVariables
      })
    );

    const outputFile = pickOutputFile(outputFiles, 'image');
    const buffer = await fetchComfyOutputFile(outputFile);
    const extension = path.extname(outputFile.filename) || '.png';
    const saved = await writeProjectFile(project.id, `images/${shot.id}${extension}`, buffer);

    project.assets.images.push(buildAsset(saved.relativePath, shot.firstFramePrompt, shot.sceneNumber, shot.id));
    await saveProject(project);
  }

  appendLog(project, '全部分镜图片生成完成。');
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

  project.assets.videos = [];
  await saveProject(project);

  for (let index = 0; index < project.storyboard.length; index += 1) {
    const shot = project.storyboard[index];
    const imageAsset = project.assets.images.find((asset) => asset.shotId === shot.id);

    if (!imageAsset) {
      throw new Error(`镜头 ${shot.id} 缺少首帧图片，无法生成视频。`);
    }

    appendLog(project, `视频生成 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
    await saveProject(project);

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
      const segmentDuration = segmentDurations[segmentIndex];
      const uploadedImage = await uploadImageToComfy(currentInputImagePath);
      const isFinalSegment = segmentIndex === segmentCount - 1;
      if (isFinalSegment && targetLastFrameImagePath && !uploadedTargetLastFrameImage) {
        uploadedTargetLastFrameImage = await uploadImageToComfy(targetLastFrameImagePath);
      }
      const outputFiles = await runComfyWorkflow(
        workflow.workflowPath,
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
        const saved = await writeProjectFile(project.id, `videos/${shot.id}${extension}`, buffer);
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
      const outputPath = resolveProjectPath(project.id, 'videos', `${shot.id}.mp4`);
      appendLog(project, `镜头 ${shot.title} 分段生成完成，开始拼接 ${segmentCount} 段视频。`);
      await saveProject(project);
      await stitchVideos(segmentVideoPaths, outputPath, project.settings.fps);
      savedVideoRelativePath = toStorageRelative(outputPath);
    }

    project.assets.videos.push(
      buildAsset(savedVideoRelativePath, getVideoWorkflowPrompt(project, shot, appSettings), shot.sceneNumber, shot.id)
    );
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
  prompt?: string
): Promise<void> {
  const project = await readProject(projectId);
  await generateReferenceAssetForProject(project, kind, itemId, prompt);
}

async function setRunState(projectId: string, requestedStage: RunStage | null, currentStage: StageId | null): Promise<void> {
  const project = await readProject(projectId);
  project.runState = {
    isRunning: Boolean(requestedStage),
    requestedStage,
    currentStage,
    startedAt: requestedStage ? project.runState.startedAt ?? now() : null
  };
  await saveProject(project);
}

async function clearRunState(projectId: string): Promise<void> {
  const project = await readProject(projectId);
  project.runState = {
    isRunning: false,
    requestedStage: null,
    currentStage: null,
    startedAt: null
  };
  await saveProject(project);
}

async function runSingle(projectId: string, stage: StageId): Promise<void> {
  await setRunState(projectId, stage, stage);
  try {
    await executeStage(projectId, stage);
  } finally {
    await clearRunState(projectId);
  }
}

async function runAll(projectId: string): Promise<void> {
  await setRunState(projectId, 'all', null);
  try {
    for (const stage of STAGES) {
      await setRunState(projectId, 'all', stage);
      await executeStage(projectId, stage);
    }
  } finally {
    await clearRunState(projectId);
  }
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

export async function enqueueReferenceGeneration(
  projectId: string,
  kind: ReferenceAssetKind,
  itemId: string,
  prompt?: string
): Promise<void> {
  if (runningReferenceGenerations.has(projectId)) {
    throw new Error('当前项目已有参考资产任务在运行。');
  }

  const runner = executeReferenceGeneration(projectId, kind, itemId, prompt)
    .catch((error) => {
      console.error(`Reference asset generation failed for ${projectId}/${kind}/${itemId}:`, error);
    })
    .finally(() => {
      runningReferenceGenerations.delete(projectId);
    });

  runningReferenceGenerations.set(projectId, runner);
  await Promise.resolve();
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
    project.assets.images = project.assets.images.filter((asset) => asset.shotId !== shotId);
    project.assets.videos = project.assets.videos.filter((asset) => asset.shotId !== shotId);
    project.assets.finalVideo = null;
    resetStage(project, 'images');
    resetStage(project, 'videos');
    resetStage(project, 'edit');
  } else if (shouldInvalidateVideoOutputs) {
    project.assets.videos = project.assets.videos.filter((asset) => asset.shotId !== shotId);
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
