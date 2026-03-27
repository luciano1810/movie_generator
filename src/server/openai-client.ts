import OpenAI from 'openai';
import type {
  LlmModelDiscoveryRequest,
  ProjectReferenceLibrary,
  ProjectSettings,
  ReferenceAssetItem,
  ReferenceAssetKind,
  StoryboardShot,
  ScriptDialogueLine,
  ScriptPackage,
  ScriptScene
} from '../shared/types.js';
import { normalizeStoryboardShots } from '../shared/types.js';
import { getAppSettings } from './app-settings.js';

type ChatCompletionMessageParam = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

function createClient(input?: Partial<LlmModelDiscoveryRequest>): OpenAI {
  const settings = getAppSettings();
  const baseUrl = input?.baseUrl?.trim() || settings.llm.baseUrl;
  const apiKey = input?.apiKey?.trim() || settings.llm.apiKey;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY 未配置，无法执行文本生成阶段。');
  }

  return new OpenAI({
    apiKey,
    baseURL: baseUrl
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

function extractJsonCandidate(raw: string): string {
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

  return jsonText;
}

function findNextSignificantChar(text: string, startIndex: number): string | null {
  const index = findNextSignificantIndex(text, startIndex);
  return index === -1 ? null : text[index];
}

function findNextSignificantIndex(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (!/\s/.test(char)) {
      return index;
    }
  }

  return -1;
}

function looksLikeStandaloneQuotedToken(text: string, startIndex: number): boolean {
  let escapeNext = false;

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      const nextSignificantChar = findNextSignificantChar(text, index + 1);
      return (
        nextSignificantChar === null ||
        nextSignificantChar === ':' ||
        nextSignificantChar === ',' ||
        nextSignificantChar === '}' ||
        nextSignificantChar === ']'
      );
    }
  }

  return false;
}

function isValueStartChar(char: string): boolean {
  return (
    char === '"' ||
    char === '{' ||
    char === '[' ||
    char === '-' ||
    (char >= '0' && char <= '9') ||
    char === 't' ||
    char === 'f' ||
    char === 'n'
  );
}

function isValueTerminatorChar(char: string | null): boolean {
  if (!char) {
    return false;
  }

  return (
    char === '"' ||
    char === '}' ||
    char === ']' ||
    char === 'e' ||
    char === 'l' ||
    (char >= '0' && char <= '9')
  );
}

function repairJsonText(text: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;
  let lastSignificantChar: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escapeNext) {
        result += char;
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        result += char;
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        const nextSignificantIndex = findNextSignificantIndex(text, index + 1);
        const nextSignificantChar = nextSignificantIndex === -1 ? null : text[nextSignificantIndex];

        if (
          nextSignificantChar === null ||
          nextSignificantChar === ',' ||
          nextSignificantChar === ':' ||
          nextSignificantChar === '}' ||
          nextSignificantChar === ']' ||
          (nextSignificantChar === '"' && looksLikeStandaloneQuotedToken(text, nextSignificantIndex))
        ) {
          result += char;
          inString = false;
          lastSignificantChar = char;
        } else {
          result += '\\"';
        }

        continue;
      }

      if (char === '\r') {
        result += text[index + 1] === '\n' ? '\\n' : '\\r';
        if (text[index + 1] === '\n') {
          index += 1;
        }
        continue;
      }

      if (char === '\n') {
        result += '\\n';
        continue;
      }

      if (char === '\t') {
        result += '\\t';
        continue;
      }

      result += char;
      continue;
    }

    if (isValueStartChar(char) && isValueTerminatorChar(lastSignificantChar)) {
      result += ',';
      lastSignificantChar = ',';
    }

    if (char === '"') {
      result += char;
      inString = true;
      continue;
    }

    if (char === ',') {
      const nextSignificantChar = findNextSignificantChar(text, index + 1);
      if (nextSignificantChar === '}' || nextSignificantChar === ']') {
        continue;
      }
    }

    result += char;

    if (!/\s/.test(char)) {
      lastSignificantChar = char;
    }
  }

  return result;
}

function buildJsonParseError(error: unknown, jsonText: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const positionMatch = message.match(/position (\d+)/);

  if (!positionMatch) {
    return new Error(`JSON 解析失败：${message}`);
  }

  const position = Number(positionMatch[1]);
  const snippetStart = Math.max(0, position - 80);
  const snippetEnd = Math.min(jsonText.length, position + 80);
  const snippet = jsonText
    .slice(snippetStart, snippetEnd)
    .replace(/\s+/g, ' ')
    .trim();

  return new Error(`JSON 解析失败：${message}。出错附近片段：${snippet}`);
}

