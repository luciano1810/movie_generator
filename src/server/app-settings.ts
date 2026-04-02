import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AppSettings,
  COMFYUI_WORKFLOW_TYPES,
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
  const workflows = Object.fromEntries(
    COMFYUI_WORKFLOW_TYPES.map((workflowType) => [
      workflowType,
      {
        ...settings.comfyui.workflows[workflowType],
        workflowPath: normalizeWorkflowPath(settings.comfyui.workflows[workflowType].workflowPath)
      }
    ])
  ) as AppSettings['comfyui']['workflows'];

  return {
    ...settings,
    comfyui: {
      ...settings.comfyui,
      workflows
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
  const placeholderMarkers = [
    'ReplaceMeWithYourVideoWorkflow',
    'ReplaceWithYourCheckpointInWorkflow',
    'ReplaceWithNarratorReferenceAudio.wav',
    'ReplaceWithSpeaker1ReferenceAudio.wav',
    'ReplaceWithSpeaker2ReferenceAudio.wav',
    'ReplaceWithYourPreferredVoiceDesignNode'
  ];
  const workflowExists = (workflowPath: string): boolean => {
    if (!workflowPath || !existsSync(workflowPath)) {
      return false;
    }

    try {
      const content = readFileSync(workflowPath, 'utf8');
      return !placeholderMarkers.some((marker) => content.includes(marker));
    } catch {
      return false;
    }
  };

  return {
    llmConfigured: Boolean(settings.llm.baseUrl && settings.llm.apiKey && settings.llm.model),
    geminiConfigured: Boolean(settings.gemini.baseUrl && settings.gemini.apiKey),
    comfyuiConfigured: Boolean(settings.comfyui.baseUrl),
    characterAssetWorkflowExists: workflowExists(settings.comfyui.workflows.character_asset.workflowPath),
    storyboardImageWorkflowExists: workflowExists(settings.comfyui.workflows.storyboard_image.workflowPath),
    textToImageWorkflowExists: workflowExists(settings.comfyui.workflows.text_to_image.workflowPath),
    referenceImageToImageWorkflowExists: workflowExists(
      settings.comfyui.workflows.reference_image_to_image.workflowPath
    ),
    imageEditWorkflowExists: workflowExists(settings.comfyui.workflows.image_edit.workflowPath),
    textToVideoWorkflowExists: workflowExists(settings.comfyui.workflows.text_to_video.workflowPath),
    imageToVideoFirstLastWorkflowExists: workflowExists(
      settings.comfyui.workflows.image_to_video_first_last.workflowPath
    ),
    imageToVideoFirstFrameWorkflowExists: workflowExists(
      settings.comfyui.workflows.image_to_video_first_frame.workflowPath
    ),
    ttsWorkflowExists: workflowExists(settings.comfyui.workflows.tts.workflowPath),
    ffmpegReady: Boolean(settings.ffmpeg.binaryPath && existsSync(settings.ffmpeg.binaryPath))
  };
}
