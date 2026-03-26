import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAppSettings } from './app-settings.js';

export interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
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

async function waitForHistory(promptId: string): Promise<Record<string, any>> {
  const settings = getAppSettings();
  const startedAt = Date.now();

  while (Date.now() - startedAt < settings.comfyui.timeoutMs) {
    const response = await fetch(`${settings.comfyui.baseUrl}/history/${promptId}`);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`查询 ComfyUI 历史记录失败: ${message}`);
    }

    const history = (await response.json()) as Record<string, any>;
    const item = history[promptId];

    if (item) {
      return item;
    }

    await new Promise((resolve) => setTimeout(resolve, settings.comfyui.pollIntervalMs));
  }

  throw new Error(`ComfyUI 任务超时，prompt_id=${promptId}`);
}

export async function runComfyWorkflow(
  templatePath: string,
  variables: Record<string, TemplateVariable>
): Promise<ComfyOutputFile[]> {
  const settings = getAppSettings();
  const workflow = fillTemplateValue(await loadWorkflowTemplate(templatePath), variables);
  const clientId = crypto.randomUUID();

  const response = await fetch(`${settings.comfyui.baseUrl}/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
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

  const historyItem = await waitForHistory(data.prompt_id);
  const outputFiles = collectOutputFiles(historyItem);

  if (!outputFiles.length) {
    throw new Error('ComfyUI 执行完成，但没有找到输出文件。');
  }

  return outputFiles;
}

export async function fetchComfyOutputFile(file: ComfyOutputFile): Promise<Buffer> {
  const settings = getAppSettings();
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type
  });

  const response = await fetch(`${settings.comfyui.baseUrl}/view?${params.toString()}`);

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`下载 ComfyUI 输出失败: ${message}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function uploadImageToComfy(localPath: string): Promise<string> {
  const settings = getAppSettings();
  const buffer = await readFile(localPath);
  const filename = path.basename(localPath);
  const form = new FormData();

  form.set('image', new Blob([buffer]), filename);
  form.set('overwrite', 'true');

  const response = await fetch(`${settings.comfyui.baseUrl}/upload/image`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`上传图片到 ComfyUI 失败: ${message}`);
  }

  const data = (await response.json()) as { name?: string; filename?: string };
  return data.name ?? data.filename ?? filename;
}
