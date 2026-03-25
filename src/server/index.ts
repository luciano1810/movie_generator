import { access } from 'node:fs/promises';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import {
  type AppSettings,
  type AppMeta,
  type RunStage,
  DEFAULT_SETTINGS,
  STAGES,
  STAGE_LABELS
} from '../shared/types.js';
import { appConfig } from './config.js';
import { getAppSettings, getRuntimeStatus, initializeAppSettings, updateAppSettings } from './app-settings.js';
import { ensureStorage, createProject, listProjects, readProject, updateProject } from './storage.js';
import { enqueueProjectRun, isProjectRunning } from './pipeline.js';

function isRunStage(value: unknown): value is RunStage {
  return value === 'all' || (typeof value === 'string' && STAGES.includes(value as (typeof STAGES)[number]));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await ensureStorage();
  await initializeAppSettings();

  const app = express();
  app.use(
    cors({
      origin: true
    })
  );
  app.use(express.json({ limit: '8mb' }));
  app.use('/storage', express.static(appConfig.storageRoot));

  app.get('/api/meta', (_request, response) => {
    const appSettings = getAppSettings();
    const meta: AppMeta = {
      defaults: DEFAULT_SETTINGS,
      stages: STAGES.map((stage) => ({
        id: stage,
        label: STAGE_LABELS[stage]
      })),
      envStatus: getRuntimeStatus(appSettings),
      workflowPaths: {
        image: appSettings.comfyui.imageWorkflowPath,
        video: appSettings.comfyui.videoWorkflowPath
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

  app.post('/api/projects/:id/run', async (request, response, next) => {
    try {
      const stage = request.body?.stage;

      if (!isRunStage(stage)) {
        response.status(400).json({ message: '无效的阶段标识。' });
        return;
      }

      if (isProjectRunning(request.params.id)) {
        response.status(409).json({ message: '该项目已有任务在运行。' });
        return;
      }

      await enqueueProjectRun(request.params.id, stage);
      response.status(202).json({ ok: true });
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
