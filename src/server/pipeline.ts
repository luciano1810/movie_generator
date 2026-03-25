import path from 'node:path';
import crypto from 'node:crypto';
import {
  type AppSettings,
  type GeneratedAsset,
  type LogLevel,
  type Project,
  type RunStage,
  type StageId,
  STAGES,
  STAGE_LABELS
} from '../shared/types.js';
import { fromStorageRelative } from './config.js';
import { getAppSettings } from './app-settings.js';
import {
  readProject,
  resolveProjectPath,
  writeProject,
  writeProjectFile
} from './storage.js';
import { generateScriptFromText, generateStoryboardFromScript } from './openai-client.js';
import {
  type ComfyOutputFile,
  fetchComfyOutputFile,
  runComfyWorkflow,
  uploadImageToComfy
} from './comfyui.js';
import { stitchVideos } from './video-editor.js';

const runningProjects = new Map<string, Promise<void>>();
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif']);

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

function resetDownstreamArtifacts(project: Project, stage: StageId): void {
  if (stage === 'script') {
    project.script = null;
    project.storyboard = [];
    project.assets.images = [];
    project.assets.videos = [];
    project.assets.finalVideo = null;
    project.artifacts.scriptMarkdown = null;
    project.artifacts.scriptJson = null;
    project.artifacts.storyboardJson = null;
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

function buildComfyVariables(
  project: Project,
  shot: Project['storyboard'][number],
  appSettings: AppSettings,
  kind: 'image' | 'video',
  inputImage = ''
) {
  return {
    prompt: kind === 'image' ? shot.firstFramePrompt : shot.videoPrompt,
    negative_prompt: project.settings.negativePrompt,
    output_prefix: `${project.id}_${shot.id}_${kind}`,
    image_width: project.settings.imageWidth,
    image_height: project.settings.imageHeight,
    video_width: project.settings.videoWidth,
    video_height: project.settings.videoHeight,
    duration_seconds: shot.durationSeconds,
    fps: project.settings.fps,
    checkpoint_name:
      kind === 'image'
        ? appSettings.comfyui.imageCheckpointName
        : appSettings.comfyui.videoCheckpointName,
    input_image: inputImage,
    scene_number: shot.sceneNumber,
    shot_number: shot.shotNumber,
    seed: Math.floor(Math.random() * 9_000_000_000)
  };
}

function pickOutputFile(files: ComfyOutputFile[], kind: 'image' | 'video'): ComfyOutputFile {
  const matcher = kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
  const selected = files.find((file) => matcher.has(path.extname(file.filename).toLowerCase()));

  if (!selected) {
    throw new Error(`ComfyUI 未返回可用的${kind === 'image' ? '图片' : '视频'}文件。`);
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
  if (!appSettings.comfyui.imageWorkflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 图片工作流路径。');
  }

  project.assets.images = [];
  await saveProject(project);

  for (let index = 0; index < project.storyboard.length; index += 1) {
    const shot = project.storyboard[index];
    appendLog(project, `图片生成 ${index + 1}/${project.storyboard.length}: ${shot.title}`);
    await saveProject(project);

    const outputFiles = await runComfyWorkflow(
      appSettings.comfyui.imageWorkflowPath,
      buildComfyVariables(project, shot, appSettings, 'image')
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
  if (!appSettings.comfyui.videoWorkflowPath) {
    throw new Error('系统设置中未配置 ComfyUI 视频工作流路径。');
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
      appSettings.comfyui.videoWorkflowPath,
      buildComfyVariables(project, shot, appSettings, 'video', uploadedImage)
    );

    const outputFile = pickOutputFile(outputFiles, 'video');
    const buffer = await fetchComfyOutputFile(outputFile);
    const extension = path.extname(outputFile.filename) || '.mp4';
    const saved = await writeProjectFile(project.id, `videos/${shot.id}${extension}`, buffer);

    project.assets.videos.push(buildAsset(saved.relativePath, shot.videoPrompt, shot.sceneNumber, shot.id));
    await saveProject(project);
  }

  appendLog(project, '全部视频片段生成完成。');
}

async function runEditStage(project: Project): Promise<void> {
  if (!project.assets.videos.length) {
    throw new Error('请先生成视频片段，再执行剪辑。');
  }

  const orderedVideoAssets = project.storyboard
    .map((shot) => project.assets.videos.find((asset) => asset.shotId === shot.id))
    .filter((asset): asset is GeneratedAsset => Boolean(asset));

  if (!orderedVideoAssets.length) {
    throw new Error('没有可拼接的视频片段。');
  }

  appendLog(project, `开始拼接 ${orderedVideoAssets.length} 个视频片段。`);
  await saveProject(project);

  const outputPath = resolveProjectPath(project.id, 'output', 'final.mp4');
  await stitchVideos(
    orderedVideoAssets.map((asset) => fromStorageRelative(asset.relativePath)),
    outputPath,
    project.settings.fps
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
