import path from 'node:path';
import dotenv from 'dotenv';
import ffmpegStatic from 'ffmpeg-static';
import type { AppSettings } from '../shared/types.js';

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
    baseUrl: process.env.COMFYUI_BASE_URL ?? 'http://127.0.0.1:8188',
    imageWorkflowPath: resolveMaybeRelative(
      process.env.COMFYUI_IMAGE_WORKFLOW,
      'config/workflows/image-workflow.template.json'
    ),
    videoWorkflowPath: resolveMaybeRelative(
      process.env.COMFYUI_VIDEO_WORKFLOW,
      'config/workflows/video-workflow.template.json'
    ),
    imageCheckpointName: process.env.COMFYUI_IMAGE_CHECKPOINT ?? '',
    videoCheckpointName: process.env.COMFYUI_VIDEO_CHECKPOINT ?? '',
    pollIntervalMs: Number(process.env.COMFYUI_POLL_INTERVAL_MS ?? 3000),
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS ?? 1_800_000)
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
