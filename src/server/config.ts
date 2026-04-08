import path from 'node:path';
import dotenv from 'dotenv';
import ffmpegStatic from 'ffmpeg-static';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types.js';
import { DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS } from '../shared/workflow-templates.js';

dotenv.config();

const cwd = process.cwd();
const resolvedFfmpegPath = typeof ffmpegStatic === 'string' ? ffmpegStatic : '';

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function resolveMaybeRelative(value: string | undefined, fallbackRelativePath: string): string {
  const chosen = value && value.trim() ? value.trim() : fallbackRelativePath;
  return path.isAbsolute(chosen) ? chosen : path.resolve(cwd, chosen);
}

export const appConfig = {
  cwd,
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '0.0.0.0',
  storageRoot: path.resolve(cwd, 'storage'),
  uiOrigin: process.env.UI_ORIGIN ?? 'http://127.0.0.1:5173',
  settingsFile: path.resolve(cwd, '.shortdrama-generator.settings.json')
};

export const envAppSettingsDefaults: AppSettings = {
  llm: {
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  },
  gemini: {
    baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: process.env.GEMINI_API_KEY ?? ''
  },
  comfyui: {
    baseUrl: process.env.COMFYUI_BASE_URL ?? 'http://100.100.8.2:8188',
    installPath: process.env.COMFYUI_PATH ? resolveMaybeRelative(process.env.COMFYUI_PATH, process.env.COMFYUI_PATH) : '',
    environmentType:
      process.env.COMFYUI_ENV_TYPE === 'venv' || process.env.COMFYUI_ENV_TYPE === 'conda'
        ? process.env.COMFYUI_ENV_TYPE
        : process.env.COMFYUI_PYTHON_PATH
          ? 'venv'
          : process.env.COMFYUI_CONDA_PREFIX || process.env.COMFYUI_CONDA_ENV
            ? 'conda'
        : '',
    environmentId:
      process.env.COMFYUI_ENV_ID ??
      process.env.COMFYUI_PYTHON_PATH ??
      process.env.COMFYUI_CONDA_PREFIX ??
      process.env.COMFYUI_CONDA_ENV ??
      '',
    autoStart: parseBooleanEnv(process.env.COMFYUI_AUTO_START, true),
    workflows: {
      character_asset: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_CHARACTER_ASSET_WORKFLOW ??
            process.env.COMFYUI_CHARACTER_WORKFLOW ??
            process.env.COMFYUI_IMAGE_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.character_asset
        )
      },
      storyboard_image: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_STORYBOARD_IMAGE_WORKFLOW ??
            process.env.COMFYUI_IMAGE_EDIT_WORKFLOW ??
            process.env.COMFYUI_STORYBOARD_WORKFLOW ??
            process.env.COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.storyboard_image
        )
      },
      text_to_image: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_TEXT_TO_IMAGE_WORKFLOW ??
            process.env.COMFYUI_SCENE_WORKFLOW ??
            process.env.COMFYUI_OBJECT_WORKFLOW ??
            process.env.COMFYUI_IMAGE_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.text_to_image
        )
      },
      reference_image_to_image: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW ??
            process.env.COMFYUI_STORYBOARD_WORKFLOW ??
            process.env.COMFYUI_IMAGE_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.reference_image_to_image
        )
      },
      image_edit: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_IMAGE_EDIT_WORKFLOW ?? process.env.COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.image_edit
        )
      },
      text_to_video: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_TEXT_TO_VIDEO_WORKFLOW ?? process.env.COMFYUI_VIDEO_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.text_to_video
        )
      },
      image_to_video_first_last: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_IMAGE_TO_VIDEO_FIRST_LAST_WORKFLOW ??
            process.env.COMFYUI_IMAGE_TO_VIDEO_WORKFLOW ??
            process.env.COMFYUI_VIDEO_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.image_to_video_first_last
        )
      },
      image_to_video_first_frame: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_IMAGE_TO_VIDEO_FIRST_FRAME_WORKFLOW ??
            process.env.COMFYUI_IMAGE_TO_VIDEO_WORKFLOW ??
            process.env.COMFYUI_VIDEO_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.image_to_video_first_frame
        )
      },
      tts: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_TTS_WORKFLOW,
          DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS.tts
        )
      }
    },
    pollIntervalMs: Number(process.env.COMFYUI_POLL_INTERVAL_MS ?? 3000),
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS ?? 1_800_000),
    maxVideoSegmentDurationSeconds: Number(
      process.env.COMFYUI_MAX_VIDEO_SEGMENT_DURATION_SECONDS ?? DEFAULT_SETTINGS.maxVideoSegmentDurationSeconds
    )
  },
  ffmpeg: {
    binaryPath: process.env.FFMPEG_PATH ?? resolvedFfmpegPath
  }
};

export function toStorageRelative(absolutePath: string): string {
  return path.relative(appConfig.storageRoot, absolutePath).split(path.sep).join('/');
}

export function fromStorageRelative(relativePath: string): string {
  return path.resolve(appConfig.storageRoot, relativePath);
}
