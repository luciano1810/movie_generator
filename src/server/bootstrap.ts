import { initializeAppSettings } from './app-settings.js';
import { syncManagedComfyuiRuntime } from './comfyui-runtime.js';
import { clearInterruptedRunStates, ensureStorage } from './storage.js';

export interface BootstrapRuntimeResult {
  repairedRunStates: number;
}

let bootstrapRuntimePromise: Promise<BootstrapRuntimeResult> | null = null;

export async function bootstrapRuntime(): Promise<BootstrapRuntimeResult> {
  if (bootstrapRuntimePromise) {
    return bootstrapRuntimePromise;
  }

  bootstrapRuntimePromise = (async () => {
    await ensureStorage();
    const initialSettings = await initializeAppSettings();
    await syncManagedComfyuiRuntime(initialSettings);
    const repairedRunStates = await clearInterruptedRunStates();

    return {
      repairedRunStates
    };
  })();

  try {
    return await bootstrapRuntimePromise;
  } catch (error) {
    bootstrapRuntimePromise = null;
    throw error;
  }
}
