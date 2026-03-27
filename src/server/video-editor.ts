import { spawn } from 'node:child_process';
import { writeFile, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getAppSettings } from './app-settings.js';

function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, `'\\''`);
}

async function runFfmpeg(args: string[]): Promise<void> {
  const settings = getAppSettings();

  if (!settings.ffmpeg.binaryPath) {
    throw new Error('未找到 ffmpeg。请安装 ffmpeg 或通过 FFMPEG_PATH 指定可执行文件路径。');
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(settings.ffmpeg.binaryPath, args);

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `ffmpeg 退出码 ${code}`));
    });
  });
}

async function hasAudioStream(inputPath: string): Promise<boolean> {
  const settings = getAppSettings();

  if (!settings.ffmpeg.binaryPath) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const child = spawn(settings.ffmpeg.binaryPath, ['-v', 'error', '-i', inputPath, '-map', '0:a:0', '-f', 'null', '-']);
    child.on('error', () => resolve(false));
    child.on('close', (code: number | null) => {
      resolve(code === 0);
    });
  });
}

async function normalizeSegmentsWithAudio(
  videoPaths: string[],
  audioPaths: Array<string | null>,
  outputPath: string,
  fps: number
): Promise<string[]> {
  const segmentsDir = path.join(path.dirname(outputPath), '.segments');
  await mkdir(segmentsDir, { recursive: true });

  const prepared: string[] = [];

  for (let index = 0; index < videoPaths.length; index += 1) {
    const videoPath = videoPaths[index];
    const audioPath = audioPaths[index];
    const sourceHasAudio = await hasAudioStream(videoPath);
    const segmentPath = path.join(segmentsDir, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
    const args = ['-y', '-i', videoPath];
    let audioMap = '';

    if (audioPath) {
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
      '-shortest',
      '-movflags',
      '+faststart',
      segmentPath
    );

    await runFfmpeg(args);
    prepared.push(segmentPath);
  }

  return prepared;
}

export async function extractLastFrame(videoPath: string, outputImagePath: string): Promise<void> {
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
  ]);
}

export async function stitchVideos(
  videoPaths: string[],
  outputPath: string,
  fps: number,
  audioPaths: Array<string | null> = []
): Promise<void> {
  if (!videoPaths.length) {
    throw new Error('没有可用于拼接的视频片段。');
  }

  if (audioPaths.length && audioPaths.length !== videoPaths.length) {
    throw new Error('音频片段数量与视频片段数量不一致，无法执行剪辑。');
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  const normalizedAudioPaths = audioPaths.length ? audioPaths : Array(videoPaths.length).fill(null);
  const sourceVideoPaths = await normalizeSegmentsWithAudio(videoPaths, normalizedAudioPaths, outputPath, fps);

  if (sourceVideoPaths.length === 1) {
    await copyFile(sourceVideoPaths[0], outputPath);
    return;
  }

  const listFile = path.join(path.dirname(outputPath), 'concat.txt');
  const concatText = sourceVideoPaths.map((videoPath) => `file '${escapeConcatPath(videoPath)}'`).join('\n');
  await writeFile(listFile, concatText, 'utf8');

  await runFfmpeg([
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outputPath
  ]);
}
