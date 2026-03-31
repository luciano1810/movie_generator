import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getAppSettings } from './app-settings.js';

interface FfmpegRunOptions {
  signal?: AbortSignal;
}

interface VideoDimensions {
  width: number;
  height: number;
}

interface StitchVideoOptions extends FfmpegRunOptions {
  targetWidth?: number;
  targetHeight?: number;
}

const DURATION_REGEX = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const AUDIO_SYNC_TOLERANCE_SECONDS = 0.05;

function parseDurationMatch(stderr: string): number | null {
  const matched = stderr.match(DURATION_REGEX);

  if (!matched) {
    return null;
  }

  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  const seconds = Number(matched[3]);

  if (![hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function parseVideoDimensionsMatch(stderr: string): VideoDimensions | null {
  const videoLine = stderr
    .split(/\r?\n/)
    .find((line) => line.includes('Video:'));

  if (!videoLine) {
    return null;
  }

  const matched = videoLine.match(/,\s*(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)/);

  if (!matched) {
    return null;
  }

  const width = Number(matched[1]);
  const height = Number(matched[2]);

  if (![width, height].every(Number.isFinite)) {
    return null;
  }

  return { width, height };
}

function createAbortError(): Error {
  const error = new Error('操作已中止。');
  error.name = 'AbortError';
  return error;
}

function buildAtempoFilterChain(tempo: number): string {
  const safeTempo = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;
  const filters: string[] = [];
  let remainingTempo = safeTempo;

  while (remainingTempo < 0.5) {
    filters.push('atempo=0.5');
    remainingTempo /= 0.5;
  }

  while (remainingTempo > 2) {
    filters.push('atempo=2');
    remainingTempo /= 2;
  }

  filters.push(`atempo=${remainingTempo.toFixed(6)}`);
  return filters.join(',');
}

function buildVideoCropFilter(target: VideoDimensions): string {
  return [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
    `crop=${target.width}:${target.height}`,
    'setsar=1'
  ].join(',');
}

async function runFfmpeg(args: string[], options: FfmpegRunOptions = {}): Promise<void> {
  const settings = getAppSettings();

  if (!settings.ffmpeg.binaryPath) {
    throw new Error('未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定可执行文件路径。');
  }

  if (options.signal?.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(settings.ffmpeg.binaryPath, args);
    let aborted = false;

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    const handleAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    child.on('error', reject);
    child.on('close', (code: number | null) => {
      options.signal?.removeEventListener('abort', handleAbort);

      if (aborted) {
        reject(createAbortError());
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `ffmpeg 退出码 ${code}`));
    });
  });
}

export async function getMediaDurationSeconds(
  inputPath: string,
  options: FfmpegRunOptions = {}
): Promise<number> {
  const settings = getAppSettings();

  if (!settings.ffmpeg.binaryPath) {
    throw new Error('未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定可执行文件路径。');
  }

  if (options.signal?.aborted) {
    throw createAbortError();
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(settings.ffmpeg.binaryPath, ['-hide_banner', '-i', inputPath]);
    let aborted = false;
    let stderr = '';

    const handleAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', () => {
      options.signal?.removeEventListener('abort', handleAbort);

      if (aborted) {
        reject(createAbortError());
        return;
      }

      const durationSeconds = parseDurationMatch(stderr);
      if (durationSeconds === null) {
        reject(new Error(`无法读取媒体时长: ${inputPath}`));
        return;
      }

      resolve(durationSeconds);
    });
  });
}

async function hasAudioStream(inputPath: string, options: FfmpegRunOptions = {}): Promise<boolean> {
  const settings = getAppSettings();

  if (!settings.ffmpeg.binaryPath) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const child = spawn(settings.ffmpeg.binaryPath, ['-v', 'error', '-i', inputPath, '-map', '0:a:0', '-f', 'null', '-']);
    let aborted = false;

    const handleAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    };

    if (options.signal?.aborted) {
      resolve(false);
      child.kill('SIGTERM');
      return;
    }

    options.signal?.addEventListener('abort', handleAbort, { once: true });
    child.on('error', () => resolve(false));
    child.on('close', (code: number | null) => {
      options.signal?.removeEventListener('abort', handleAbort);
      resolve(!aborted && code === 0);
    });
  });
}

async function getVideoDimensions(
  inputPath: string,
  options: FfmpegRunOptions = {}
): Promise<VideoDimensions> {
  const settings = getAppSettings();

  if (!settings.ffmpeg.binaryPath) {
    throw new Error('未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定可执行文件路径。');
  }

  if (options.signal?.aborted) {
    throw createAbortError();
  }

  return await new Promise<VideoDimensions>((resolve, reject) => {
    const child = spawn(settings.ffmpeg.binaryPath, ['-hide_banner', '-i', inputPath]);
    let aborted = false;
    let stderr = '';

    const handleAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', () => {
      options.signal?.removeEventListener('abort', handleAbort);

      if (aborted) {
        reject(createAbortError());
        return;
      }

      const dimensions = parseVideoDimensionsMatch(stderr);
      if (!dimensions) {
        reject(new Error(`无法读取视频尺寸: ${inputPath}`));
        return;
      }

      resolve(dimensions);
    });
  });
}

async function resolveTargetVideoDimensions(
  videoPaths: string[],
  options: StitchVideoOptions
): Promise<VideoDimensions> {
  if (options.targetWidth && options.targetHeight) {
    return {
      width: Math.max(2, Math.round(options.targetWidth)),
      height: Math.max(2, Math.round(options.targetHeight))
    };
  }

  const dimensions = await Promise.all(videoPaths.map((videoPath) => getVideoDimensions(videoPath, options)));

  return dimensions.reduce<VideoDimensions>(
    (target, current) => ({
      width: Math.max(target.width, current.width),
      height: Math.max(target.height, current.height)
    }),
    { width: 2, height: 2 }
  );
}