function parseJsonPayload<T>(raw: string): T {
  const jsonText = extractJsonCandidate(raw);

  try {
    return JSON.parse(jsonText) as T;
  } catch (initialError) {
    const repairedJsonText = repairJsonText(jsonText);

    if (repairedJsonText !== jsonText) {
      try {
        return JSON.parse(repairedJsonText) as T;
      } catch (repairedError) {
        throw buildJsonParseError(repairedError, repairedJsonText);
      }
    }

    throw buildJsonParseError(initialError, jsonText);
  }
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeDuration(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function makeReferenceId(prefix: string, value: string, index: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || index + 1}`;
}

function createReferenceItem(
  kind: ReferenceAssetKind,
  name: string,
  summary: string,
  generationPrompt: string,
  index: number
): ReferenceAssetItem {
  return {
    id: makeReferenceId(kind, name, index),
    kind,
    name,
    summary,
    generationPrompt,
    status: 'idle',
    error: null,
    updatedAt: new Date().toISOString(),
    referenceImage: null,
    asset: null,
    assetHistory: []
  };
}

function normalizeSceneReferencePrompt(
  value: unknown,
  settings: ProjectSettings,
  fallbackName: string
): string {
  const base = normalizeString(
    value,
    `${settings.visualStyle}，${fallbackName}，场景空间设定图，空镜环境，无人物，无剧情行为，无事件瞬间，突出建筑结构、空间层次、材质、光线与氛围`
  );

  const requiredHints = ['空镜环境', '无人物', '无剧情行为', '无事件瞬间'];
  if (requiredHints.every((hint) => base.includes(hint))) {
    return base;
  }

  return `${base}。场景参考图要求：空镜环境，无人物，无剧情行为，无事件瞬间，仅表现可复用的空间结构、材质、灯光与氛围。`;
}

async function requestJson<T>(messages: ChatCompletionMessageParam[]): Promise<T> {
  const client = createClient();
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

export async function discoverAvailableModels(
  input: Partial<LlmModelDiscoveryRequest>
): Promise<string[]> {
  const baseUrl = input.baseUrl?.trim();
  const apiKey = input.apiKey?.trim();

  if (!baseUrl) {
    throw new Error('LLM Base URL 不能为空。');
  }

  if (!apiKey) {
    throw new Error('LLM API Key 不能为空。');
  }

  const client = createClient({
    baseUrl,
    apiKey
  });
  const response = await client.models.list();

  return response.data
    .map((model) => model.id?.trim() ?? '')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export async function extractReferenceLibraryFromScript(
  script: ScriptPackage,
  settings: ProjectSettings
): Promise<ProjectReferenceLibrary> {
  const payload = await requestJson<{
    characters?: Array<{
      name?: string;
      summary?: string;
      generationPrompt?: string;
    }>;
    scenes?: Array<{
      name?: string;
      summary?: string;
      generationPrompt?: string;
    }>;
    objects?: Array<{
      name?: string;
      summary?: string;
      generationPrompt?: string;
    }>;
  }>([
    {
      role: 'system',
      content:
        '你是一名影视美术设定导演。请基于剧本提取可单独生成参考资产的角色、场景和关键物品。只输出 JSON，不要输出额外解释。'
    },
    {
      role: 'user',
      content: `请根据下面剧本提取三类可生成资产：

1. characters：核心角色，用于角色定妆和统一形象
2. scenes：核心场景，用于场景设定图
3. objects：关键物品或道具，只保留推动剧情的重要物件

要求：
1. characters.generationPrompt 由你在这个阶段直接生成人物外貌特点，供“无参考图角色三视图生成”与后续首帧/视频生成功能共用；只写稳定的人物外观与身份特征，重点描述年龄感、脸型五官、发型、体型、服装、气质、常态表情，不要写三视图、镜头运动或具体剧情动作
2. scenes.generationPrompt 和 objects.generationPrompt 必须适合直接用于 AI 生图，描述清晰、具体、统一，并体现视觉风格：${settings.visualStyle}
3. 场景 prompt 必须和剧情解耦，只生成“空间设定图 / 空镜环境”，不要包含人物、角色名字、剧情动作、冲突、事件瞬间、对白、具体剧情信息
4. 场景 prompt 要强调空间结构、时间、光线、氛围、材质和可复用性，把剧情场面抽象成稳定的环境母版
5. 物品 prompt 要强调材质、状态、摆放方式、特写形式
6. scenes 的 summary 也必须描述空间用途和氛围，不要写剧情作用、事件经过或角色行为
7. 只输出 JSON，结构如下：
{
  "characters": [
    {
      "name": "角色名",
      "summary": "角色作用和外观摘要",
      "generationPrompt": "人物外貌特点提示词，用于无参考图角色三视图生成和后续首帧/视频约束"
    }
  ],
  "scenes": [
    {
      "name": "场景名",
      "summary": "场景作用和核心氛围",
      "generationPrompt": "用于生图的详细提示词"
    }
  ],
  "objects": [
    {
      "name": "物品名",
      "summary": "物品的重要性和状态",
      "generationPrompt": "用于生图的详细提示词"
    }
  ]
}

剧本 JSON：
${JSON.stringify(script, null, 2)}`
    }
  ]);

  const characters = (payload.characters ?? []).map((item, index) =>
    createReferenceItem(
      'character',
      normalizeString(item.name, `角色${index + 1}`),
      normalizeString(item.summary, '核心角色设定'),
      normalizeString(item.generationPrompt, normalizeString(item.summary, `${settings.visualStyle}，人物外观与服装特征稳定设定`)),
      index
    )
  );

  const scenes = (payload.scenes ?? []).map((item, index) =>
    createReferenceItem(
      'scene',
      normalizeString(item.name, `场景${index + 1}`),
      normalizeString(item.summary, '核心场景设定'),
      normalizeSceneReferencePrompt(
        item.generationPrompt,
        settings,
        normalizeString(item.name, `场景${index + 1}`)
      ),
      index
    )
  );

  const objects = (payload.objects ?? []).map((item, index) =>
    createReferenceItem(
      'object',
      normalizeString(item.name, `物品${index + 1}`),
      normalizeString(item.summary, '关键剧情道具'),
      normalizeString(item.generationPrompt, `${settings.visualStyle}，关键道具特写`),
      index
    )
  );

  return {
    characters,
    scenes,
    objects
  };
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

function defaultSceneDurationExample(settings: ProjectSettings): number {
  return Math.max(8, settings.defaultShotDurationSeconds * 2);
}

function getEffectiveMaxVideoSegmentDurationSeconds(settings: ProjectSettings): number {
  return Math.max(
    1,
    getAppSettings().comfyui.maxVideoSegmentDurationSeconds || settings.maxVideoSegmentDurationSeconds
  );
}

function buildScriptOutputSchema(settings: ProjectSettings): string {
  return `{
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
      "durationSeconds": ${defaultSceneDurationExample(settings)},
      "dialogue": [
        {
          "character": "角色名",
          "line": "台词",
          "performanceNote": "表演说明，没有则留空"
        }
      ]
    }
  ]
}`;
}

function buildScriptPromptContext(settings: ProjectSettings): string {
  return `创作约束：
