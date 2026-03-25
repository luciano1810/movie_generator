import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type Project,
  type ProjectSettings,
  createStageStateMap,
  normalizeSettings
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
    mkdir(resolveProjectPath(projectId, 'output'), { recursive: true })
  ]);
}

export async function readProject(projectId: string): Promise<Project> {
  const file = getProjectFile(projectId);
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw) as Project;
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
      videos: [],
      finalVideo: null
    },
    artifacts: {
      scriptMarkdown: null,
      scriptJson: null,
      storyboardJson: null
    },
    logs: [],
    runState: {
      isRunning: false,
      requestedStage: null,
      currentStage: null,
      startedAt: null
    }
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
