import { access } from 'node:fs/promises';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import {
  type AppSettings,
  type AppMeta,
  type LlmModelDiscoveryRequest,
  type LlmModelDiscoveryResponse,
  type Project,
  type ReferenceAssetKind,
  type ShotReferenceFrameKind,
  type RunStage,
  DEFAULT_SETTINGS,
  STAGES,
  STAGE_LABELS
} from '../shared/types.js';
import { appConfig, fromStorageRelative } from './config.js';
import { getAppSettings, getRuntimeStatus, initializeAppSettings, updateAppSettings } from './app-settings.js';
import { discoverAvailableModels } from './openai-client.js';
import {
  ensureStorage,
  clearInterruptedRunStates,
  createProject,
  deleteProject,
  listProjects,
  readProject,
  updateProject
} from './storage.js';
import {
  addReferenceAssetToStoryboardShot,
  continueProjectRun,
  enqueueProjectRun,
  enqueueReferenceGeneration,
  enqueueStoryboardShotImageGeneration,
  enqueueStoryboardShotLastImageGeneration,
  enqueueStoryboardShotVideoGeneration,
  isProjectRunning,
  isReferenceGenerationRunning,
  removeReferenceAudioForAsset,
  removeReferenceAssetFromStoryboardShot,
  removeReferenceImageForAsset,
  requestProjectRunPause,
  requestProjectRunStop,
  resumeProjectRun,
  selectLibraryAssetForReferenceItem,
  selectStoryboardShotImageVersion,
  selectStoryboardShotVideoVersion,
  uploadReferenceAudioForAsset,
  uploadReferenceImageForAsset,
  updateStoryboardShotPrompts
} from './pipeline.js';

function isRunStage(value: unknown): value is RunStage {
  return value === 'all' || (typeof value === 'string' && STAGES.includes(value as (typeof STAGES)[number]));
}

function isReferenceAssetKind(value: unknown): value is ReferenceAssetKind {
  return value === 'character' || value === 'scene' || value === 'object';
}

function isShotReferenceFrameKind(value: unknown): value is ShotReferenceFrameKind {
  return value === 'start' || value === 'end';
}

function getReferenceCollection(project: Project, kind: ReferenceAssetKind) {
  if (kind === 'character') {
    return project.referenceLibrary.characters;
  }

  if (kind === 'scene') {
    return project.referenceLibrary.scenes;
  }

  return project.referenceLibrary.objects;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseImageUploadPayload(body: unknown): {
  filename: string;
  mimeType: string;
  buffer: Buffer;
} {
  const filename = typeof (body as { filename?: unknown })?.filename === 'string'
    ? String((body as { filename: string }).filename).trim()
    : '';
  const dataUrl = typeof (body as { dataUrl?: unknown })?.dataUrl === 'string'
    ? String((body as { dataUrl: string }).dataUrl).trim()
    : '';

  if (!filename || !dataUrl) {
    throw new Error('参考图上传参数不完整。');
  }

  const matched = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!matched) {
    throw new Error('参考图数据格式无效。');
  }

  const [, mimeType, base64Payload] = matched;
  const buffer = Buffer.from(base64Payload, 'base64');

  if (!mimeType.startsWith('image/')) {
    throw new Error('仅支持上传图片文件。');
  }

  if (!buffer.length) {
    throw new Error('参考图内容为空。');
  }

  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error('参考图不能超过 10MB。');
  }

  return {
    filename,
    mimeType,
    buffer
  };
}

function parseAudioUploadPayload(body: unknown): {
  filename: string;
  mimeType: string;
  buffer: Buffer;
} {
  const filename = typeof (body as { filename?: unknown })?.filename === 'string'
    ? String((body as { filename: string }).filename).trim()
    : '';
  const dataUrl = typeof (body as { dataUrl?: unknown })?.dataUrl === 'string'
    ? String((body as { dataUrl: string }).dataUrl).trim()
    : '';

  if (!filename || !dataUrl) {
    throw new Error('参考音频上传参数不完整。');
  }

  const matched = dataUrl.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!matched) {
    throw new Error('参考音频数据格式无效。');
  }

  const [, mimeType, base64Payload] = matched;
  const buffer = Buffer.from(base64Payload, 'base64');

  if (!mimeType.startsWith('audio/')) {
    throw new Error('仅支持上传音频文件。');
  }

  if (!buffer.length) {
    throw new Error('参考音频内容为空。');
  }

  if (buffer.length > 20 * 1024 * 1024) {
    throw new Error('参考音频不能超过 20MB。');
  }

  return {
    filename,
    mimeType,
    buffer
  };
}

function sanitizeDownloadFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
}

function formatDownloadTimestamp(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, '0');
  const day = String(safeDate.getDate()).padStart(2, '0');
  const hours = String(safeDate.getHours()).padStart(2, '0');
  const minutes = String(safeDate.getMinutes()).padStart(2, '0');
  const seconds = String(safeDate.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildFinalVideoDownloadName(project: Project): string {
  const title = sanitizeDownloadFilenamePart(project.title) || '电影项目';
  const extension = path.extname(project.assets.finalVideo?.relativePath ?? '') || '.mp4';
  const timestamp = formatDownloadTimestamp(project.assets.finalVideo?.createdAt ?? project.updatedAt);
  return `${title}-最终成片-${timestamp}${extension}`;
}

async function main(): Promise<void> {
  await ensureStorage();
  await initializeAppSettings();
  const repairedRunStates = await clearInterruptedRunStates();

  if (repairedRunStates > 0) {
    console.warn(`Recovered ${repairedRunStates} interrupted project run state(s).`);
  }

  const app = express();
  app.use(
    cors({
      origin: true
    })
  );
  app.use(express.json({ limit: '20mb' }));
  app.use('/storage', express.static(appConfig.storageRoot));

  app.get('/api/meta', (_request, response) => {
    const appSettings = getAppSettings();
    const meta: AppMeta = {
      defaults: {
        ...DEFAULT_SETTINGS,
        maxVideoSegmentDurationSeconds: appSettings.comfyui.maxVideoSegmentDurationSeconds
      },
      stages: STAGES.map((stage) => ({
        id: stage,
        label: STAGE_LABELS[stage]
      })),
      envStatus: getRuntimeStatus(appSettings),
      workflowPaths: {
        character_asset: appSettings.comfyui.workflows.character_asset.workflowPath,
        storyboard_image: appSettings.comfyui.workflows.storyboard_image.workflowPath,
        text_to_image: appSettings.comfyui.workflows.text_to_image.workflowPath,
        reference_image_to_image: appSettings.comfyui.workflows.reference_image_to_image.workflowPath,
        image_edit: appSettings.comfyui.workflows.image_edit.workflowPath,
        text_to_video: appSettings.comfyui.workflows.text_to_video.workflowPath,
        image_to_video_first_last: appSettings.comfyui.workflows.image_to_video_first_last.workflowPath,
        image_to_video_first_frame: appSettings.comfyui.workflows.image_to_video_first_frame.workflowPath,
        tts: appSettings.comfyui.workflows.tts.workflowPath
      }
    };

    response.json(meta);
  });

  app.get('/api/app-settings', (_request, response) => {
    response.json(getAppSettings());
  });

  app.put('/api/app-settings', async (request, response, next) => {
    try {
      response.json(await updateAppSettings((request.body ?? {}) as Partial<AppSettings>));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/llm-models/discover', async (request, response, next) => {
    try {
      const payload = (request.body ?? {}) as Partial<LlmModelDiscoveryRequest>;
      const result: LlmModelDiscoveryResponse = {
        models: await discoverAvailableModels({
          baseUrl: payload.baseUrl ?? '',
          apiKey: payload.apiKey ?? ''
        })
      };
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects', async (_request, response, next) => {
    try {
      response.json(await listProjects());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects', async (request, response, next) => {
    try {
      const project = await createProject({
        title: String(request.body?.title ?? ''),
        sourceText: String(request.body?.sourceText ?? ''),
        settings: request.body?.settings ?? {}
      });

      response.status(201).json(project);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:id', async (request, response, next) => {
    try {
      response.json(await readProject(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id', async (request, response, next) => {
    try {
      response.json(
        await updateProject(request.params.id, {
          title: request.body?.title,
          sourceText: request.body?.sourceText,
          settings: request.body?.settings
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:id', async (request, response, next) => {
    try {
      try {
        await readProject(request.params.id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (isProjectRunning(request.params.id)) {
        response.status(409).json({ message: '该项目正在执行流程，暂时不能删除。' });
        return;
      }

      if (isReferenceGenerationRunning(request.params.id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，暂时不能删除。' });
        return;
      }

      await deleteProject(request.params.id);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/run', async (request, response, next) => {
    try {
      const stage = request.body?.stage;

      if (!isRunStage(stage)) {
        response.status(400).json({ message: '无效的阶段标识。' });
        return;
      }

      try {
        await readProject(request.params.id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (isProjectRunning(request.params.id)) {
        response.status(409).json({ message: '该项目已有任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(request.params.id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      await enqueueProjectRun(request.params.id, stage);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/pause', async (request, response, next) => {
    try {
      try {
        await readProject(request.params.id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      await requestProjectRunPause(request.params.id);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/stop', async (request, response, next) => {
    try {
      try {
        await readProject(request.params.id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!isProjectRunning(request.params.id)) {
        response.status(409).json({ message: '该项目当前没有正在执行的任务。' });
        return;
      }

      await requestProjectRunStop(request.params.id);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/resume', async (request, response, next) => {
    try {
      try {
        await readProject(request.params.id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      await resumeProjectRun(request.params.id);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/continue', async (request, response, next) => {
    try {
      try {
        await readProject(request.params.id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (isProjectRunning(request.params.id)) {
        response.status(409).json({ message: '该项目已有任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(request.params.id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      await continueProjectRun(request.params.id);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/reference-library/:kind/:itemId/generate', async (request, response, next) => {
    try {
      const { id, kind, itemId } = request.params;

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目已有参考资产在生成。' });
        return;
      }

      const useReferenceImage =
        typeof request.body?.useReferenceImage === 'boolean' ? request.body.useReferenceImage === true : undefined;
      const ethnicityHint =
        typeof request.body?.ethnicityHint === 'string' ? String(request.body.ethnicityHint).trim() : undefined;

      await enqueueReferenceGeneration(id, kind, itemId, String(request.body?.prompt ?? ''), {
        useReferenceImage,
        ethnicityHint
      });
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id/reference-library/:kind/:itemId/reference-image', async (request, response, next) => {
    try {
      const { id, kind, itemId } = request.params;

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目已有参考资产在生成。' });
        return;
      }

      response.json(
        await uploadReferenceImageForAsset(id, kind, itemId, parseImageUploadPayload(request.body ?? {}))
      );
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:id/reference-library/:kind/:itemId/reference-image', async (request, response, next) => {
    try {
      const { id, kind, itemId } = request.params;

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目已有参考资产在生成。' });
        return;
      }

      response.json(await removeReferenceImageForAsset(id, kind, itemId));
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id/reference-library/:kind/:itemId/reference-audio', async (request, response, next) => {
    try {
      const { id, kind, itemId } = request.params;

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      if (kind !== 'character') {
        response.status(400).json({ message: '只有角色资产支持上传参考音频。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目已有参考资产在生成。' });
        return;
      }

      response.json(
        await uploadReferenceAudioForAsset(id, kind, itemId, parseAudioUploadPayload(request.body ?? {}))
      );
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:id/reference-library/:kind/:itemId/reference-audio', async (request, response, next) => {
    try {
      const { id, kind, itemId } = request.params;

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      if (kind !== 'character') {
        response.status(400).json({ message: '只有角色资产支持移除参考音频。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目已有参考资产在生成。' });
        return;
      }

      response.json(await removeReferenceAudioForAsset(id, kind, itemId));
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id/reference-library/:kind/:itemId/select-library-asset', async (request, response, next) => {
    try {
      const { id, kind, itemId } = request.params;

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目已有参考资产在生成。' });
        return;
      }

      response.json(
        await selectLibraryAssetForReferenceItem(id, kind, itemId, {
          sourceProjectId: typeof request.body?.sourceProjectId === 'string' ? String(request.body.sourceProjectId) : '',
          sourceItemId: typeof request.body?.sourceItemId === 'string' ? String(request.body.sourceItemId) : '',
          sourceKind: isReferenceAssetKind(request.body?.sourceKind) ? request.body.sourceKind : undefined
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id/storyboard/:shotId/prompts', async (request, response, next) => {
    try {
      const { id, shotId } = request.params;

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      response.json(
        await updateStoryboardShotPrompts(id, shotId, {
          durationSeconds:
            request.body?.durationSeconds === undefined ? undefined : Number(request.body.durationSeconds),
          firstFramePrompt:
            typeof request.body?.firstFramePrompt === 'string' ? String(request.body.firstFramePrompt) : undefined,
          lastFramePrompt:
            typeof request.body?.lastFramePrompt === 'string' ? String(request.body.lastFramePrompt) : undefined,
          transitionHint:
            typeof request.body?.transitionHint === 'string' ? String(request.body.transitionHint) : undefined,
          videoPrompt:
            typeof request.body?.videoPrompt === 'string' ? String(request.body.videoPrompt) : undefined,
          backgroundSoundPrompt:
            typeof request.body?.backgroundSoundPrompt === 'string'
              ? String(request.body.backgroundSoundPrompt)
              : undefined,
          speechPrompt:
            typeof request.body?.speechPrompt === 'string' ? String(request.body.speechPrompt) : undefined
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id/storyboard/:shotId/reference-items/:kind/:itemId', async (request, response, next) => {
    try {
      const { id, shotId, kind, itemId } = request.params;
      const frameKind = isShotReferenceFrameKind(request.query?.frameKind)
        ? request.query.frameKind
        : 'start';

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      response.json(await addReferenceAssetToStoryboardShot(id, shotId, kind, itemId, frameKind));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/projects/:id/storyboard/:shotId/reference-items/:kind/:itemId', async (request, response, next) => {
    try {
      const { id, shotId, kind, itemId } = request.params;
      const frameKind = isShotReferenceFrameKind(request.query?.frameKind)
        ? request.query.frameKind
        : 'start';

      if (!isReferenceAssetKind(kind)) {
        response.status(400).json({ message: '无效的参考资产类型。' });
        return;
      }

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (!getReferenceCollection(project, kind).some((item) => item.id === itemId)) {
        response.status(404).json({ message: '参考资产不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      response.json(await removeReferenceAssetFromStoryboardShot(id, shotId, kind, itemId, frameKind));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/storyboard/:shotId/image/generate', async (request, response, next) => {
    try {
      const { id, shotId } = request.params;

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      await enqueueStoryboardShotImageGeneration(id, shotId);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/storyboard/:shotId/last-image/generate', async (request, response, next) => {
    try {
      const { id, shotId } = request.params;

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      await enqueueStoryboardShotLastImageGeneration(id, shotId);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id/storyboard/:shotId/image/select', async (request, response, next) => {
    try {
      const { id, shotId } = request.params;

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      response.json(
        await selectStoryboardShotImageVersion(
          id,
          shotId,
          typeof request.body?.relativePath === 'string' ? String(request.body.relativePath) : ''
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/projects/:id/storyboard/:shotId/video/generate', async (request, response, next) => {
    try {
      const { id, shotId } = request.params;

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      await enqueueStoryboardShotVideoGeneration(id, shotId);
      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/projects/:id/storyboard/:shotId/video/select', async (request, response, next) => {
    try {
      const { id, shotId } = request.params;

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.storyboard.some((shot) => shot.id === shotId)) {
        response.status(404).json({ message: '镜头不存在。' });
        return;
      }

      if (isProjectRunning(id)) {
        response.status(409).json({ message: '该项目已有阶段任务在运行。' });
        return;
      }

      if (isReferenceGenerationRunning(id)) {
        response.status(409).json({ message: '该项目有参考资产正在生成，请稍后再试。' });
        return;
      }

      response.json(
        await selectStoryboardShotVideoVersion(
          id,
          shotId,
          typeof request.body?.relativePath === 'string' ? String(request.body.relativePath) : ''
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/projects/:id/final-video/download', async (request, response, next) => {
    try {
      const { id } = request.params;

      let project: Project;
      try {
        project = await readProject(id);
      } catch {
        response.status(404).json({ message: '项目不存在。' });
        return;
      }

      if (!project.assets.finalVideo) {
        response.status(404).json({ message: '项目尚未生成最终成片。' });
        return;
      }

      const absolutePath = fromStorageRelative(project.assets.finalVideo.relativePath);
      if (!(await pathExists(absolutePath))) {
        response.status(404).json({ message: '最终成片文件不存在，请重新执行视频剪辑。' });
        return;
      }

      response.download(absolutePath, buildFinalVideoDownloadName(project), (error) => {
        if (error && !response.headersSent) {
          next(error);
        }
      });
    } catch (error) {
      next(error);
    }
  });

  const clientDist = path.resolve(appConfig.cwd, 'dist/client');
  if (await pathExists(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api') || request.path.startsWith('/storage')) {
        next();
        return;
      }

      response.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : '服务器内部错误';
    response.status(500).json({ message });
  });

  app.listen(appConfig.port, appConfig.host, () => {
    console.log(`Short drama generator server listening on http://${appConfig.host}:${appConfig.port}`);
  });
}

void main();