1. 目标受众：${settings.audience}
2. 语气风格：${settings.tone}
3. 视觉调性：${settings.visualStyle}
4. 输出语言：${settings.language}
5. 场景数量由你根据故事复杂度、节奏和信息密度自行决定，不要机械凑固定场次数
6. 每场应具备明确冲突、推进、情绪变化和可分镜化动作
7. durationSeconds 必须给出正整数秒，并按剧情节奏自行决定
8. 人物外观和身份要稳定，便于后续持续生成画面
9. 只输出 JSON，不要输出解释、标题外文本或 Markdown 代码块`;
}

function buildScriptMessages(sourceText: string, settings: ProjectSettings): ChatCompletionMessageParam[] {
  const outputSchema = buildScriptOutputSchema(settings);
  const sharedContext = buildScriptPromptContext(settings);

  if (settings.scriptMode === 'optimize') {
    return [
      {
        role: 'system',
        content:
          '你是一名资深中文短剧剧本医生和总编剧，擅长在保留核心卖点的前提下修复节奏、增强钩子、压缩废戏、强化反转，并把粗稿整理成可直接进入分镜阶段的短剧剧本。只输出 JSON，不要输出任何额外说明。'
      },
      {
        role: 'user',
        content: `请优化下面的短剧文本，使其更适合短视频连载和 AI 分镜生产。

${sharedContext}

优化目标：
1. 保留原文中可成立的核心设定、人物关系、主要事件和情绪走向，不要无故推翻故事根基
2. 优先修复开场不够抓人、冲突不够集中、情绪不够陡、场次重复、对白拖沓的问题
3. 第一场必须尽快给出强钩子、悬念、威胁或利益冲突
4. 每一场都要有明确目标、阻碍、转折或信息增量，避免空转
5. 对白要口语化、短促、利于表演，不要写成长篇讲述
6. 画外音只在必要时使用，避免重复解释画面已经表达的信息
7. 如果原文结构混乱，可以重组场次顺序，但不要丢失关键剧情信息
8. 如果原文缺少必要细节，可以补足角色动机、场景信息和情绪推进，使其成为完整可拍的短剧
9. 场景数量由你根据素材复杂度和叙事节奏自行决定
10. 返回结构必须严格符合以下 JSON：
${outputSchema}

