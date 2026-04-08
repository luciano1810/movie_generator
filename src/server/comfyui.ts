import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAppSettings } from './app-settings.js';
import { ensureComfyuiReady } from './comfyui-runtime.js';

export interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

interface ComfyRequestOptions {
  signal?: AbortSignal;
}

export type TemplateVariable =
  | string
  | number
  | boolean
  | null
  | TemplateVariable[]
  | { [key: string]: TemplateVariable };

function fillTemplateValue(value: unknown, variables: Record<string, TemplateVariable>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => fillTemplateValue(item, variables));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillTemplateValue(item, variables)])
    );
  }

  if (typeof value !== 'string') {
    return value;
  }

  const exactMatch = value.match(/^{{\s*([a-zA-Z0-9_]+)\s*}}$/);
  if (exactMatch) {
    const replacement = variables[exactMatch[1]];
    return replacement ?? value;
  }

  return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => {
    const replacement = variables[key];
    return replacement === undefined ? '' : String(replacement);
  });
}

async function loadWorkflowTemplate(templatePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(templatePath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return parsed;
}

export async function prepareComfyWorkflow(
  templatePath: string,
  variables: Record<string, TemplateVariable>
): Promise<Record<string, unknown>> {
  return fillTemplateValue(await loadWorkflowTemplate(templatePath), variables) as Record<string, unknown>;
}

function createAbortError(): Error {
  const error = new Error('操作已中止。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);

    const handleAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
      reject(createAbortError());
    };

    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function collectOutputFiles(historyItem: Record<string, any>): ComfyOutputFile[] {
  const outputs = historyItem.outputs ?? {};
  const collected: ComfyOutputFile[] = [];

  Object.values(outputs).forEach((nodeOutput) => {
    if (!nodeOutput || typeof nodeOutput !== 'object') {
      return;
    }

    Object.values(nodeOutput).forEach((value) => {
      if (!Array.isArray(value)) {
        return;
      }

      value.forEach((entry) => {
        if (entry && typeof entry === 'object' && 'filename' in entry) {
          collected.push({
            filename: String(entry.filename),
            subfolder: String(entry.subfolder ?? ''),
            type: String(entry.type ?? 'output')
          });
        }
      });
    });
  });

  return collected.filter(
    (file, index, array) =>
      array.findIndex(
        (candidate) =>
          candidate.filename === file.filename &&
          candidate.subfolder === file.subfolder &&
          candidate.type === file.type
      ) === index
  );
}

async function waitForHistory(promptId: string, options: ComfyRequestOptions = {}): Promise<Record<string, any>> {
  const settings = getAppSettings();
  const startedAt = Date.now();
  const signal = options.signal;

  while (Date.now() - startedAt < settings.comfyui.timeoutMs) {
    throwIfAborted(signal);

    const response = await fetch(`${settings.comfyui.baseUrl}/history/${promptId}`, {
      signal
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`查询 ComfyUI 历史记录失败: ${message}`);
    }

    const history = (await response.json()) as Record<string, any>;
    const item = history[promptId];

    if (item) {
      return item;
    }

    await delayWithSignal(settings.comfyui.pollIntervalMs, signal);
  }

  throw new Error(`ComfyUI 任务超时，prompt_id=${promptId}`);
}

export async function runComfyWorkflow(
  templatePath: string,
  variables: Record<string, TemplateVariable>,
  options: ComfyRequestOptions = {}
): Promise<ComfyOutputFile[]> {
  const settings = getAppSettings();
  const workflow = await prepareComfyWorkflow(templatePath, variables);
  const clientId = crypto.randomUUID();
  const signal = options.signal;

  throwIfAborted(signal);
  await ensureComfyuiReady();

  const response = await fetch(`${settings.comfyui.baseUrl}/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    signal,
    body: JSON.stringify({
      client_id: clientId,
      prompt: workflow
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`提交 ComfyUI 任务失败: ${message}`);
  }

  const data = (await response.json()) as { prompt_id?: string };

  if (!data.prompt_id) {
    throw new Error('ComfyUI 没有返回 prompt_id。');
  }

  const historyItem = await waitForHistory(data.prompt_id, options);
  const outputFiles = collectOutputFiles(historyItem);

  if (!outputFiles.length) {
    throw new Error('ComfyUI 执行完成，但没有找到输出文件。');
  }

  return outputFiles;
}

export async function fetchComfyOutputFile(file: ComfyOutputFile, options: ComfyRequestOptions = {}): Promise<Buffer> {
  const settings = getAppSettings();
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type
  });

  throwIfAborted(options.signal);
  await ensureComfyuiReady();

  const response = await fetch(`${settings.comfyui.baseUrl}/view?${params.toString()}`, {
    signal: options.signal
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`下载 ComfyUI 输出失败: ${message}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function uploadImageToComfy(localPath: string, options: ComfyRequestOptions = {}): Promise<string> {
  const buffer = await readFile(localPath);
  const filename = path.basename(localPath);
  return uploadImageBufferToComfy(buffer, filename, options);
}

async function uploadInputBufferToComfy(
  buffer: Buffer,
  filename: string,
  options: ComfyRequestOptions = {}
): Promise<string> {
  const settings = getAppSettings();
  const binary = new Uint8Array(buffer);
  const form = new FormData();

  form.set('image', new Blob([binary]), filename);
  form.set('overwrite', 'true');

  throwIfAborted(options.signal);
  await ensureComfyuiReady();

  const response = await fetch(`${settings.comfyui.baseUrl}/upload/image`, {
    method: 'POST',
    body: form,
    signal: options.signal
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`上传图片到 ComfyUI 失败: ${message}`);
  }

  const data = (await response.json()) as { name?: string; filename?: string };
  return data.name ?? data.filename ?? filename;
}

export async function uploadImageBufferToComfy(
  buffer: Buffer,
  filename: string,
  options: ComfyRequestOptions = {}
): Promise<string> {
  return uploadInputBufferToComfy(buffer, filename, options);
}

export async function uploadAudioToComfy(localPath: string, options: ComfyRequestOptions = {}): Promise<string> {
  const buffer = await readFile(localPath);
  const filename = path.basename(localPath);
  return uploadAudioBufferToComfy(buffer, filename, options);
}

export async function uploadAudioBufferToComfy(
  buffer: Buffer,
  filename: string,
  options: ComfyRequestOptions = {}
): Promise<string> {
  // ComfyUI stores uploaded input files through the same multipart endpoint; LoadAudio can read the saved filename.
  return uploadInputBufferToComfy(buffer, filename, options);
}
