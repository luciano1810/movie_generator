import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getAppSettings } from './app-settings.js';

interface FfmpegRunOptions {
  signal?: AbortSignal;
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

function createAbortError(): Error {
  const error = new Error('操作已中止。');
  error.name = 'AbortError';
  return error;
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

async function normalizeSegmentsWithAudio(
  videoPaths: string[],
  audioPaths: Array<string | null>,
  outputPath: string,
  fps: number,
  options: FfmpegRunOptions = {}
): Promise<string[]> {
  const segmentsDir = path.join(path.dirname(outputPath), '.segments');
  await mkdir(segmentsDir, { recursive: true });

  const prepared: string[] = [];

  for (let index = 0; index < videoPaths.length; index += 1) {
    const videoPath = videoPaths[index];
    const audioPath = audioPaths[index];
    const sourceHasAudio = await hasAudioStream(videoPath, options);
    const segmentPath = path.join(segmentsDir, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
    const args = ['-y', '-i', videoPath];
    let targetDurationSeconds: number | null = null;
    let audioMap = '';

    if (audioPath) {
      const [videoDurationSeconds, audioDurationSeconds] = await Promise.all([
        getMediaDurationSeconds(videoPath, options),
        getMediaDurationSeconds(audioPath, options)
      ]);

      if (audioDurationSeconds > videoDurationSeconds + AUDIO_SYNC_TOLERANCE_SECONDS) {
        const padDurationSeconds = audioDurationSeconds - videoDurationSeconds;
        args.push('-vf', `tpad=stop_mode=clone:stop_duration=${padDurationSeconds.toFixed(3)}`);
        targetDurationSeconds = audioDurationSeconds;
      }

      args.push('-i', audioPath);
      if (sourceHasAudio) {
        args.push(
          '-filter_complex',
          '[0:a]aresample=48000,apad[va];[1:a]aresample=48000,apad[ea];[va][ea]amix=inputs=2:duration=first:dropout_transition=0[aout]'
        );
      } else {
        args.push('-filter_complex', '[1:a]aresample=48000,apad[aout]');
      }
      audioMap = '[aout]';
    } else if (sourceHasAudio) {
      args.push('-filter_complex', '[0:a]aresample=48000,apad[aout]');
      audioMap = '[aout]';
    } else {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      audioMap = '1:a:0';
    }

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
  options: FfmpegRunOptions = {}
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
