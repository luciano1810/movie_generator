import { existsSync } from 'node:fs';
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
      imageWorkflowPath: normalizeWorkflowPath(settings.comfyui.imageWorkflowPath),
      videoWorkflowPath: normalizeWorkflowPath(settings.comfyui.videoWorkflowPath)
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
  return {
    llmConfigured: Boolean(settings.llm.baseUrl && settings.llm.apiKey && settings.llm.model),
    comfyuiConfigured: Boolean(settings.comfyui.baseUrl),
    imageWorkflowExists: Boolean(
      settings.comfyui.imageWorkflowPath && existsSync(settings.comfyui.imageWorkflowPath)
    ),
    videoWorkflowExists: Boolean(
      settings.comfyui.videoWorkflowPath && existsSync(settings.comfyui.videoWorkflowPath)
    ),
    ffmpegReady: Boolean(settings.ffmpeg.binaryPath)
  };
}
