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

export async function stitchVideos(videoPaths: string[], outputPath: string, fps: number): Promise<void> {
  if (!videoPaths.length) {
    throw new Error('没有可用于拼接的视频片段。');
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  if (videoPaths.length === 1) {
    await copyFile(videoPaths[0], outputPath);
    return;
  }

  const listFile = path.join(path.dirname(outputPath), 'concat.txt');
  const concatText = videoPaths.map((videoPath) => `file '${escapeConcatPath(videoPath)}'`).join('\n');
  await writeFile(listFile, concatText, 'utf8');

  await runFfmpeg([
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-an',
    '-r',
    String(fps),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath
  ]);
}
