import { access, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getAppSettings } from './app-settings.js';
import type {
  AppSettings,
  ComfyuiDetectedEnvironment,
  ComfyuiEnvironmentDiscovery,
  ComfyuiRuntimeInfo,
  ComfyuiRuntimeStatus
} from '../shared/types.js';

const HEALTHCHECK_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 10_000;
const VENV_HINT_NAMES = ['.venv', 'venv', 'env', 'python_env'];
const CONDA_EXECUTABLE_HINTS = [
  process.env.CONDA_EXE?.trim() ?? '',
  '/opt/conda/bin/conda',
  path.join(process.env.HOME ?? '', 'miniconda3/bin/conda'),
  path.join(process.env.HOME ?? '', 'anaconda3/bin/conda'),
  path.join(process.env.HOME ?? '', 'miniforge3/bin/conda'),
  path.join(process.env.HOME ?? '', 'mambaforge/bin/conda')
].filter(Boolean);

interface ManagedComfyuiState {
  child: ChildProcess | null;
  status: ComfyuiRuntimeStatus;
  pid: number | null;
  lastError: string;
  signature: string;
  lastLogs: string[];
}

const managedState: ManagedComfyuiState = {
  child: null,
  status: 'stopped',
  pid: null,
  lastError: '',
  signature: '',
  lastLogs: []
};

let startupPromise: Promise<void> | null = null;

function supportsManagedComfyui(): boolean {
  return process.platform === 'linux';
}

function buildManagedSignature(settings: AppSettings): string {
  const comfyui = settings.comfyui;
  return JSON.stringify({
    baseUrl: comfyui.baseUrl,
    installPath: comfyui.installPath,
    environmentType: comfyui.environmentType,
    environmentId: comfyui.environmentId,
    autoStart: comfyui.autoStart
  });
}

function isManagedLaunchConfigured(settings: AppSettings): boolean {
  return Boolean(
    supportsManagedComfyui() &&
      settings.comfyui.autoStart &&
      settings.comfyui.installPath &&
      settings.comfyui.environmentType &&
      settings.comfyui.environmentId
  );
}

function appendManagedLog(chunk: string): void {
  const lines = chunk
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return;
  }

  managedState.lastLogs.push(...lines);
  if (managedState.lastLogs.length > 30) {
    managedState.lastLogs.splice(0, managedState.lastLogs.length - 30);
  }
}

function describeRecentLogs(): string {
  if (!managedState.lastLogs.length) {
    return '';
  }

  return managedState.lastLogs.slice(-5).join(' | ');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingPath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) {
      return candidate;
    }
  }

  return '';
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  await access(command, fsConstants.X_OK);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;

    const finalize = (callback: () => void) => {
      if (finished) {
        return;
      }

      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      callback();
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        finalize(() => reject(new Error(`命令执行超时: ${command} ${args.join(' ')}`)));
      }, options.timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', (error) => {
      finalize(() => reject(error));
    });

    child.once('close', (code) => {
      if (code === 0) {
        finalize(() => resolve({ stdout, stderr }));
        return;
      }

      finalize(() =>
        reject(new Error(stderr.trim() || stdout.trim() || `命令退出码异常: ${command} (${code ?? 'unknown'})`))
      );
    });
  });
}

async function resolveCondaExecutable(): Promise<string> {
  for (const candidate of CONDA_EXECUTABLE_HINTS) {
    if (candidate && (await pathExists(candidate))) {
      return candidate;
    }
  }

  try {
    const { stdout } = await runCommand('/usr/bin/which', ['conda'], { timeoutMs: 2_000 });
    const resolved = stdout.trim();
    return (await pathExists(resolved)) ? resolved : '';
  } catch {
    return '';
  }
}

async function resolvePythonFromEnvironment(envPath: string): Promise<string> {
  return resolveExistingPath([
    path.join(envPath, 'bin', 'python'),
    path.join(envPath, 'bin', 'python3')
  ]);
}

