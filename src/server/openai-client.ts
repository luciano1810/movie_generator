import OpenAI from 'openai';
import type {
  ProjectSettings,
  ScriptDialogueLine,
  ScriptPackage,
  ScriptScene,
  StoryboardShot
} from '../shared/types.js';
import { getAppSettings } from './app-settings.js';

type ChatCompletionMessageParam = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

function getClient(): OpenAI {
  const settings = getAppSettings();

  if (!settings.llm.apiKey) {
    throw new Error('OPENAI_API_KEY 未配置，无法执行文本生成阶段。');
  }

  return new OpenAI({
    apiKey: settings.llm.apiKey,
    baseURL: settings.llm.baseUrl
  });
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item) {
          return String(item.text);
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function parseJsonPayload<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? raw.trim();

  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');

  let jsonText = candidate;

  if (objectStart !== -1 && objectEnd !== -1) {
    jsonText = candidate.slice(objectStart, objectEnd + 1);
  } else if (arrayStart !== -1 && arrayEnd !== -1) {
    jsonText = candidate.slice(arrayStart, arrayEnd + 1);
  }

  return JSON.parse(jsonText) as T;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeDuration(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

async function requestJson<T>(messages: ChatCompletionMessageParam[]): Promise<T> {
  const client = getClient();
  const settings = getAppSettings();
  const response = await client.chat.completions.create({
    model: settings.llm.model,
    temperature: 0.85,
    messages
  });

  const content = extractTextContent(response.choices[0]?.message?.content);

  if (!content.trim()) {
    throw new Error('文本模型没有返回内容。');
  }

  return parseJsonPayload<T>(content);
}

function formatDialogue(dialogue: ScriptDialogueLine[]): string {
  if (!dialogue.length) {
    return '无对白';
  }

  return dialogue
    .map((line) => {
      const performance = line.performanceNote ? `（${line.performanceNote}）` : '';
      return `${line.character}${performance}：${line.line}`;
    })
    .join('\n');
}

function formatScriptMarkdown(script: Omit<ScriptPackage, 'markdown'>): string {
  const characters = script.characters
    .map(
      (character) =>
        `- ${character.name}｜${character.identity}\n  外观：${character.visualTraits}\n  动机：${character.motivation}`
    )
    .join('\n');

  const scenes = script.scenes
    .map(
      (scene) =>
        `## 场景 ${scene.sceneNumber}\n` +
        `- 地点：${scene.location}\n` +
        `- 时间：${scene.timeOfDay}\n` +
        `- 时长：${scene.durationSeconds}s\n` +
        `- 概要：${scene.summary}\n` +
        `- 情绪推进：${scene.emotionalBeat}\n` +
        `- 画外音：${scene.voiceover || '无'}\n` +
        `- 对白：\n${formatDialogue(scene.dialogue)
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}`
    )
    .join('\n\n');

  return `# ${script.title}

一句话卖点：${script.tagline}

剧情梗概：${script.synopsis}

风格说明：${script.styleNotes}

## 角色设定
${characters}

## 分场剧本
${scenes}
`;
}

export async function generateScriptFromText(
  sourceText: string,
  settings: ProjectSettings
): Promise<ScriptPackage> {
  const payload = await requestJson<{
    title?: string;
    tagline?: string;
    synopsis?: string;
    styleNotes?: string;
    characters?: Array<{
      name?: string;
      identity?: string;
      visualTraits?: string;
      motivation?: string;
    }>;
    scenes?: Array<{
      sceneNumber?: number;
      location?: string;
      timeOfDay?: string;
      summary?: string;
      emotionalBeat?: string;
      voiceover?: string;
      durationSeconds?: number;
      dialogue?: Array<{
        character?: string;
        line?: string;
        performanceNote?: string;
      }>;
    }>;
  }>([
    {
      role: 'system',
      content:
        '你是一名资深中文短剧总编剧，擅长把梗概、文案或粗稿改写成适合短视频连载的高钩子剧本。只输出 JSON，不要输出任何额外说明。'
    },
    {
      role: 'user',
      content: `请基于下面的输入内容生成或优化短剧剧本。

要求：
1. 面向受众：${settings.audience}
2. 语气风格：${settings.tone}
3. 视觉调性：${settings.visualStyle}
4. 语言：${settings.language}
5. 目标场景数：${settings.targetSceneCount}
6. 每场应控制在强冲突、强推进、便于分镜拆解的节奏
7. 每场 durationSeconds 需给出整数秒，便于后续视频生成
8. 只返回 JSON，对象结构如下：
{
  "title": "标题",
  "tagline": "一句话卖点",
  "synopsis": "剧情梗概",
  "styleNotes": "风格说明",
  "characters": [
    {
      "name": "角色名",
      "identity": "身份",
      "visualTraits": "外观特征",
      "motivation": "核心动机"
    }
  ],
  "scenes": [
    {
      "sceneNumber": 1,
      "location": "地点",
      "timeOfDay": "时间",
      "summary": "本场剧情",
      "emotionalBeat": "情绪推进",
      "voiceover": "画外音，没有则留空",
      "durationSeconds": ${settings.defaultShotDurationSeconds * settings.maxShotsPerScene},
      "dialogue": [
        {
          "character": "角色名",
          "line": "台词",
          "performanceNote": "表演说明，没有则留空"
        }
      ]
    }
  ]
}

输入内容：
${sourceText}`
    }
  ]);

  const scenes: ScriptScene[] = (payload.scenes ?? []).map((scene, index) => ({
    sceneNumber: index + 1,
    location: normalizeString(scene.location, `场景 ${index + 1}`),
    timeOfDay: normalizeString(scene.timeOfDay, '未说明'),
    summary: normalizeString(scene.summary, '暂无剧情描述'),
    emotionalBeat: normalizeString(scene.emotionalBeat, '情绪持续推进'),
    voiceover: normalizeString(scene.voiceover, ''),
    durationSeconds: normalizeDuration(
      scene.durationSeconds,
      settings.defaultShotDurationSeconds * settings.maxShotsPerScene
    ),
    dialogue: (scene.dialogue ?? []).map((line) => ({
      character: normalizeString(line.character, '旁白'),
      line: normalizeString(line.line, ''),
      performanceNote: normalizeString(line.performanceNote, '')
    }))
  }));

  const scriptCore = {
    title: normalizeString(payload.title, '未命名短剧'),
    tagline: normalizeString(payload.tagline, '高钩子短剧'),
    synopsis: normalizeString(payload.synopsis, '暂无梗概'),
    styleNotes: normalizeString(payload.styleNotes, settings.visualStyle),
    characters: (payload.characters ?? []).map((character, index) => ({
      name: normalizeString(character.name, `角色${index + 1}`),
      identity: normalizeString(character.identity, '身份未说明'),
      visualTraits: normalizeString(character.visualTraits, '外观统一、利于连续生成'),
      motivation: normalizeString(character.motivation, '推动剧情发展')
    })),
    scenes
  };

  return {
    ...scriptCore,
    markdown: formatScriptMarkdown(scriptCore)
  };
}

export async function generateStoryboardFromScript(
  script: ScriptPackage,
  settings: ProjectSettings
): Promise<StoryboardShot[]> {
  const payload = await requestJson<{
    shots?: Array<{
      id?: string;
      sceneNumber?: number;
      shotNumber?: number;
      title?: string;
      purpose?: string;
      durationSeconds?: number;
      dialogue?: string;
      voiceover?: string;
      camera?: string;
      composition?: string;
      transitionHint?: string;
      firstFramePrompt?: string;
      videoPrompt?: string;
    }>;
  }>([
    {
      role: 'system',
      content:
        '你是一名影视分镜导演，负责把短剧剧本拆成适合 AI 生图和 AI 视频的镜头。只输出 JSON，不要输出任何额外说明。'
    },
    {
      role: 'user',
      content: `请根据下面的剧本生成完整分镜。

要求：
1. 每个镜头必须包含首帧生图描述 firstFramePrompt 和视频片段描述 videoPrompt
2. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
3. 镜头数量控制在每场最多 ${settings.maxShotsPerScene} 个
4. durationSeconds 尽量使用 ${settings.defaultShotDurationSeconds} 秒附近的整数
5. 构图、镜头运动、光线、表情、动作都要写清楚
6. 输出结构：
{
  "shots": [
    {
      "id": "scene-1-shot-1",
      "sceneNumber": 1,
      "shotNumber": 1,
      "title": "镜头标题",
      "purpose": "镜头作用",
      "durationSeconds": ${settings.defaultShotDurationSeconds},
      "dialogue": "本镜头核心台词，没有可留空",
      "voiceover": "本镜头画外音，没有可留空",
      "camera": "镜头语言",
      "composition": "构图说明",
      "transitionHint": "转场方式",
      "firstFramePrompt": "用于首帧静态图生成的详细中文提示词",
      "videoPrompt": "用于视频生成的详细中文提示词"
    }
  ]
}

剧本 JSON：
${JSON.stringify(script, null, 2)}`
    }
  ]);

  return (payload.shots ?? []).map((shot, index) => {
    const sceneNumber = normalizeDuration(shot.sceneNumber, Math.floor(index / settings.maxShotsPerScene) + 1);
    const shotNumber = normalizeDuration(shot.shotNumber, (index % settings.maxShotsPerScene) + 1);
    const id =
      normalizeString(shot.id, `scene-${sceneNumber}-shot-${shotNumber}`)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `scene-${sceneNumber}-shot-${shotNumber}`;

    return {
      id,
      sceneNumber,
      shotNumber,
      title: normalizeString(shot.title, `场景${sceneNumber}镜头${shotNumber}`),
      purpose: normalizeString(shot.purpose, '推进剧情'),
      durationSeconds: normalizeDuration(shot.durationSeconds, settings.defaultShotDurationSeconds),
      dialogue: normalizeString(shot.dialogue, ''),
      voiceover: normalizeString(shot.voiceover, ''),
      camera: normalizeString(shot.camera, '中近景，稳定推进'),
      composition: normalizeString(shot.composition, '主体明确，突出人物情绪'),
      transitionHint: normalizeString(shot.transitionHint, 'cut'),
      firstFramePrompt: normalizeString(
        shot.firstFramePrompt,
        `${settings.visualStyle}，场景${sceneNumber}镜头${shotNumber}首帧`
      ),
      videoPrompt: normalizeString(
        shot.videoPrompt,
        `${settings.visualStyle}，场景${sceneNumber}镜头${shotNumber}视频动作描述`
      )
    };
  });
}