async function normalizeSegmentsWithAudio(
  videoPaths: string[],
  audioPaths: Array<string | null>,
  outputPath: string,
  fps: number,
  options: StitchVideoOptions = {}
): Promise<string[]> {
  const segmentsDir = path.join(path.dirname(outputPath), '.segments');
  await mkdir(segmentsDir, { recursive: true });

  const prepared: string[] = [];
  const targetDimensions = await resolveTargetVideoDimensions(videoPaths, options);

  for (let index = 0; index < videoPaths.length; index += 1) {
    const videoPath = videoPaths[index];
    const audioPath = audioPaths[index];
    const sourceHasAudio = await hasAudioStream(videoPath, options);
    const segmentPath = path.join(segmentsDir, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
    const args = ['-y', '-i', videoPath];
    let targetDurationSeconds: number | null = null;
    let audioMap = '';
    let sourceAudioFilter = '[0:a]aresample=48000';
    const videoFilters = [buildVideoCropFilter(targetDimensions)];

    if (audioPath) {
      const [videoDurationSeconds, audioDurationSeconds] = await Promise.all([
        getMediaDurationSeconds(videoPath, options),
        getMediaDurationSeconds(audioPath, options)
      ]);

      if (videoDurationSeconds > 0 && audioDurationSeconds > videoDurationSeconds + AUDIO_SYNC_TOLERANCE_SECONDS) {
        const stretchRatio = audioDurationSeconds / videoDurationSeconds;
        videoFilters.unshift(`setpts=${stretchRatio.toFixed(6)}*PTS`);
        sourceAudioFilter = `${sourceAudioFilter},${buildAtempoFilterChain(1 / stretchRatio)}`;
        targetDurationSeconds = audioDurationSeconds;
      }

      args.push('-i', audioPath);
      if (sourceHasAudio) {
        args.push(
          '-filter_complex',
          `${sourceAudioFilter},apad[va];[1:a]aresample=48000,apad[ea];[va][ea]amix=inputs=2:duration=first:dropout_transition=0[aout]`
        );
      } else {
        args.push('-filter_complex', '[1:a]aresample=48000,apad[aout]');
      }
      audioMap = '[aout]';
    } else if (sourceHasAudio) {
      args.push('-filter_complex', `${sourceAudioFilter},apad[aout]`);
      audioMap = '[aout]';
    } else {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      audioMap = '1:a:0';
    }

    args.push('-vf', videoFilters.join(','));
    args.push('-map', '0:v:0', '-map', audioMap);
    args.push(
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      ...(targetDurationSeconds === null ? [] : ['-t', targetDurationSeconds.toFixed(3)]),
      '-shortest',
      '-movflags',
      '+faststart',
      segmentPath
    );

    await runFfmpeg(args, options);
    prepared.push(segmentPath);
  }

  return prepared;
}

export async function extractLastFrame(
  videoPath: string,
  outputImagePath: string,
  options: FfmpegRunOptions = {}
): Promise<void> {
  await mkdir(path.dirname(outputImagePath), { recursive: true });
  await runFfmpeg([
    '-y',
    '-i',
    videoPath,
    '-update',
    '1',
    '-q:v',
    '2',
    outputImagePath
  ], options);
}

export async function stitchAudios(
  audioPaths: string[],
  outputPath: string,
  options: FfmpegRunOptions = {}
): Promise<void> {
  if (!audioPaths.length) {
    throw new Error('没有可用于拼接的音频片段。');
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  const args = ['-y'];

  for (const audioPath of audioPaths) {
    args.push('-i', audioPath);
  }

  if (audioPaths.length === 1) {
    args.push(
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      outputPath
    );
    await runFfmpeg(args, options);
    return;
  }

  const normalizedInputs = audioPaths
    .map(
      (_, index) =>
        `[${index}:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[a${index}]`
    )
    .join(';');
  const concatInputs = audioPaths.map((_, index) => `[a${index}]`).join('');

  args.push(
    '-filter_complex',
    `${normalizedInputs};${concatInputs}concat=n=${audioPaths.length}:v=0:a=1[aout]`,
    '-map',
    '[aout]',
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    outputPath
  );

  await runFfmpeg(args, options);
}

export async function stitchVideos(
  videoPaths: string[],
  outputPath: string,
  fps: number,
  audioPaths: Array<string | null> = [],
  options: StitchVideoOptions = {}
): Promise<void> {
  if (!videoPaths.length) {
    throw new Error('没有可用于拼接的视频片段。');
  }

  if (audioPaths.length && audioPaths.length !== videoPaths.length) {
    throw new Error('音频片段数量与视频片段数量不一致，无法执行剪辑。');
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  const normalizedAudioPaths = audioPaths.length ? audioPaths : Array(videoPaths.length).fill(null);
  const sourceVideoPaths = await normalizeSegmentsWithAudio(videoPaths, normalizedAudioPaths, outputPath, fps, options);

  if (sourceVideoPaths.length === 1) {
    await copyFile(sourceVideoPaths[0], outputPath);
    return;
  }

  const args = ['-y'];

  for (const videoPath of sourceVideoPaths) {
    args.push('-i', videoPath);
  }

  const concatInputs = sourceVideoPaths.map((_, index) => `[${index}:v:0][${index}:a:0]`).join('');

  args.push(
    '-filter_complex',
    `${concatInputs}concat=n=${sourceVideoPaths.length}:v=1:a=1[vout][aout]`,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    outputPath
  );

  await runFfmpeg(args, options);
}
