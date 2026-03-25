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
import { fromStorageRelative } from './config.js';
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
  fetchComfyOutputFile,
  runComfyWorkflow,
  uploadImageToComfy
} from './comfyui.js';
import { stitchVideos } from './video-editor.js';

const runningProjects = new Map<string, Promise<void>>();
const runningReferenceGenerations = new Map<string, Promise<void>>();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);

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
    resetStage(project, 'storyboard');
    resetStage(project, 'images');
    resetStage(project, 'videos');
    resetStage(project, 'edit');
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

function getReferenceWorkflowKind(kind: ReferenceAssetKind): 'character' | 'scene' | 'object' {
  if (kind === 'character') {
    return 'character';
  }

  if (kind === 'scene') {
    return 'scene';
  }

  return 'object';
}

function hasConfiguredTtsWorkflow(appSettings: AppSettings): boolean {
  return getRuntimeStatus(appSettings).ttsWorkflowExists;
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

function getVideoWorkflowPrompt(project: Project, shot: Project['storyboard'][number], appSettings: AppSettings): string {
  if (hasConfiguredTtsWorkflow(appSettings)) {
    return shot.videoPrompt;
  }

  return buildMergedVideoPrompt(shot);
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
  shot: Project['storyboard'][number],
  appSettings: AppSettings
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
    checkpoint_name: appSettings.comfyui.workflows.tts.checkpointName,
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
  workflow: 'storyboard' | 'video',
  inputImage = ''
) {
  return {
    prompt: workflow === 'storyboard' ? shot.firstFramePrompt : getVideoWorkflowPrompt(project, shot, appSettings),
    negative_prompt: project.settings.negativePrompt,
    output_prefix: `${project.id}_${shot.id}_${workflow}`,
    image_width: project.settings.imageWidth,
    image_height: project.settings.imageHeight,
    video_width: project.settings.videoWidth,
    video_height: project.settings.videoHeight,
    duration_seconds: shot.durationSeconds,
    fps: project.settings.fps,
    checkpoint_name: appSettings.comfyui.workflows[workflow].checkpointName,
    input_image: inputImage,
    scene_number: shot.sceneNumber,
    shot_number: shot.shotNumber,
    seed: Math.floor(Math.random() * 9_000_000_000)
  };
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

    if (!appSettings.comfyui.workflows.storyboard.workflowPath) {
      throw new Error('系统设置中未配置 ComfyUI 分镜图片生成工作流路径。');
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

    if (!appSettings.comfyui.workflows.video.workflowPath) {
      throw new Error('系统设置中未配置 ComfyUI 视频工作流路径。');
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

  try {
    appendLog(project, '开始自动提取角色、场景和关键物品。');
    await saveProject(project);

    project.referenceLibrary = await extractReferenceLibraryFromScript(script, project.settings);
    await persistReferenceLibrary(project);

    appendLog(
      project,
      `资产候选提取完成：角色 ${project.referenceLibrary.characters.length} 个，场景 ${project.referenceLibrary.scenes.length} 个，物品 ${project.referenceLibrary.objects.length} 个。`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    project.referenceLibrary = createEmptyReferenceLibrary();
    project.artifacts.referenceLibraryJson = null;
    appendLog(project, `资产候选提取失败，可稍后重试：${message}`, 'warn');
  }
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
  appendLog(project, `分镜生成完成，共 ${storyboard.length} 个镜头。`);
}

async function runImageStage(project: Project): Promise<void> {
  if (!project.storyboard.length) {
    throw new Error('请先生成分镜，再生成图片。');
  }

  const appSettings = getAppSettings();
  const workflow = appSettings.comfyui.workflows.storyboard;
  if (!workflow.workflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 分镜图片生成工作流路径。');
  }

  project.assets.images = [];
  await saveProject(project);

  for (let index = 0; index < project.storyboard.length; index += 1) {
    const shot = project.storyboard[index];
    appendLog(project, `图片生成 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
    await saveProject(project);

    const outputFiles = await runComfyWorkflow(
      workflow.workflowPath,
      buildComfyVariables(project, shot, appSettings, 'storyboard')
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
  const workflow = appSettings.comfyui.workflows.video;
  if (!workflow.workflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 视频工作流路径。');
  }

  if (!hasConfiguredTtsWorkflow(appSettings)) {
    appendLog(project, '未配置独立 TTS 工作流，背景声音和台词 Prompt 将合并到视频工作流 Prompt。');
  }

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

    const uploadedImage = await uploadImageToComfy(fromStorageRelative(imageAsset.relativePath));
    const outputFiles = await runComfyWorkflow(
      workflow.workflowPath,
      buildComfyVariables(project, shot, appSettings, 'video', uploadedImage)
    );

    const outputFile = pickOutputFile(outputFiles, 'video');
    const buffer = await fetchComfyOutputFile(outputFile);
    const extension = path.extname(outputFile.filename) || '.mp4';
    const saved = await writeProjectFile(project.id, `videos/${shot.id}${extension}`, buffer);

    project.assets.videos.push(
      buildAsset(saved.relativePath, getVideoWorkflowPrompt(project, shot, appSettings), shot.sceneNumber, shot.id)
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
        buildTtsVariables(project, shot, appSettings)
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
  const appSettings = getAppSettings();
  const workflowKind = getReferenceWorkflowKind(kind);
  const workflow = appSettings.comfyui.workflows[workflowKind];

  if (!workflow.workflowPath) {
    throw new Error(`系统设置中未配置 ComfyUI ${assetKindLabel(kind)}资产生成工作流路径。`);
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
      checkpoint_name: workflow.checkpointName,
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

    updateReferenceItem(project, kind, itemId, (item) => ({
      ...item,
      generationPrompt,
      status: 'success',
      error: null,
      updatedAt: now(),
      asset: buildAsset(saved.relativePath, generationPrompt, null, null)
    }));
    appendLog(project, `${itemName}${assetKindLabel(kind)}参考图生成完成。`);
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
  let shouldInvalidateVideoOutputs = false;
  let shouldInvalidateEditOutput = false;

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

  if (shouldInvalidateVideoOutputs) {
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
    shouldInvalidateVideoOutputs
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
