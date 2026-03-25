import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AppSettings,
  type RuntimeStatus,
  normalizeAppSettings
} from '../shared/types.js';
import { appConfig, envAppSettingsDefaults, resolveMaybeRelative } from './config.js';

let currentAppSettings: AppSettings | null = null;

function normalizeWorkflowPath(value: string): string {
  if (!value) {
    return '';
  }

  return resolveMaybeRelative(value, value);
}

function normalizeRuntimePaths(settings: AppSettings): AppSettings {
  return {
    ...settings,
    comfyui: {
      ...settings.comfyui,
      workflows: {
        character: {
          ...settings.comfyui.workflows.character,
          workflowPath: normalizeWorkflowPath(settings.comfyui.workflows.character.workflowPath)
        },
        scene: {
          ...settings.comfyui.workflows.scene,
          workflowPath: normalizeWorkflowPath(settings.comfyui.workflows.scene.workflowPath)
        },
        object: {
          ...settings.comfyui.workflows.object,
          workflowPath: normalizeWorkflowPath(settings.comfyui.workflows.object.workflowPath)
        },
        storyboard: {
          ...settings.comfyui.workflows.storyboard,
          workflowPath: normalizeWorkflowPath(settings.comfyui.workflows.storyboard.workflowPath)
        },
        video: {
          ...settings.comfyui.workflows.video,
          workflowPath: normalizeWorkflowPath(settings.comfyui.workflows.video.workflowPath)
        },
        tts: {
          ...settings.comfyui.workflows.tts,
          workflowPath: normalizeWorkflowPath(settings.comfyui.workflows.tts.workflowPath)
        }
      }
    }
  };
}

async function persistSettings(settings: AppSettings): Promise<void> {
  await mkdir(dirname(appConfig.settingsFile), { recursive: true });
  await writeFile(appConfig.settingsFile, JSON.stringify(settings, null, 2), 'utf8');
}

export async function initializeAppSettings(): Promise<AppSettings> {
  if (existsSync(appConfig.settingsFile)) {
    const raw = await readFile(appConfig.settingsFile, 'utf8');
    currentAppSettings = normalizeRuntimePaths(
      normalizeAppSettings(JSON.parse(raw) as Partial<AppSettings>, envAppSettingsDefaults)
    );
    return currentAppSettings;
  }

  currentAppSettings = normalizeRuntimePaths(envAppSettingsDefaults);
  await persistSettings(currentAppSettings);
  return currentAppSettings;
}

export function getAppSettings(): AppSettings {
  if (!currentAppSettings) {
    currentAppSettings = normalizeRuntimePaths(envAppSettingsDefaults);
  }

  return currentAppSettings;
}

export async function updateAppSettings(input: Partial<AppSettings>): Promise<AppSettings> {
  const nextSettings = normalizeRuntimePaths(normalizeAppSettings(input, getAppSettings()));
  currentAppSettings = nextSettings;
  await persistSettings(nextSettings);
  return nextSettings;
}

export function getRuntimeStatus(settings = getAppSettings()): RuntimeStatus {
  const workflowExists = (workflowPath: string): boolean => {
    if (!workflowPath || !existsSync(workflowPath)) {
      return false;
    }

    try {
      const content = readFileSync(workflowPath, 'utf8');
      return !content.includes('ReplaceMeWithYourVideoWorkflow');
    } catch {
      return false;
    }
  };

  return {
    llmConfigured: Boolean(settings.llm.baseUrl && settings.llm.apiKey && settings.llm.model),
    comfyuiConfigured: Boolean(settings.comfyui.baseUrl),
    characterWorkflowExists: workflowExists(settings.comfyui.workflows.character.workflowPath),
    sceneWorkflowExists: workflowExists(settings.comfyui.workflows.scene.workflowPath),
    objectWorkflowExists: workflowExists(settings.comfyui.workflows.object.workflowPath),
    storyboardWorkflowExists: workflowExists(settings.comfyui.workflows.storyboard.workflowPath),
    videoWorkflowExists: workflowExists(settings.comfyui.workflows.video.workflowPath),
    ttsWorkflowExists: workflowExists(settings.comfyui.workflows.tts.workflowPath),
    ffmpegReady: Boolean(settings.ffmpeg.binaryPath && existsSync(settings.ffmpeg.binaryPath))
  };
}
