import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type GeneratedAsset,
  type ReferenceAssetItem,
  type Project,
  type ProjectRunState,
  type ProjectSettings,
  type ShotAssetHistoryMap,
  createIdleRunState,
  createEmptyReferenceLibrary,
  createStageStateMap,
  normalizeSettings,
  normalizeStoryboardShots
} from '../shared/types.js';
import { appConfig, toStorageRelative } from './config.js';

const PROJECTS_ROOT = path.join(appConfig.storageRoot, 'projects');
const PROJECT_FILENAME = 'project.json';

function now(): string {
  return new Date().toISOString();
}

export async function ensureStorage(): Promise<void> {
  await mkdir(PROJECTS_ROOT, { recursive: true });
}

export function getProjectDir(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId);
}

export function getProjectFile(projectId: string): string {
  return path.join(getProjectDir(projectId), PROJECT_FILENAME);
}

export function resolveProjectPath(projectId: string, ...parts: string[]): string {
  return path.join(getProjectDir(projectId), ...parts);
}

async function ensureProjectLayout(projectId: string): Promise<void> {
  await Promise.all([
    mkdir(resolveProjectPath(projectId), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'script'), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'storyboard'), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'images'), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'videos'), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'references', 'characters'), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'references', 'scenes'), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'references', 'objects'), { recursive: true }),
    mkdir(resolveProjectPath(projectId, 'output'), { recursive: true })
  ]);
}

function hydrateReferenceAssetItem(item: ReferenceAssetItem): ReferenceAssetItem {
  return {
    ...item,
    ethnicityHint: item.ethnicityHint ?? '',
    error: item.error ?? null,
    referenceImage: item.referenceImage ?? null,
    referenceAudio: item.referenceAudio ?? null,
    asset: item.asset ?? null,
    assetHistory: item.assetHistory ?? []
  };
}

function hydrateGeneratedAsset(asset: GeneratedAsset | null | undefined): GeneratedAsset | null {
  if (!asset?.relativePath) {
    return null;
  }

  return {
    shotId: asset.shotId ?? null,
    sceneNumber: asset.sceneNumber ?? null,
    relativePath: asset.relativePath,
    prompt: asset.prompt ?? '',
    createdAt: asset.createdAt ?? now()
  };
}

function hydrateGeneratedAssetList(assets: Array<GeneratedAsset | undefined> | undefined): GeneratedAsset[] {
  return (assets ?? [])
    .map((asset) => hydrateGeneratedAsset(asset))
    .filter((asset): asset is GeneratedAsset => asset !== null);
}

function hydrateShotAssetHistoryMap(history: ShotAssetHistoryMap | undefined): ShotAssetHistoryMap {
  return Object.fromEntries(
    Object.entries(history ?? {}).map(([shotId, assets]) => [shotId, hydrateGeneratedAssetList(assets)])
  );
}

function hydrateProjectRunState(runState: ProjectRunState | undefined): ProjectRunState {
  const fallback = createIdleRunState();

  return {
    isRunning: runState?.isRunning ?? fallback.isRunning,
    requestedStage: runState?.requestedStage ?? fallback.requestedStage,
    currentStage: runState?.currentStage ?? fallback.currentStage,
    startedAt: runState?.startedAt ?? fallback.startedAt,
    pauseRequested: runState?.pauseRequested ?? fallback.pauseRequested,
    stopRequested: runState?.stopRequested ?? fallback.stopRequested,
    isPaused: runState?.isPaused ?? fallback.isPaused
  };
}