async function detectVirtualEnvironment(envPath: string): Promise<ComfyuiDetectedEnvironment | null> {
  const pythonPath = await resolvePythonFromEnvironment(envPath);
  const hasPyvenvConfig = await pathExists(path.join(envPath, 'pyvenv.cfg'));
  const hasActivateScript = await pathExists(path.join(envPath, 'bin', 'activate'));

  if (!pythonPath || (!hasPyvenvConfig && !hasActivateScript)) {
    return null;
  }

  return {
    id: pythonPath,
    type: 'venv',
    label: `${path.basename(envPath)} (${envPath})`,
    path: envPath,
    source: 'install_path',
    pythonPath
  };
}

async function listInstallPathVirtualEnvironments(installPath: string): Promise<ComfyuiDetectedEnvironment[]> {
  const environments = new Map<string, ComfyuiDetectedEnvironment>();
  const candidateDirectories = new Set<string>();

  for (const hint of VENV_HINT_NAMES) {
    candidateDirectories.add(path.join(installPath, hint));
  }

  try {
    const entries = await readdir(installPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidateDirectories.add(path.join(installPath, entry.name));
      }
    }
  } catch {
    return [];
  }

  for (const candidateDirectory of candidateDirectories) {
    const detected = await detectVirtualEnvironment(candidateDirectory);
    if (detected) {
      environments.set(detected.id, detected);
    }
  }

  return [...environments.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

async function listCondaEnvironments(): Promise<{
  condaExecutable: string;
  environments: ComfyuiDetectedEnvironment[];
  error: string;
}> {
  const condaExecutable = await resolveCondaExecutable();

  if (!condaExecutable) {
    return {
      condaExecutable: '',
      environments: [],
      error: ''
    };
  }

  try {
    const { stdout } = await runCommand(condaExecutable, ['info', '--envs', '--json'], { timeoutMs: 8_000 });
    const parsed = JSON.parse(stdout) as {
      envs?: unknown;
      root_prefix?: unknown;
    };
    const envPaths = Array.isArray(parsed.envs)
      ? parsed.envs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const rootPrefix = typeof parsed.root_prefix === 'string' ? parsed.root_prefix : '';
    const environments: ComfyuiDetectedEnvironment[] = [];

    for (const envPath of envPaths) {
      const pythonPath = await resolvePythonFromEnvironment(envPath);
      const envName = envPath === rootPrefix ? 'base' : path.basename(envPath);

      environments.push({
        id: envPath,
        type: 'conda',
        label: `${envName} (${envPath})`,
        path: envPath,
        source: 'conda',
        pythonPath
      });
    }

    environments.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));

    return {
      condaExecutable,
      environments,
      error: ''
    };
  } catch (error) {
    return {
      condaExecutable,
      environments: [],
      error: error instanceof Error ? error.message : 'Conda 环境探测失败。'
    };
  }
}

export async function discoverComfyuiEnvironments(installPath: string): Promise<ComfyuiEnvironmentDiscovery> {
  const normalizedInstallPath = installPath.trim();
  const mainPyPath = normalizedInstallPath ? path.join(normalizedInstallPath, 'main.py') : '';
  const installPathExists = normalizedInstallPath ? await pathExists(normalizedInstallPath) : false;
  const mainPyExists = mainPyPath ? await pathExists(mainPyPath) : false;
  const errors: string[] = [];

  let installPathEnvironments: ComfyuiDetectedEnvironment[] = [];
  if (normalizedInstallPath && installPathExists) {
    installPathEnvironments = await listInstallPathVirtualEnvironments(normalizedInstallPath);
  } else if (normalizedInstallPath) {
    errors.push('ComfyUI 路径不存在或当前进程无法访问。');
  }

  if (normalizedInstallPath && installPathExists && !mainPyExists) {
    errors.push('该路径下没有找到 main.py，请确认这是 ComfyUI 根目录。');
  }

  const condaDiscovery = await listCondaEnvironments();
  if (condaDiscovery.error) {
    errors.push(condaDiscovery.error);
  }

  return {
    installPath: normalizedInstallPath,
    installPathExists,
    mainPyPath,
    mainPyExists,
    condaExecutable: condaDiscovery.condaExecutable,
    environments: [...installPathEnvironments, ...condaDiscovery.environments],
    errors
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/g, '');
}

