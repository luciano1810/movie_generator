import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import process from 'node:process';
import {
  STAGES,
  STAGE_LABELS,
  STORY_LENGTH_LABELS,
  STORY_LENGTHS,
  type StoryLength,
  type StageId
} from '../shared/types.js';
import { bootstrapRuntime } from './bootstrap.js';
import {
  type PipelineProjectUpdateEvent,
  runProjectDirect,
  subscribePipelineProjectUpdates
} from './pipeline.js';
import { createProject, listProjects, readProject } from './storage.js';

type CliValues = Record<string, string | boolean | undefined>;

function printUsage(): void {
  console.log(`用法:
  npm run cli:dev
  npm run cli:dev -- project create --title "<项目名>" --new "<创意/文案>" --length medium
  npm run cli:dev -- project create --title "<项目名>" --optimize "<已有剧本/文案>" --length short
  npm run cli:dev -- project run --name "<项目名>"

交互模式:
  help               查看帮助
  exit / quit        退出交互模式

篇幅可选:
  test | short | medium | long
  测试 | 短篇 | 中篇 | 长篇
`);
}

function formatProgressBar(completed: number, total: number, width = 24): string {
  if (total <= 0) {
    return `[${'-'.repeat(width)}]`;
  }

  const ratio = Math.max(0, Math.min(1, completed / total));
  const filled = Math.round(ratio * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}]`;
}

function resolveActiveStage(event: PipelineProjectUpdateEvent): StageId | null {
  if (event.runState.currentStage) {
    return event.runState.currentStage;
  }

  for (const stage of STAGES) {
    if (event.stages[stage].status === 'running') {
      return stage;
    }
  }

  for (const stage of [...STAGES].reverse()) {
    if (event.stages[stage].status !== 'idle') {
      return stage;
    }
  }

  return null;
}

function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  let tokenActive = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenActive = true;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaping = true;
      tokenActive = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenActive = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenActive = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenActive) {
        tokens.push(current);
        current = '';
        tokenActive = false;
      }
      continue;
    }

    current += char;
    tokenActive = true;
  }

  if (escaping) {
    current += '\\';
  }

  if (quote) {
    throw new Error('命令中的引号未闭合。');
  }

  if (tokenActive) {
    tokens.push(current);
  }

  return tokens;
}

function normalizeStoryLength(value: string | undefined): StoryLength | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (STORY_LENGTHS.includes(normalized as StoryLength)) {
    return normalized as StoryLength;
  }

  if (normalized === '测试') {
    return 'test';
  }

  if (normalized === '短篇') {
    return 'short';
  }

  if (normalized === '中篇') {
    return 'medium';
  }

  if (normalized === '长篇') {
    return 'long';
  }

  return null;
}

class TerminalProgressRenderer {
  private currentStage: StageId | null = null;
  private lastLine = '';

  render(event: PipelineProjectUpdateEvent): void {
    const stage = resolveActiveStage(event);
    if (!stage) {
      return;
    }

    if (this.currentStage !== stage) {
      this.finishLine();
      const stageIndex = STAGES.indexOf(stage) + 1;
      console.log(`阶段 ${stageIndex}/${STAGES.length} · ${STAGE_LABELS[stage]}`);
      this.currentStage = stage;
      this.lastLine = '';
    }

    const stageState = event.stages[stage];
    const progress = stageState.progress;
    const progressText = progress
      ? `${formatProgressBar(progress.completed, progress.total)} ${progress.completed}/${progress.total} ${progress.unitLabel}`
      : stageState.status === 'running'
        ? '[运行中]'
        : stageState.status === 'success'
          ? '[已完成]'
          : stageState.status === 'error'
            ? '[失败]'
            : '[等待中]';
    const detail = progress?.currentItemLabel || stageState.error || event.lastLog?.message || '';
    const nextLine = `${progressText}${detail ? ` ${detail}` : ''}`;

    if (nextLine === this.lastLine) {
      return;
    }

    if (process.stdout.isTTY) {
      process.stdout.write(`\r\x1b[2K${nextLine}`);
    } else {
      console.log(nextLine);
    }

    this.lastLine = nextLine;
  }

  finishLine(): void {
    if (process.stdout.isTTY && this.lastLine) {
      process.stdout.write('\n');
    }
    this.lastLine = '';
  }
}

function parseCliInvocation(args: string[]): {
  positionals: string[];
  values: CliValues;
} {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: {
        type: 'string'
      },
      new: {
        type: 'string'
      },
      optimize: {
        type: 'string'
      },
      length: {
        type: 'string'
      },
      name: {
        type: 'string'
      },
      help: {
        type: 'boolean'
      }
    }
  });

  return {
    positionals,
    values: values as CliValues
  };
}

async function resolveProjectIdByName(name: string): Promise<string> {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error('请通过 --name 提供项目名。');
  }

  const projects = await listProjects();
  const matchedProjects = projects.filter((project) => project.title.trim() === normalizedName);

  if (!matchedProjects.length) {
    throw new Error(`未找到名为“${normalizedName}”的项目。`);
  }

  if (matchedProjects.length > 1) {
    throw new Error(
      `存在多个同名项目“${normalizedName}”，请先去重。重复项目 ID：${matchedProjects.map((project) => project.id).join(', ')}`
    );
  }

  return matchedProjects[0].id;
}

async function handleProjectCreate(values: CliValues): Promise<void> {
  const title = typeof values.title === 'string' ? values.title.trim() : '';
  const newSource = typeof values.new === 'string' ? values.new.trim() : '';
  const optimizeSource = typeof values.optimize === 'string' ? values.optimize.trim() : '';
  const rawLength = typeof values.length === 'string' ? values.length.trim() : '';
  const storyLength = normalizeStoryLength(rawLength);

  if (!title) {
    throw new Error('创建项目时必须提供 --title。');
  }

  if ((newSource ? 1 : 0) + (optimizeSource ? 1 : 0) !== 1) {
    throw new Error('创建项目时必须且只能提供一个来源：--new 或 --optimize。');
  }

  if (rawLength && !storyLength) {
    throw new Error('`--length` 仅支持：test、short、medium、long，或 测试、短篇、中篇、长篇。');
  }

  const project = await createProject({
    title,
    sourceText: newSource || optimizeSource,
    settings: {
      scriptMode: newSource ? 'generate' : 'optimize',
      ...(storyLength ? { storyLength } : {})
    }
  });

  console.log(`项目已创建: ${project.title}`);
  console.log(`ID: ${project.id}`);
  console.log(`模式: ${project.settings.scriptMode === 'generate' ? '生成新剧本' : '优化已有剧本'}`);
  console.log(`篇幅: ${STORY_LENGTH_LABELS[project.settings.storyLength]} (${project.settings.storyLength})`);
}

async function handleProjectRun(values: CliValues): Promise<void> {
  const name = typeof values.name === 'string' ? values.name : '';
  const projectId = await resolveProjectIdByName(name);
  const project = await readProject(projectId);
  const renderer = new TerminalProgressRenderer();

  console.log(`开始执行项目: ${project.title}`);

  const unsubscribe = subscribePipelineProjectUpdates((event) => {
    if (event.projectId !== projectId) {
      return;
    }

    renderer.render(event);
  });

  try {
    await runProjectDirect(projectId, 'all');
    renderer.finishLine();

    const latestProject = await readProject(projectId);
    if (latestProject.assets.finalVideo?.relativePath) {
      console.log(`执行完成，最终成片: ${latestProject.assets.finalVideo.relativePath}`);
    } else {
      console.log('执行完成。');
    }
  } finally {
    unsubscribe();
    renderer.finishLine();
  }
}

async function executeCliInvocation(args: string[]): Promise<void> {
  const { positionals, values } = parseCliInvocation(args);

  if (values.help) {
    printUsage();
    return;
  }

  const [group, command] = positionals;

  if (!group) {
    printUsage();
    return;
  }

  if (group === 'project' && command === 'create') {
    await handleProjectCreate(values);
    return;
  }

  if (group === 'project' && command === 'run') {
    await handleProjectRun(values);
    return;
  }

  throw new Error('未知命令。');
}

async function startInteractiveShell(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  console.log('已进入交互模式。输入 help 查看帮助，输入 exit 或 quit 退出。');
  rl.setPrompt('playgen> ');
  rl.prompt();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();

      if (!trimmed) {
        rl.prompt();
        continue;
      }

      if (trimmed === 'exit' || trimmed === 'quit') {
        rl.close();
        break;
      }

      if (trimmed === 'help') {
        printUsage();
        rl.prompt();
        continue;
      }

      try {
        const args = tokenizeCommandLine(trimmed);
        await executeCliInvocation(args);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }

      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { repairedRunStates } = await bootstrapRuntime();
  if (repairedRunStates > 0) {
    console.error(`检测到 ${repairedRunStates} 个中断任务，已自动重置运行状态。`);
  }

  const argv = process.argv.slice(2);

  if (!argv.length) {
    await startInteractiveShell();
    return;
  }

  await executeCliInvocation(argv);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