function hydrateProject(project: Project): Project {
  const settings = normalizeSettings(project.settings);
  const defaultStages = createStageStateMap();
  const rawStages = project.stages ?? {};
  const stages = Object.fromEntries(
    Object.entries(defaultStages).map(([stageId, fallbackState]) => {
      const currentState = rawStages[stageId as keyof typeof rawStages];

      return [
        stageId,
        {
          status: currentState?.status ?? fallbackState.status,
          startedAt: currentState?.startedAt ?? fallbackState.startedAt,
          finishedAt: currentState?.finishedAt ?? fallbackState.finishedAt,
          error: currentState?.error ?? fallbackState.error
        }
      ];
    })
  ) as Project['stages'];

  return {
    ...project,
    settings,
    stages,
    storyboard: normalizeStoryboardShots(project.storyboard ?? [], settings),
    assets: {
      images: hydrateGeneratedAssetList(project.assets?.images),
      imageHistory: hydrateShotAssetHistoryMap(project.assets?.imageHistory),
      videos: hydrateGeneratedAssetList(project.assets?.videos),
      videoHistory: hydrateShotAssetHistoryMap(project.assets?.videoHistory),
      finalVideo: hydrateGeneratedAsset(project.assets?.finalVideo) ?? null
    },
    referenceLibrary: {
      characters: (project.referenceLibrary?.characters ?? []).map(hydrateReferenceAssetItem),
      scenes: (project.referenceLibrary?.scenes ?? []).map(hydrateReferenceAssetItem),
      objects: (project.referenceLibrary?.objects ?? []).map(hydrateReferenceAssetItem)
    },
    artifacts: {
      scriptMarkdown: project.artifacts?.scriptMarkdown ?? null,
      scriptJson: project.artifacts?.scriptJson ?? null,
      storyboardJson: project.artifacts?.storyboardJson ?? null,
      referenceLibraryJson: project.artifacts?.referenceLibraryJson ?? null
    },
    logs: project.logs ?? [],
    runState: hydrateProjectRunState(project.runState)
  };
}

export async function readProject(projectId: string): Promise<Project> {
  const file = getProjectFile(projectId);
  const raw = await readFile(file, 'utf8');
  return hydrateProject(JSON.parse(raw) as Project);
}

export async function writeProject(project: Project): Promise<void> {
  await ensureProjectLayout(project.id);
  await writeFile(getProjectFile(project.id), JSON.stringify(project, null, 2), 'utf8');
}

export async function listProjects(): Promise<Project[]> {
  await ensureStorage();
  const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await readProject(entry.name);
        } catch {
          return null;
        }
      })
  );

  return projects
    .filter((project): project is Project => project !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function clearInterruptedRunStates(): Promise<number> {
  const projects = await listProjects();
  let repairedCount = 0;

  for (const project of projects) {
    if (!project.runState.isRunning) {
      continue;
    }

    project.runState = createIdleRunState();
    project.logs = [
      ...project.logs,
      {
        id: crypto.randomUUID(),
        level: 'warn' as const,
        message: '检测到服务重启或任务异常中断，已自动重置运行状态。',
        createdAt: now()
      }
    ].slice(-300);
    project.updatedAt = now();
    await writeProject(project);
    repairedCount += 1;
  }

  return repairedCount;
}

export async function createProject(input: {
  title: string;
  sourceText: string;
  settings?: Partial<ProjectSettings>;
}): Promise<Project> {
  await ensureStorage();

  const id = `proj-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const timestamp = now();
  const project: Project = {
    id,
    title: input.title.trim() || '未命名短剧项目',
    sourceText: input.sourceText.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    settings: normalizeSettings(input.settings),
    stages: createStageStateMap(),
    script: null,
    storyboard: [],
    assets: {
      images: [],
      imageHistory: {},
      videos: [],
      videoHistory: {},
      finalVideo: null
    },
    referenceLibrary: createEmptyReferenceLibrary(),
    artifacts: {
      scriptMarkdown: null,
      scriptJson: null,
      storyboardJson: null,
      referenceLibraryJson: null
    },
    logs: [],
    runState: createIdleRunState()
  };

  await writeProject(project);
  return project;
}

export async function updateProject(
  projectId: string,
  input: {
    title?: string;
    sourceText?: string;
    settings?: Partial<ProjectSettings>;
  }
): Promise<Project> {
  const project = await readProject(projectId);
  project.title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : project.title;
  project.sourceText =
    typeof input.sourceText === 'string' ? input.sourceText : project.sourceText;
  project.settings = normalizeSettings({
    ...project.settings,
    ...(input.settings ?? {})
  });
  project.updatedAt = now();
  await writeProject(project);
  return project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await readProject(projectId);
  await rm(getProjectDir(projectId), { recursive: true, force: true });
}

export async function writeProjectFile(
  projectId: string,
  relativePath: string,
  content: string | Buffer
): Promise<{ absolutePath: string; relativePath: string }> {
  const absolutePath = resolveProjectPath(projectId, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  return {
    absolutePath,
    relativePath: toStorageRelative(absolutePath)
  };
}
