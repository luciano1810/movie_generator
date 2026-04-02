import type { AspectRatio } from '../shared/types.js';
import { getAppSettings } from './app-settings.js';

export interface GeminiInputImage {
  buffer: Buffer;
  mimeType: string;
}

export interface GeminiGeneratedImage {
  buffer: Buffer;
  mimeType: string;
}

interface GenerateGeminiImageOptions {
  model: string;
  prompt: string;
  aspectRatio: AspectRatio;
  referenceImages?: GeminiInputImage[];
  signal?: AbortSignal;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/g, '');
}

function normalizeModel(model: string): string {
  return model.trim().replace(/^models\//, '');
}

function buildGenerateContentUrl(baseUrl: string, model: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models/${normalizeModel(model)}:generateContent`;
}

function pickInlineData(part: unknown): { mimeType?: string; data?: string } | null {
  if (!part || typeof part !== 'object') {
    return null;
  }

  const inlineData = (part as { inlineData?: unknown }).inlineData;
  if (inlineData && typeof inlineData === 'object') {
    return inlineData as { mimeType?: string; data?: string };
  }

  const inlineDataSnakeCase = (part as { inline_data?: unknown }).inline_data;
  if (inlineDataSnakeCase && typeof inlineDataSnakeCase === 'object') {
    const candidate = inlineDataSnakeCase as { mime_type?: string; data?: string };
    return {
      mimeType: candidate.mime_type,
      data: candidate.data
    };
  }

  return null;
}

function extractGeneratedImage(payload: unknown): GeminiGeneratedImage {
  const candidates = Array.isArray((payload as { candidates?: unknown[] })?.candidates)
    ? ((payload as { candidates: unknown[] }).candidates ?? [])
    : [];

  for (const candidate of candidates) {
    const parts = Array.isArray((candidate as { content?: { parts?: unknown[] } })?.content?.parts)
      ? ((candidate as { content: { parts: unknown[] } }).content.parts ?? [])
      : [];

    for (const part of parts) {
      const inlineData = pickInlineData(part);
      if (!inlineData?.data) {
        continue;
      }

      return {
        buffer: Buffer.from(inlineData.data, 'base64'),
        mimeType: inlineData.mimeType?.trim() || 'image/png'
      };
    }
  }

  throw new Error('Gemini 未返回图片数据。');
}

function buildErrorMessage(status: number, payload: unknown): string {
  const errorMessage =
    typeof (payload as { error?: { message?: unknown } })?.error?.message === 'string'
      ? String((payload as { error: { message: string } }).error.message)
      : '';

  if (errorMessage) {
    return errorMessage;
  }

  return `Gemini 图片生成失败: HTTP ${status}`;
}

export async function generateImageWithGemini(
  options: GenerateGeminiImageOptions
): Promise<GeminiGeneratedImage> {
  const settings = getAppSettings();
  const baseUrl = settings.gemini.baseUrl.trim();
  const apiKey = settings.gemini.apiKey.trim();

  if (!baseUrl || !apiKey) {
    throw new Error('系统设置中未配置 Gemini API 地址或 Key。');
  }

  const response = await fetch(buildGenerateContentUrl(baseUrl, options.model), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`
    },
    signal: options.signal,
    body: JSON.stringify({
      contents: [
        {
          parts: [
            ...(options.referenceImages ?? []).map((image) => ({
              inline_data: {
                mime_type: image.mimeType,
                data: image.buffer.toString('base64')
              }
            })),
            {
              text: options.prompt
            }
          ]
        }
      ],
      generationConfig: {
        imageConfig: {
          aspectRatio: options.aspectRatio
        }
      }
    })
  });

  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(buildErrorMessage(response.status, payload));
  }

  return extractGeneratedImage(payload);
}