function resolveBaseUrlLaunchArgs(baseUrl: string): {
  port: number;
  listenHost: string;
} {
  try {
    const parsed = new URL(baseUrl);
    const port = Number(parsed.port || '8188');
    const hostname = parsed.hostname === 'localhost' ? '' : parsed.hostname;

    return {
      port: Number.isFinite(port) && port > 0 ? port : 8188,
      listenHost: hostname
    };
  } catch {
    return {
      port: 8188,
      listenHost: ''
    };
  }
}

async function checkComfyuiHealth(baseUrl: string, timeoutMs = HEALTHCHECK_TIMEOUT_MS): Promise<boolean> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${normalizedBaseUrl}/system_stats`, {
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForComfyuiReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await checkComfyuiHealth(baseUrl)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`等待 ComfyUI 启动超时（${Math.round(timeoutMs / 1000)} 秒）。`);
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) {
        return;
      }

      child.kill('SIGKILL');
    }, STOP_TIMEOUT_MS);

    const handleExit = () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      resolve();
    };

    child.once('exit', handleExit);
    child.kill('SIGTERM');
  });
}

async function buildLaunchCommand(settings: AppSettings): Promise<{
  command: string;
  args: string[];
}> {
  const mainPyPath = path.join(settings.comfyui.installPath, 'main.py');
  if (!(await pathExists(mainPyPath))) {
    throw new Error(`ComfyUI 根目录下未找到 main.py: ${mainPyPath}`);
  }

  const { port, listenHost } = resolveBaseUrlLaunchArgs(settings.comfyui.baseUrl);
  const pythonArgs = ['main.py', '--port', String(port)];

  if (listenHost) {
    pythonArgs.push('--listen', listenHost);
  }

  if (settings.comfyui.environmentType === 'venv') {
    const pythonPath = settings.comfyui.environmentId;
    if (!(await pathExists(pythonPath))) {
      throw new Error(`选择的 Python 环境不存在: ${pythonPath}`);
    }

    return {
      command: pythonPath,
      args: pythonArgs
    };
  }

  if (settings.comfyui.environmentType === 'conda') {
    const condaExecutable = await resolveCondaExecutable();
    if (!condaExecutable) {
      throw new Error('未找到 conda 可执行文件，无法启动所选 Conda 环境。');
    }

    const environmentId = settings.comfyui.environmentId.trim();
    const usePrefix = environmentId.includes(path.sep) || environmentId.startsWith('.');

    return {
      command: condaExecutable,
      args: [
        'run',
        '--no-capture-output',
        usePrefix ? '-p' : '-n',
        environmentId,
        'python',
        ...pythonArgs
      ]
    };
  }

  throw new Error('未选择可用的 ComfyUI 启动环境。');
}

export async function stopManagedComfyui(): Promise<void> {
  const child = managedState.child;
  startupPromise = null;

  if (!child) {
    managedState.status = 'stopped';
    managedState.pid = null;
    managedState.signature = '';
    return;
  }

  managedState.status = 'stopped';
  managedState.child = null;
  managedState.pid = null;
  managedState.signature = '';

  await terminateChildProcess(child);
}

export async function startManagedComfyui(settings = getAppSettings()): Promise<void> {
  if (!isManagedLaunchConfigured(settings)) {
    throw new Error('ComfyUI 自动启动尚未配置完成。');
  }

  const signature = buildManagedSignature(settings);

  if (managedState.child && managedState.signature === signature) {
    if (managedState.status === 'running' && (await checkComfyuiHealth(settings.comfyui.baseUrl))) {
      return;
    }

    if (startupPromise) {
      await startupPromise;
      return;
    }

    await stopManagedComfyui();
  }

  if (managedState.child && managedState.signature !== signature) {
    await stopManagedComfyui();
  }

  const launchCommand = await buildLaunchCommand(settings);
  managedState.lastLogs = [];
  managedState.lastError = '';
  managedState.status = 'starting';
  managedState.signature = signature;

  const child = spawn(launchCommand.command, launchCommand.args, {
    cwd: settings.comfyui.installPath,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  managedState.child = child;
  managedState.pid = child.pid ?? null;

  child.stdout?.on('data', (chunk) => {
    appendManagedLog(chunk.toString());
  });

  child.stderr?.on('data', (chunk) => {
    appendManagedLog(chunk.toString());
  });

  child.once('error', (error) => {
    managedState.status = 'error';
    managedState.lastError = `启动 ComfyUI 失败: ${error.message}`;
  });

  child.once('exit', (code, signal) => {
    if (managedState.child === child) {
      managedState.child = null;
      managedState.pid = null;
      managedState.signature = '';
    }

    if (managedState.status !== 'stopped') {
      const recentLogs = describeRecentLogs();
      managedState.status = 'error';
      managedState.lastError = [
        `ComfyUI 进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）。`,
        recentLogs ? `最近日志: ${recentLogs}` : ''
      ]
        .filter(Boolean)
        .join(' ');
    }
  });

  const exitBeforeReady = new Promise<never>((_, reject) => {
    child.once('exit', () => {
      reject(new Error(managedState.lastError || 'ComfyUI 进程在启动完成前退出。'));
    });
    child.once('error', (error) => {
      reject(error);
    });
  });

  startupPromise = (async () => {
    try {
      await Promise.race([waitForComfyuiReady(settings.comfyui.baseUrl, STARTUP_TIMEOUT_MS), exitBeforeReady]);
      managedState.status = 'running';
      managedState.lastError = '';
    } catch (error) {
      if (managedState.child === child) {
        managedState.child = null;
        managedState.pid = null;
        managedState.signature = '';
        await terminateChildProcess(child);
      }

      managedState.status = 'error';
      const message = error instanceof Error ? error.message : 'ComfyUI 启动失败。';
      const recentLogs = describeRecentLogs();
      managedState.lastError = [message, recentLogs ? `最近日志: ${recentLogs}` : '']
        .filter(Boolean)
        .join(' ');
      throw new Error(managedState.lastError);
    } finally {
      startupPromise = null;
    }
  })();

  await startupPromise;
}

export async function syncManagedComfyuiRuntime(settings = getAppSettings()): Promise<void> {
  if (!supportsManagedComfyui()) {
    await stopManagedComfyui();
    managedState.lastError = '';
    return;
  }

  if (!settings.comfyui.autoStart) {
    await stopManagedComfyui();
    managedState.lastError = '';
    return;
  }

  if (!isManagedLaunchConfigured(settings)) {
    await stopManagedComfyui();
    managedState.lastError = '';
    return;
  }

  const signature = buildManagedSignature(settings);
  if (managedState.child && managedState.signature !== signature) {
    await stopManagedComfyui();
  }

  if (await checkComfyuiHealth(settings.comfyui.baseUrl)) {
    managedState.status = 'running';
    managedState.signature = signature;
    managedState.lastError = '';
    return;
  }

  try {
    await startManagedComfyui(settings);
  } catch {
    // Keep runtime state for UI inspection; requests will surface the stored error later.
  }
}

export async function ensureComfyuiReady(): Promise<void> {
  const settings = getAppSettings();

  if (await checkComfyuiHealth(settings.comfyui.baseUrl)) {
    managedState.status = 'running';
    managedState.lastError = '';
    return;
  }

  if (!isManagedLaunchConfigured(settings)) {
    throw new Error('ComfyUI 地址不可达，且尚未完成本地自动启动配置。');
  }

  await startManagedComfyui(settings);
}

export function getComfyuiRuntimeInfo(settings = getAppSettings()): ComfyuiRuntimeInfo {
  return {
    supported: supportsManagedComfyui(),
    autoStartEnabled: settings.comfyui.autoStart,
    launchConfigured: isManagedLaunchConfigured(settings),
    status: managedState.status,
    pid: managedState.pid,
    lastError: managedState.lastError
  };
}
