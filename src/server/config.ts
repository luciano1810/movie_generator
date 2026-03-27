import path from 'node:path';
import dotenv from 'dotenv';
import ffmpegStatic from 'ffmpeg-static';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types.js';

dotenv.config();

const cwd = process.cwd();
const resolvedFfmpegPath = typeof ffmpegStatic === 'string' ? ffmpegStatic : '';

export function resolveMaybeRelative(value: string | undefined, fallbackRelativePath: string): string {
  const chosen = value && value.trim() ? value.trim() : fallbackRelativePath;
  return path.isAbsolute(chosen) ? chosen : path.resolve(cwd, chosen);
}

export const appConfig = {
  cwd,
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '127.0.0.1',
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
  comfyui: {
    baseUrl: process.env.COMFYUI_BASE_URL ?? 'http://100.100.8.2:8188',
    workflows: {
      character_asset: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_CHARACTER_ASSET_WORKFLOW ??
            process.env.COMFYUI_CHARACTER_WORKFLOW ??
            process.env.COMFYUI_IMAGE_WORKFLOW,
          'config/workflows/firered-image-edit-1.1_api.template.json'
        )
      },
      storyboard_image: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_STORYBOARD_IMAGE_WORKFLOW ??
            process.env.COMFYUI_IMAGE_EDIT_WORKFLOW ??
            process.env.COMFYUI_STORYBOARD_WORKFLOW ??
            process.env.COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW,
          'config/workflows/storyboard-image-edit-3ref.template.json'
        )
      },
      text_to_image: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_TEXT_TO_IMAGE_WORKFLOW ??
            process.env.COMFYUI_SCENE_WORKFLOW ??
            process.env.COMFYUI_OBJECT_WORKFLOW ??
            process.env.COMFYUI_IMAGE_WORKFLOW,
          'config/workflows/image-workflow.template.json'
        )
      },
      reference_image_to_image: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW ??
            process.env.COMFYUI_STORYBOARD_WORKFLOW ??
            process.env.COMFYUI_IMAGE_WORKFLOW,
          'config/workflows/image-workflow.template.json'
        )
      },
      image_edit: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_IMAGE_EDIT_WORKFLOW ?? process.env.COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW,
          'config/workflows/firered-image-edit-1.1_api.template.json'
        )
      },
      text_to_video: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_TEXT_TO_VIDEO_WORKFLOW ?? process.env.COMFYUI_VIDEO_WORKFLOW,
          'config/workflows/video-workflow.template.json'
        )
      },
      image_to_video: {
        workflowPath: resolveMaybeRelative(
          process.env.COMFYUI_IMAGE_TO_VIDEO_WORKFLOW ?? process.env.COMFYUI_VIDEO_WORKFLOW,
          'config/workflows/ltx_2.3_ti2v_api.template.json'
        )
      },
      tts: {
        workflowPath: process.env.COMFYUI_TTS_WORKFLOW
          ? resolveMaybeRelative(process.env.COMFYUI_TTS_WORKFLOW, process.env.COMFYUI_TTS_WORKFLOW)
          : ''
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