待优化文本：
${sourceText}`
      }
    ];
  }

  return [
    {
      role: 'system',
      content:
        '你是一名资深中文短剧总编剧和项目主笔，擅长把梗概、设定、文案和零散想法发展成高钩子、强反转、强情绪推进、适合短视频连载的成型剧本。只输出 JSON，不要输出任何额外说明。'
    },
    {
      role: 'user',
      content: `请根据下面的素材生成一版完整的短剧剧本。

${sharedContext}

生成目标：
1. 将输入素材扩写为完整短剧，而不是复述原文
2. 第一场必须快速建立人物关系、危机、悬念或利益冲突，让用户愿意继续看
3. 全剧要有持续升级的冲突链路，避免平铺直叙
4. 每场都要服务于主线推进，并给出清晰的情绪变化
5. 角色数量控制在必要范围内，每个核心角色都要有鲜明身份、稳定外观和清晰动机
6. 场景信息要具体到地点、时间和动作状态，方便后续直接拆分镜
7. 对白要短、准、狠，符合短剧节奏，尽量避免大段说明性台词
8. 场景数量由你根据故事长度、节奏和转折密度自行决定
9. 返回结构必须严格符合以下 JSON：
${outputSchema}

输入素材：
${sourceText}`
    }
  ];
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
  }>(buildScriptMessages(sourceText, settings));

  const scenes: ScriptScene[] = (payload.scenes ?? []).map((scene, index) => ({
    sceneNumber: index + 1,
    location: normalizeString(scene.location, `场景 ${index + 1}`),
    timeOfDay: normalizeString(scene.timeOfDay, '未说明'),
    summary: normalizeString(scene.summary, '暂无剧情描述'),
    emotionalBeat: normalizeString(scene.emotionalBeat, '情绪持续推进'),
    voiceover: normalizeString(scene.voiceover, ''),
    durationSeconds: normalizeDuration(scene.durationSeconds, defaultSceneDurationExample(settings)),
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
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);

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
      lastFramePrompt?: string;
      videoPrompt?: string;
      backgroundSoundPrompt?: string;
      speechPrompt?: string;
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
1. 每个镜头必须包含首帧生图描述 firstFramePrompt、尾帧生图描述 lastFramePrompt，以及视频片段描述 videoPrompt
2. 每个镜头必须额外提供 backgroundSoundPrompt，用于描述环境音、动作音、氛围音，不要写人物对白；如果镜头没有台词或旁白，也必须明确写出自然的环境声、动作声和空间氛围声，不能写成静音
3. 每个镜头必须额外提供 speechPrompt，用于描述该镜头的台词/旁白配音方式、语气、节奏、情绪；如果镜头里有人说话，必须通过人物身份、年龄感、外观和气质特征明确当前说话者，不要只写角色名；如果没有台词或旁白，要明确写“无语音内容”
4. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
5. 每场镜头数量由你根据戏剧节奏、信息密度和动作复杂度自行决定，不要机械套固定数量
6. durationSeconds 由你根据剧情节奏、动作复杂度、表演长度自行决定；${settings.defaultShotDurationSeconds} 秒只是常规参考，不是硬限制
7. 当前视频工作流的单次生成上限是 ${maxVideoSegmentDurationSeconds} 秒；这是单次调用上限，不是镜头总时长上限。你必须先按叙事需要决定每个镜头的完整总时长；如果镜头总时长超过这个上限，系统会自动拆段生成并拼接，所以你仍然要输出完整的镜头总时长，并且必须把 lastFramePrompt 写清楚，确保镜头结尾状态明确
8. 构图、镜头运动、光线、表情、动作都要写清楚
9. 输出结构：
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
      "lastFramePrompt": "用于尾帧静态图生成的详细中文提示词，明确镜头结束时的构图、人物状态和环境状态",
      "videoPrompt": "用于视频生成的详细中文提示词",
      "backgroundSoundPrompt": "用于背景声音生成的详细中文提示词；无对白时也要写自然环境声、动作声和空间氛围声，不含人物对白",
      "speechPrompt": "用于台词或旁白配音的详细中文提示词；有语音内容时通过人物特征明确说话者，没有语音内容时明确写无语音"
    }
  ]
}

剧本 JSON：
${JSON.stringify(script, null, 2)}`
    }
  ]);

  return normalizeStoryboardShots(payload.shots ?? [], settings);
}
