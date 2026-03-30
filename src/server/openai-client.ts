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
import {
  STORY_LENGTH_LABELS,
  getStoryLengthReference,
  normalizeStoryboardShot,
  normalizeStoryboardShots
} from '../shared/types.js';
import { getAppSettings } from './app-settings.js';

type ChatCompletionMessageParam = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

interface StructuredJsonRequestOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

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

function balanceJsonClosures(text: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;
  const closingStack: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      result += char;
      inString = true;
      continue;
    }

    if (char === '{') {
      result += char;
      closingStack.push('}');
      continue;
    }

    if (char === '[') {
      result += char;
      closingStack.push(']');
      continue;
    }

    if (char === '}' || char === ']') {
      while (closingStack.length && closingStack[closingStack.length - 1] !== char) {
        result += closingStack.pop();
      }

      if (closingStack.length && closingStack[closingStack.length - 1] === char) {
        closingStack.pop();
        result += char;
      }

      continue;
    }

    result += char;
  }

  if (inString) {
    result += '"';
  }

  while (closingStack.length) {
    result += closingStack.pop();
  }

  return result;
}

function repairMalformedObjectNumberValues(text: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      result += char;
      inString = true;
      continue;
    }

    if (char === ':') {
      result += char;
      const remainder = text.slice(index + 1);
      const malformedNumberMatch = remainder.match(
        /^(\s*-?\d+)\s*,\s*(\d+)(?=\s*(?:,\s*"|[}\]]))/
      );

      if (malformedNumberMatch) {
        const mergedNumber = `${malformedNumberMatch[1]}${malformedNumberMatch[2]}`.replace(/\s+/g, '');
        result += mergedNumber;
        index += malformedNumberMatch[0].length;
      }

      continue;
    }

    result += char;
  }

  return result;
}

function runStructuredJsonRepairPass(text: string): string {
  return balanceJsonClosures(
    repairMalformedObjectNumberValues(repairJsonText(repairMalformedObjectNumberValues(text)))
  );
}

function repairStructuredJsonText(text: string): string {
  let repaired = text;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = runStructuredJsonRepairPass(repaired);

    if (next === repaired) {
      return next;
    }

    repaired = next;
  }

  return repaired;
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
  const repairedJsonText = repairStructuredJsonText(jsonText);

  try {
    return JSON.parse(jsonText) as T;
  } catch (initialError) {
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

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDuration(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeReferenceId(prefix: string, value: string, index: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || 'item'}-${index + 1}`;
}

function createReferenceItem(
  kind: ReferenceAssetKind,
  name: string,
  summary: string,
  generationPrompt: string,
  index: number,
  ethnicityHint = ''
): ReferenceAssetItem {
  return {
    id: makeReferenceId(kind, name, index),
    kind,
    name,
    summary,
    ethnicityHint,
    generationPrompt,
    status: 'idle',
    error: null,
    updatedAt: new Date().toISOString(),
    referenceImage: null,
    referenceAudio: null,
    asset: null,
    assetHistory: []
  };
}

const SCENE_REFERENCE_ANGLE_VARIANTS = [
  {
    label: '主视角',
    promptInstruction:
      '作为同一场景的第 1 个参考角度，以更完整的 establishing 视角呈现空间全貌、主结构和主要纵深关系，保持空镜环境，不要出现人物或剧情瞬间。'
  },
  {
    label: '第二视角',
    promptInstruction:
      '作为同一场景的第 2 个参考角度，从同一空间的另一侧或斜对角重新观察，必须与第 1 个角度明显不同，但保持同一时间、光线、材质与氛围设定；仍然保持空镜环境，不要出现人物或剧情瞬间。'
  }
] as const;

function expandSceneReferenceItems(
  items: Array<{
    name: string;
    summary: string;
    generationPrompt: string;
  }>,
  settings: ProjectSettings
): ReferenceAssetItem[] {
  return items.flatMap((item, index) =>
    SCENE_REFERENCE_ANGLE_VARIANTS.map((variant, variantIndex) =>
      createReferenceItem(
        'scene',
        `${item.name}（${variant.label}）`,
        `${variant.label}：${item.summary}`,
        normalizeSceneReferencePrompt(
          `${item.generationPrompt}。${variant.promptInstruction}`,
          settings,
          item.name
        ),
        index * SCENE_REFERENCE_ANGLE_VARIANTS.length + variantIndex
      )
    )
  );
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

function supportsJsonResponseFormatFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /response_format|json_object|json_schema/i.test(message) &&
    (
      /unsupported|not support|invalid|unknown/i.test(message) ||
      /must be ['"]?json_schema['"]?\s+or\s+['"]?text['"]?/i.test(message) ||
      /expected.+json_schema.+text/i.test(message)
    )
  );
}

function supportsMaxTokensFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /max_tokens|max completion tokens|max_completion_tokens/i.test(message) && /unsupported|not support|invalid|unknown/i.test(message);
}

async function requestJson<T>(
  messages: ChatCompletionMessageParam[],
  options?: StructuredJsonRequestOptions
): Promise<T> {
  const client = createClient();
  const settings = getAppSettings();
  let useJsonResponseFormat = true;
  let useMaxTokens = typeof options?.maxTokens === 'number' && options.maxTokens > 0;
  let response: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;

  while (!response) {
    const request = {
      model: settings.llm.model,
      temperature: options?.temperature ?? 0.6,
      messages,
      ...(useMaxTokens ? { max_tokens: Math.round(options?.maxTokens ?? 0) } : {}),
      ...(useJsonResponseFormat
        ? {
            response_format: {
              type: 'json_object' as const
            }
          }
        : {})
    };

    try {
      response = await client.chat.completions.create(
        request,
        options?.signal
          ? {
              signal: options.signal
            }
          : undefined
      );
    } catch (error) {
      if (useJsonResponseFormat && supportsJsonResponseFormatFallback(error)) {
        useJsonResponseFormat = false;
        continue;
      }

      if (useMaxTokens && supportsMaxTokensFallback(error)) {
        useMaxTokens = false;
        continue;
      }

      throw error;
    }
  }

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
  settings: ProjectSettings,
  options?: {
    signal?: AbortSignal;
  }
): Promise<ProjectReferenceLibrary> {
  const payload = await requestJson<{
    characters?: Array<{
      name?: string;
      summary?: string;
      ethnicityHint?: string;
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
  }>(
    [
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
2. 如果同一个人在剧本中以明显不同年龄段出场，例如童年、少年、成年、中年、老年，characters 必须拆成多个独立资产，不能合并成一个；每个资产只对应一个年龄段，并且 name 必须直接带上年龄段标记，例如“林晚（少年）”“林晚（成年）”
3. characters.summary、characters.ethnicityHint、characters.generationPrompt 都必须严格对应各自年龄段，不要把多个年龄感混在一个人物资产里
4. characters.ethnicityHint 需要额外给出一个简短的人种/族裔提示，用于稳定角色的人群观感、面部特征和肤色倾向；优先依据剧本明确线索，若剧本没有明确写出，可根据角色姓名、时代、地域和语境给出最稳妥的默认提示，使用简短短语即可
5. scenes.generationPrompt 和 objects.generationPrompt 必须适合直接用于 AI 生图，描述清晰、具体、统一，并体现视觉风格：${settings.visualStyle}
6. scenes 这里只提取“基础场景母版”，也就是同一空间在同一时间与氛围设定下可复用的环境本体；不要为它直接写剧情瞬间、人物动作或某个镜头事件
7. 场景 prompt 必须和剧情解耦，只生成“空间设定图 / 空镜环境”，不要包含人物、角色名字、剧情动作、冲突、事件瞬间、对白、具体剧情信息
8. 场景 prompt 要强调空间结构、时间、光线、氛围、材质和可复用性，把剧情场面抽象成稳定的环境母版；后续系统会基于同一个场景母版自动扩成两个不同角度的场景资产，所以这里要先把空间描述写稳定、写完整
9. scenes 的 summary 也必须描述空间用途和氛围，不要写剧情作用、事件经过或角色行为
10. 物品 prompt 要强调材质、状态、摆放方式、特写形式
11. 只输出 JSON，结构如下：
{
  "characters": [
    {
      "name": "角色名（年龄段）",
      "summary": "该年龄段角色作用和外观摘要",
      "ethnicityHint": "简短的人种/族裔提示",
      "generationPrompt": "该年龄段的人物外貌特点提示词，用于无参考图角色三视图生成和后续首帧/视频约束"
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
    ],
    {
      temperature: 0.45,
      signal: options?.signal
    }
  );

  const characters = (payload.characters ?? []).map((item, index) =>
    createReferenceItem(
      'character',
      normalizeString(item.name, `角色${index + 1}`),
      normalizeString(item.summary, '核心角色设定'),
      normalizeString(item.generationPrompt, normalizeString(item.summary, `${settings.visualStyle}，人物外观与服装特征稳定设定`)),
      index,
      normalizeOptionalString(item.ethnicityHint)
    )
  );

  const scenes = expandSceneReferenceItems(
    (payload.scenes ?? []).map((item, index) => ({
      name: normalizeString(item.name, `场景${index + 1}`),
      summary: normalizeString(item.summary, '核心场景设定'),
      generationPrompt: normalizeSceneReferencePrompt(
        item.generationPrompt,
        settings,
        normalizeString(item.name, `场景${index + 1}`)
      )
    })),
    settings
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
  return getStoryLengthReference(settings).defaultSceneDurationSeconds;
}

function getStoryboardShotSplitReferenceSeconds(settings: ProjectSettings): number {
  return getStoryLengthReference(settings).storyboardSplitReferenceSeconds;
}

function getMinimumShotsForScene(scene: ScriptScene, settings: ProjectSettings): number {
  const structureRequirement = getStoryboardStructureRequirement(settings);

  return Math.max(
    structureRequirement.minimumShotsPerScene,
    Math.ceil(scene.durationSeconds / getStoryboardShotSplitReferenceSeconds(settings))
  );
}

function getMinimumStoryboardShotCount(script: ScriptPackage, settings: ProjectSettings): number {
  return script.scenes.reduce((sum, scene) => sum + getMinimumShotsForScene(scene, settings), 0);
}

function getRecommendedMinimumStoryboardShotCount(script: ScriptPackage, settings: ProjectSettings): number {
  const minimumShots = getMinimumStoryboardShotCount(script, settings);
  return Math.max(script.scenes.length * 2, minimumShots);
}

function getPreferredLongShotDurationSeconds(settings: ProjectSettings): number {
  return getStoryLengthReference(settings).preferredLongShotDurationSeconds;
}

function buildStoryboardShotDurationGuideline(
  defaultShotDurationSeconds: number,
  preferredLongShotDurationSeconds: number,
  maxVideoSegmentDurationSeconds: number
): string {
  const preferredUpperBound = Math.min(8, maxVideoSegmentDurationSeconds);
  const preferredLowerBound = Math.min(preferredLongShotDurationSeconds, preferredUpperBound);

  if (preferredLowerBound < preferredUpperBound) {
    return `durationSeconds 由你根据剧情节奏、动作复杂度、表演长度自行决定；${defaultShotDurationSeconds} 秒只是常规参考，不是硬限制。整体上要偏向更完整、更耐看的镜头时长：能用 ${preferredLowerBound} 到 ${preferredUpperBound} 秒完整呈现的动作、表演、停顿、走位或对话，不要轻易压缩成很短的镜头。`;
  }

  return `durationSeconds 由你根据剧情节奏、动作复杂度、表演长度自行决定；${defaultShotDurationSeconds} 秒只是常规参考，但单个镜头必须控制在 ${maxVideoSegmentDurationSeconds} 秒以内，并在这个上限内尽量给足动作、表演、停顿和走位，不要无谓压缩成过短镜头。`;
}

function getStoryLengthScriptStructureRequirement(settings: ProjectSettings): {
  minimumActs: number;
  minimumShotsPerAct: number;
} {
  if (settings.storyLength === 'long') {
    return {
      minimumActs: 7,
      minimumShotsPerAct: 20
    };
  }

  if (settings.storyLength === 'medium') {
    return {
      minimumActs: 5,
      minimumShotsPerAct: 15
    };
  }

  return {
    minimumActs: 3,
    minimumShotsPerAct: 10
  };
}

function getStoryboardStructureRequirement(settings: ProjectSettings): {
  minimumScenes: number;
  minimumShotsPerScene: number;
} {
  if (settings.storyLength === 'long') {
    return {
      minimumScenes: 7,
      minimumShotsPerScene: 20
    };
  }

  if (settings.storyLength === 'medium') {
    return {
      minimumScenes: 5,
      minimumShotsPerScene: 15
    };
  }

  return {
    minimumScenes: 3,
    minimumShotsPerScene: 10
  };
}

function assertStoryboardSourceScriptMeetsStructureRequirement(
  script: ScriptPackage,
  settings: ProjectSettings
): void {
  const requirement = getStoryboardStructureRequirement(settings);

  if (script.scenes.length < requirement.minimumScenes) {
    throw new Error(
      `当前${STORY_LENGTH_LABELS[settings.storyLength]}分镜至少需要 ${requirement.minimumScenes} 个 scene，但剧本只有 ${script.scenes.length} 个 scene。请先重新生成或优化剧本，再执行分镜生成。`
    );
  }
}

function getStoryboardPlanGenerationMaxTokens(minimumShots: number): number {
  return Math.min(16_000, Math.max(4_000, minimumShots * 180));
}

function getStoryboardShotGenerationMaxTokens(): number {
  return 3_500;
}

function buildStoryboardReferenceSelectionId(kind: ReferenceAssetKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

function buildStoryboardReferenceItemDetail(
  item: Pick<ReferenceAssetItem, 'summary' | 'generationPrompt' | 'ethnicityHint'>,
  kind: ReferenceAssetKind
): string {
  if (kind === 'character') {
    return [item.ethnicityHint.trim() ? `人种/族裔提示：${item.ethnicityHint.trim()}` : '', item.generationPrompt.trim() || item.summary.trim()]
      .filter(Boolean)
      .join('；');
  }

  return item.summary.trim() || item.generationPrompt.trim();
}

function buildAvailableStoryboardReferenceAssets(referenceLibrary: ProjectReferenceLibrary): Array<{
  id: string;
  kind: ReferenceAssetKind;
  name: string;
  summary: string;
  detail: string;
}> {
  return ([
    ['character', referenceLibrary.characters],
    ['scene', referenceLibrary.scenes],
    ['object', referenceLibrary.objects]
  ] as Array<[ReferenceAssetKind, ReferenceAssetItem[]]>).flatMap(([kind, items]) =>
    items
      .filter((item) => item.asset)
      .map((item) => ({
        id: buildStoryboardReferenceSelectionId(kind, item.id),
        kind,
        name: item.name.trim(),
        summary: item.summary.trim(),
        detail: buildStoryboardReferenceItemDetail(item, kind)
      }))
  );
}

function getStoryboardAvailableReferenceAssetIdSet(referenceLibrary?: ProjectReferenceLibrary): Set<string> {
  if (!referenceLibrary) {
    return new Set();
  }

  return new Set(buildAvailableStoryboardReferenceAssets(referenceLibrary).map((item) => item.id));
}

function buildStoryboardReferenceLibraryPrompt(referenceLibrary?: ProjectReferenceLibrary): string {
  const availableAssets = referenceLibrary ? buildAvailableStoryboardReferenceAssets(referenceLibrary) : [];

  if (!availableAssets.length) {
    return '当前没有可直接使用的参考资产。';
  }

  const sections = ([
    ['character', '角色资产'],
    ['scene', '场景资产'],
    ['object', '物品资产']
  ] as Array<[ReferenceAssetKind, string]>)
    .map(([kind, label]) => {
      const items = availableAssets.filter((item) => item.kind === kind);

      if (!items.length) {
        return '';
      }

      return [
        `${label}：`,
        ...items.map(
          (item) =>
            `- id: ${item.id} | 名称: ${item.name} | 摘要: ${item.summary || '无'} | 细节: ${item.detail || '无'}`
        )
      ].join('\n');
    })
    .filter(Boolean);

  return sections.join('\n\n');
}

function normalizeStoryboardReferenceAssetIds(
  value: unknown,
  availableReferenceAssetIds?: Set<string>
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];

  if (!availableReferenceAssetIds?.size) {
    return normalized;
  }

  return normalized.filter((item) => availableReferenceAssetIds.has(item));
}

interface StoryboardValidationResult {
  ok: boolean;
  feedback: string;
}

interface StoryboardShotPayload {
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
  useLastFrameReference?: boolean;
  firstFramePrompt?: string;
  lastFramePrompt?: string;
  videoPrompt?: string;
  backgroundSoundPrompt?: string;
  speechPrompt?: string;
  referenceAssetIds?: string[];
}

interface StoryboardPlanShotPayload {
  sceneNumber?: number;
  shotNumber?: number;
  title?: string;
  purpose?: string;
  durationSeconds?: number;
  overview?: string;
}

export interface StoryboardPlanShot {
  id: string;
  sceneNumber: number;
  shotNumber: number;
  title: string;
  purpose: string;
  durationSeconds: number;
  overview: string;
}

interface StoryboardPlanPayload {
  totalShots?: number;
  shots?: StoryboardPlanShotPayload[];
}

interface StoryboardSingleShotPayload {
  shot?: StoryboardShotPayload;
  shots?: StoryboardShotPayload[];
}

interface StoryboardSceneCoverageIssue {
  sceneNumber: number;
  currentShots: number;
  minimumShots: number;
}

interface StoryboardPlanGeneratedEvent {
  planShots: StoryboardPlanShot[];
  totalShots: number;
  totalScenes: number;
  storyboard: StoryboardShot[];
}

interface StoryboardShotStartEvent {
  scene: ScriptScene;
  shotPlan: StoryboardPlanShot;
  globalShotIndex: number;
  totalShots: number;
  storyboard: StoryboardShot[];
  completedShots: number;
  totalScenes: number;
}

interface StoryboardShotGeneratedEvent extends StoryboardShotStartEvent {
  shot: StoryboardShot;
  planShots: StoryboardPlanShot[];
}

interface StoryboardGenerationOptions {
  signal?: AbortSignal;
  referenceLibrary?: ProjectReferenceLibrary;
  onPlanGenerated?: (event: StoryboardPlanGeneratedEvent) => Promise<void> | void;
  onShotStart?: (event: StoryboardShotStartEvent) => Promise<void> | void;
  onShotGenerated?: (event: StoryboardShotGeneratedEvent) => Promise<void> | void;
}

function getStoryboardSceneCoverageIssues(
  script: ScriptPackage,
  shots: Array<Pick<StoryboardShot, 'sceneNumber'>>,
  settings: ProjectSettings
): StoryboardSceneCoverageIssue[] {
  const shotCountByScene = new Map<number, number>();

  for (const shot of shots) {
    shotCountByScene.set(shot.sceneNumber, (shotCountByScene.get(shot.sceneNumber) ?? 0) + 1);
  }

  return script.scenes
    .map((scene) => {
      const currentShots = shotCountByScene.get(scene.sceneNumber) ?? 0;
      const minimumShots = getMinimumShotsForScene(scene, settings);

      if (currentShots >= minimumShots) {
        return null;
      }

      return {
        sceneNumber: scene.sceneNumber,
        currentShots,
        minimumShots
      };
    })
    .filter((issue): issue is StoryboardSceneCoverageIssue => issue !== null);
}

function validateStoryboardAgainstScript(
  script: ScriptPackage,
  shots: StoryboardShot[],
  settings: ProjectSettings,
  availableReferenceAssetIds?: Set<string>
): StoryboardValidationResult {
  if (!shots.length) {
    return {
      ok: false,
      feedback: '没有生成任何镜头。'
    };
  }

  const expectedSceneNumbers = script.scenes.map((scene) => scene.sceneNumber);
  const generatedSceneNumbers = new Set(shots.map((shot) => shot.sceneNumber));
  const missingScenes = expectedSceneNumbers.filter((sceneNumber) => !generatedSceneNumbers.has(sceneNumber));
  const minimumShotCount = getMinimumStoryboardShotCount(script, settings);
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const coverageIssues = getStoryboardSceneCoverageIssues(script, shots, settings);
  const issues: string[] = [];

  if (missingScenes.length) {
    issues.push(`必须覆盖全部场景，当前缺少 sceneNumber: ${missingScenes.join(', ')}`);
  }

  const underCoveredScenes = coverageIssues.filter((issue) => issue.currentShots > 0);
  if (underCoveredScenes.length) {
    issues.push(
      `以下场景镜头数不足：${underCoveredScenes
        .map((issue) => `scene ${issue.sceneNumber} 当前 ${issue.currentShots} 个，至少需要 ${issue.minimumShots} 个`)
        .join('；')}`
    );
  }

  if (shots.length < minimumShotCount) {
    issues.push(`镜头数量过少，当前只有 ${shots.length} 个，至少需要 ${minimumShotCount} 个`);
  }

  const overlongShots = shots
    .filter((shot) => shot.durationSeconds > maxVideoSegmentDurationSeconds)
    .map((shot) => `scene ${shot.sceneNumber} shot ${shot.shotNumber} 为 ${shot.durationSeconds}s`);

  if (overlongShots.length) {
    issues.push(`单个镜头时长不能超过 ${maxVideoSegmentDurationSeconds} 秒，当前超限：${overlongShots.join('；')}`);
  }

  const shotNumbersByScene = new Map<number, number[]>();
  for (const shot of shots) {
    const list = shotNumbersByScene.get(shot.sceneNumber) ?? [];
    list.push(shot.shotNumber);
    shotNumbersByScene.set(shot.sceneNumber, list);
  }

  const invalidShotNumberScenes = Array.from(shotNumbersByScene.entries())
    .filter(([, shotNumbers]) => {
      const sorted = [...shotNumbers].sort((left, right) => left - right);
      return sorted.some((shotNumber, index) => shotNumber !== index + 1);
    })
    .map(([sceneNumber]) => sceneNumber);

  if (invalidShotNumberScenes.length) {
    issues.push(`每场镜头的 shotNumber 必须从 1 连续递增，当前异常场景: ${invalidShotNumberScenes.join(', ')}`);
  }

  if (availableReferenceAssetIds?.size) {
    const missingReferenceShots = shots
      .filter((shot) => !shot.referenceAssetIds.length)
      .map((shot) => `scene ${shot.sceneNumber} shot ${shot.shotNumber}`);

    if (missingReferenceShots.length) {
      issues.push(`每个镜头都必须给出 referenceAssetIds，当前缺失：${missingReferenceShots.join('；')}`);
    }

    const invalidReferenceIds = [...new Set(
      shots.flatMap((shot) => shot.referenceAssetIds.filter((item) => !availableReferenceAssetIds.has(item)))
    )];

    if (invalidReferenceIds.length) {
      issues.push(`referenceAssetIds 只能使用可用资产列表中的 ID，当前存在无效值：${invalidReferenceIds.join(', ')}`);
    }
  }

  const missingLastFrameShots = shots
    .filter((shot) => shot.useLastFrameReference && !shot.lastFramePrompt.trim())
    .map((shot) => `scene ${shot.sceneNumber} shot ${shot.shotNumber}`);

  if (missingLastFrameShots.length) {
    issues.push(`useLastFrameReference 为 true 时必须提供 lastFramePrompt，当前缺失：${missingLastFrameShots.join('；')}`);
  }

  return {
    ok: issues.length === 0,
    feedback: issues.join('；')
  };
}

function normalizeAndFinalizeStoryboardShots(
  inputs: Array<Partial<StoryboardShot> | undefined>,
  settings: ProjectSettings,
  expectedSceneNumbers?: number[],
  availableReferenceAssetIds?: Set<string>
): StoryboardShot[] {
  const expectedSceneNumberSet = expectedSceneNumbers?.length ? new Set(expectedSceneNumbers) : null;
  const normalized = normalizeStoryboardShots(
    inputs.map((input) => ({
      ...(input ?? {}),
      referenceAssetIds: normalizeStoryboardReferenceAssetIds(
        (input as StoryboardShotPayload | undefined)?.referenceAssetIds,
        availableReferenceAssetIds
      )
    })),
    settings
  )
    .filter((shot) => (expectedSceneNumberSet ? expectedSceneNumberSet.has(shot.sceneNumber) : true))
    .sort((left, right) => {
      if (left.sceneNumber !== right.sceneNumber) {
        return left.sceneNumber - right.sceneNumber;
      }

      if (left.shotNumber !== right.shotNumber) {
        return left.shotNumber - right.shotNumber;
      }

      return left.id.localeCompare(right.id, 'zh-CN');
    });
  const shotNumberByScene = new Map<number, number>();

  return normalizeStoryboardShots(
    normalized.map((shot) => {
      const nextShotNumber = (shotNumberByScene.get(shot.sceneNumber) ?? 0) + 1;
      shotNumberByScene.set(shot.sceneNumber, nextShotNumber);

      return {
        ...shot,
        id: `scene-${shot.sceneNumber}-shot-${nextShotNumber}`,
        shotNumber: nextShotNumber
      };
    }),
    settings
  );
}

function normalizeStoryboardShotForGeneration(
  input: Partial<StoryboardShot> | undefined,
  settings: ProjectSettings,
  availableReferenceAssetIds?: Set<string>
): StoryboardShot | null {
  if (!input) {
    return null;
  }

  return normalizeStoryboardShot(
    {
      ...input,
      referenceAssetIds: normalizeStoryboardReferenceAssetIds(
        (input as StoryboardShotPayload | undefined)?.referenceAssetIds,
        availableReferenceAssetIds
      )
    },
    0,
    settings
  );
}

function normalizeStoryboardPlanShot(
  input: StoryboardPlanShotPayload | undefined,
  index: number,
  settings: ProjectSettings
): StoryboardPlanShot {
  const sceneNumber = normalizePositiveInteger(input?.sceneNumber, index + 1);
  const shotNumber = normalizePositiveInteger(input?.shotNumber, 1);
  const title = normalizeString(input?.title, `场景${sceneNumber}镜头${shotNumber}`);

  return {
    id: `scene-${sceneNumber}-shot-${shotNumber}`,
    sceneNumber,
    shotNumber,
    title,
    purpose: normalizeString(input?.purpose, '推进剧情'),
    durationSeconds: normalizeDuration(
      input?.durationSeconds,
      getStoryLengthReference(settings).defaultShotDurationSeconds
    ),
    overview: normalizeString(input?.overview, `${title}，突出关键动作、对白推进和情绪变化。`)
  };
}

function normalizeAndFinalizeStoryboardPlanShots(
  inputs: Array<StoryboardPlanShotPayload | undefined>,
  settings: ProjectSettings,
  expectedSceneNumbers?: number[]
): StoryboardPlanShot[] {
  const expectedSceneNumberSet = expectedSceneNumbers?.length ? new Set(expectedSceneNumbers) : null;
  const normalized = inputs
    .map((input, index) => normalizeStoryboardPlanShot(input, index, settings))
    .filter((shot) => (expectedSceneNumberSet ? expectedSceneNumberSet.has(shot.sceneNumber) : true))
    .sort((left, right) => {
      if (left.sceneNumber !== right.sceneNumber) {
        return left.sceneNumber - right.sceneNumber;
      }

      if (left.shotNumber !== right.shotNumber) {
        return left.shotNumber - right.shotNumber;
      }

      return left.id.localeCompare(right.id, 'zh-CN');
    });
  const shotNumberByScene = new Map<number, number>();

  return normalized.map((shot) => {
    const nextShotNumber = (shotNumberByScene.get(shot.sceneNumber) ?? 0) + 1;
    shotNumberByScene.set(shot.sceneNumber, nextShotNumber);

    return {
      ...shot,
      id: `scene-${shot.sceneNumber}-shot-${nextShotNumber}`,
      shotNumber: nextShotNumber
    };
  });
}

function validateStoryboardPlanAgainstScript(
  script: ScriptPackage,
  shots: StoryboardPlanShot[],
  settings: ProjectSettings,
  declaredTotalShots?: number
): StoryboardValidationResult {
  if (!shots.length) {
    return {
      ok: false,
      feedback: '没有生成任何分镜规划。'
    };
  }

  const expectedSceneNumbers = script.scenes.map((scene) => scene.sceneNumber);
  const generatedSceneNumbers = new Set(shots.map((shot) => shot.sceneNumber));
  const missingScenes = expectedSceneNumbers.filter((sceneNumber) => !generatedSceneNumbers.has(sceneNumber));
  const minimumShotCount = getMinimumStoryboardShotCount(script, settings);
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const coverageIssues = getStoryboardSceneCoverageIssues(script, shots, settings);
  const issues: string[] = [];

  if (missingScenes.length) {
    issues.push(`必须覆盖全部场景，当前缺少 sceneNumber: ${missingScenes.join(', ')}`);
  }

  const underCoveredScenes = coverageIssues.filter((issue) => issue.currentShots > 0);
  if (underCoveredScenes.length) {
    issues.push(
      `以下场景镜头数不足：${underCoveredScenes
        .map((issue) => `scene ${issue.sceneNumber} 当前 ${issue.currentShots} 个，至少需要 ${issue.minimumShots} 个`)
        .join('；')}`
    );
  }

  if (shots.length < minimumShotCount) {
    issues.push(`镜头数量过少，当前只有 ${shots.length} 个，至少需要 ${minimumShotCount} 个`);
  }

  if (typeof declaredTotalShots === 'number' && declaredTotalShots !== shots.length) {
    issues.push(`totalShots 必须等于 shots.length，当前声明为 ${declaredTotalShots}，实际为 ${shots.length}`);
  }

  const overlongShots = shots
    .filter((shot) => shot.durationSeconds > maxVideoSegmentDurationSeconds)
    .map((shot) => `scene ${shot.sceneNumber} shot ${shot.shotNumber} 为 ${shot.durationSeconds}s`);

  if (overlongShots.length) {
    issues.push(`单个镜头时长不能超过 ${maxVideoSegmentDurationSeconds} 秒，当前超限：${overlongShots.join('；')}`);
  }

  return {
    ok: issues.length === 0,
    feedback: issues.join('；')
  };
}

function validateStoryboardShotAgainstPlan(
  shot: StoryboardShot,
  plan: StoryboardPlanShot,
  settings: ProjectSettings,
  availableReferenceAssetIds?: Set<string>
): StoryboardValidationResult {
  const issues: string[] = [];
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);

  if (shot.sceneNumber !== plan.sceneNumber) {
    issues.push(`sceneNumber 必须为 ${plan.sceneNumber}，当前为 ${shot.sceneNumber}`);
  }

  if (shot.shotNumber !== plan.shotNumber) {
    issues.push(`shotNumber 必须为 ${plan.shotNumber}，当前为 ${shot.shotNumber}`);
  }

  if (shot.durationSeconds !== plan.durationSeconds) {
    issues.push(`durationSeconds 必须为规划中的 ${plan.durationSeconds}，当前为 ${shot.durationSeconds}`);
  }

  if (shot.durationSeconds > maxVideoSegmentDurationSeconds) {
    issues.push(`单个镜头时长不能超过 ${maxVideoSegmentDurationSeconds} 秒，当前为 ${shot.durationSeconds} 秒`);
  }

  if (availableReferenceAssetIds?.size) {
    if (!shot.referenceAssetIds.length) {
      issues.push('referenceAssetIds 不能为空，必须从可用参考资产列表中选择实际需要的资产');
    }

    const invalidReferenceIds = shot.referenceAssetIds.filter((item) => !availableReferenceAssetIds.has(item));
    if (invalidReferenceIds.length) {
      issues.push(`referenceAssetIds 只能使用可用资产列表中的 ID，当前存在无效值：${invalidReferenceIds.join(', ')}`);
    }
  }

  if (shot.useLastFrameReference && !shot.lastFramePrompt.trim()) {
    issues.push('useLastFrameReference 为 true 时必须提供 lastFramePrompt');
  }

  return {
    ok: issues.length === 0,
    feedback: issues.join('；')
  };
}

function buildStoryboardConversationPrelude(
  script: ScriptPackage,
  settings: ProjectSettings,
  referenceLibrary?: ProjectReferenceLibrary
): ChatCompletionMessageParam[] {
  const structureRequirement = getStoryboardStructureRequirement(settings);
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const splitReferenceSeconds = getStoryboardShotSplitReferenceSeconds(settings);
  const recommendedMinimumShotCount = getRecommendedMinimumStoryboardShotCount(script, settings);
  const preferredLongShotDurationSeconds = getPreferredLongShotDurationSeconds(settings);
  const defaultShotDurationSeconds = getStoryLengthReference(settings).defaultShotDurationSeconds;
  const shotDurationGuideline = buildStoryboardShotDurationGuideline(
    defaultShotDurationSeconds,
    preferredLongShotDurationSeconds,
    maxVideoSegmentDurationSeconds
  );
  const sceneRules = script.scenes
    .map(
      (scene) =>
        `- 场景 ${scene.sceneNumber}（${scene.durationSeconds}s）：至少 ${getMinimumShotsForScene(scene, settings)} 个镜头`
    )
    .join('\n');

  return [
    {
      role: 'system',
      content:
        '你是一名影视分镜导演，负责把短剧剧本拆成适合 AI 生图和 AI 视频的镜头。接下来会通过多轮对话先完成全局拆镜规划，再逐轮生成单个完整镜头。每一轮都只输出当前要求的 JSON，不要输出任何额外说明。'
    },
    {
      role: 'user',
      content: `我们将通过多轮对话完成整部短剧分镜。第 1 轮先输出整部剧的分镜规划，必须给出总镜头数和每个镜头的概况；从第 2 轮开始，我会按规划顺序逐轮向你索取单个完整镜头，你必须在连续多轮中保持人物外观、服装、道具、空间关系和情绪推进一致。

全局要求：
1. 每个镜头必须包含起始参考帧描述 firstFramePrompt、布尔字段 useLastFrameReference，以及视频片段描述 videoPrompt；只有在镜头确实需要明确结束画面约束时，才把 useLastFrameReference 设为 true 并提供 lastFramePrompt，否则设为 false 且 lastFramePrompt 置空字符串
2. 每个镜头必须额外提供 backgroundSoundPrompt，用于描述环境音、动作音、氛围音，不要写人物对白；如果镜头没有台词或旁白，也必须明确写出自然的环境声、动作声和空间氛围声，不能写成静音
3. 每个镜头必须额外提供 speechPrompt，用于描述该镜头的台词/旁白配音方式、语气、节奏、情绪；如果镜头里有人说话，必须通过人物身份、年龄感、外观和气质特征明确当前说话者，不要只写角色名；如果没有台词或旁白，要明确写“无语音内容”
4. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
5. 项目篇幅为 ${STORY_LENGTH_LABELS[settings.storyLength]}，全剧至少需要 ${structureRequirement.minimumScenes} 个 scene，且每个 scene 至少 ${structureRequirement.minimumShotsPerScene} 个镜头；当前剧本共有 ${script.scenes.length} 个场景，你必须在多轮对话结束后完整覆盖全部场景，不得跳场，也不得把任何一场压缩到低于这个镜头下限
6. 镜头数量不要预设上限，由你根据戏剧节奏、信息密度、动作复杂度、对白来回和情绪变化自行决定；但镜头颗粒度不能过粗。当前剧本总时长约 ${script.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)} 秒，全剧至少需要 ${recommendedMinimumShotCount} 个镜头，避免把多个戏剧节拍硬塞进一个镜头，也不要把本可在一个连续镜头内完成的动作、反应和情绪停顿机械切碎
7. 分场最低镜头数要求如下：
${sceneRules}
8. ${splitReferenceSeconds} 秒左右只是判断是否该继续拆镜的参考尺度，不是硬性时长限制；包含对话来回、动作升级、信息反转、人物进出场的场景要继续拆开，不要把多个戏剧节拍塞进一个镜头；但同一段连续动作、同一次反应链、同一段情绪发酵，优先留在一个镜头内部完成，避免频繁硬切
9. ${shotDurationGuideline}
10. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；这是硬上限，不是建议值。任何一个镜头的 durationSeconds 都不能超过它；如果一段动作、对白或情绪变化超出这个上限，你必须主动拆成多个镜头，不要依赖系统自动拼接兜底
11. 构图、镜头运动、光线、表情、动作的起势、过程、停顿和收势都要写清楚，避免动作刚开始就立刻结束，避免镜头内状态跳变过猛
12. firstFramePrompt 不能只写剧情摘要或抽象事件，必须写成可直接生图的起始参考帧画面说明：明确景别、机位、构图、主体位置、人物外观与姿态、视线、表情、手部动作、关键道具、前中后景层次、环境细节、时间与光线，并冻结在镜头起始瞬间；它必须对应一张单张电影级静帧，不能写成海报、拼贴、多联画、设定板、字幕画面或概念草图
13. 只有在镜头需要明确落幅、动作落点、收束构图、镜头终点状态或不提供结束参考帧就容易跑偏时，才把 useLastFrameReference 设为 true；不要机械地给每个镜头都加尾帧约束
14. 当 useLastFrameReference 为 true 时，lastFramePrompt 必须写成可直接生图的结束参考帧画面说明，明确镜头结束时的景别、机位、构图、人物状态、道具状态和环境状态；当 useLastFrameReference 为 false 时，lastFramePrompt 必须输出空字符串
15. videoPrompt 必须先描述镜头本身，再描述人物、动作、表演、环境、光线和氛围。优先从景别、机位、运镜、镜头节奏写起，不要一上来先写剧情摘要或对白内容
16. 人物一致性是硬约束。只要剧本没有明确要求变化，角色的脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和整体气质都必须在多轮对话和相邻镜头中保持稳定
17. videoPrompt 和 speechPrompt 如果需要描述台词内容，不要用中文或英文引号包裹台词文本，直接描述某人说某句话即可
18. 为避免输出过长被截断，在保证可生成性的前提下，每个字段写得具体但紧凑：title、purpose、camera、composition 各 1 句；firstFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt 各 1 到 2 句；只有在 useLastFrameReference 为 true 时才输出 1 到 2 句的 lastFramePrompt，但它必须优先保证画面信息完整，不要偷懒简写成剧情提示
19. 每个镜头必须额外输出 referenceAssetIds 数组，用来指明这个镜头在参考帧/视频生成时要加载哪些参考资产。你必须结合下方“可用参考资产列表”中的名称、类别、摘要和细节判断该镜头实际要用哪些资产，不能只看 ID 猜测
20. referenceAssetIds 只能使用“可用参考资产列表”里给出的 id，不能杜撰新 id；优先包含镜头中实际出现或需要约束的场景、角色和关键物品，保持精简但不要漏掉关键资产
21. 如果同一角色存在多个年龄段资产，必须根据当前 scene 的时间线和剧情阶段选择正确年龄段，不能把少年版和成年版混用
22. 如果同一场景存在多个不同角度的场景资产，只要这些角度都能帮助锁定空间关系、机位方向或环境细节，可以同时选入 referenceAssetIds
23. sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
24. 第 1 轮只输出总镜头数和所有镜头概况，不要提前输出完整镜头字段；后续每一轮只输出当前指定的单个完整镜头 JSON，不能提前生成其他镜头，也不要重复已完成镜头

剧本 JSON：
${JSON.stringify(script, null, 2)}

可用参考资产列表：
${buildStoryboardReferenceLibraryPrompt(referenceLibrary)}`
    }
  ];
}

function buildStoryboardSceneContext(script: ScriptPackage, targetScene: ScriptScene): string {
  const previousScene = script.scenes.find((scene) => scene.sceneNumber === targetScene.sceneNumber - 1);
  const nextScene = script.scenes.find((scene) => scene.sceneNumber === targetScene.sceneNumber + 1);
  const characters = script.characters
    .map(
      (character) =>
        `- ${character.name}｜${character.identity}｜外观：${character.visualTraits}｜动机：${character.motivation}`
    )
    .join('\n');
  const contextScenes = [previousScene, nextScene]
    .filter((scene): scene is ScriptScene => Boolean(scene))
    .map(
      (scene) =>
        `- 场景 ${scene.sceneNumber}｜${scene.location}｜${scene.timeOfDay}｜${scene.summary}｜情绪：${scene.emotionalBeat}`
    )
    .join('\n');

  return `剧本标题：${script.title}
一句话卖点：${script.tagline}
剧情梗概：${script.synopsis}
风格说明：${script.styleNotes}

角色设定：
${characters || '无'}

目标场景：
- 场景 ${targetScene.sceneNumber}
- 地点：${targetScene.location}
- 时间：${targetScene.timeOfDay}
- 时长：${targetScene.durationSeconds}s
- 剧情：${targetScene.summary}
- 情绪推进：${targetScene.emotionalBeat}
- 画外音：${targetScene.voiceover || '无'}
- 对白：
${formatDialogue(targetScene.dialogue)
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')}

相邻场景概览：
${contextScenes || '无相邻场景'}`;
}

function buildStoryboardPlanTurnPrompt(script: ScriptPackage, settings: ProjectSettings, retryFeedback = ''): string {
  const structureRequirement = getStoryboardStructureRequirement(settings);
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const splitReferenceSeconds = getStoryboardShotSplitReferenceSeconds(settings);
  const minimumShotCount = getMinimumStoryboardShotCount(script, settings);
  const recommendedMinimumShotCount = getRecommendedMinimumStoryboardShotCount(script, settings);
  const preferredLongShotDurationSeconds = getPreferredLongShotDurationSeconds(settings);
  const defaultShotDurationSeconds = getStoryLengthReference(settings).defaultShotDurationSeconds;
  const shotDurationGuideline = buildStoryboardShotDurationGuideline(
    defaultShotDurationSeconds,
    preferredLongShotDurationSeconds,
    maxVideoSegmentDurationSeconds
  );
  const retryNotice = retryFeedback
    ? `\n上一次规划结果不合格，必须修正以下问题：\n${retryFeedback}\n本次输出必须一次性给出修正后的完整分镜规划 JSON。\n`
    : '';
  const sceneRules = script.scenes
    .map(
      (scene) =>
        `- 场景 ${scene.sceneNumber}（${scene.durationSeconds}s）：至少 ${getMinimumShotsForScene(scene, settings)} 个镜头`
    )
    .join('\n');

  return `现在进行第 1 轮：先生成整部短剧的分镜规划。${retryNotice}

要求：
1. 这一轮只能输出整部剧的分镜规划 JSON，必须先明确 totalShots，并给出全部镜头的概况；不要输出 firstFramePrompt、lastFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt、camera、composition、transitionHint 等完整镜头字段
2. 项目篇幅为 ${STORY_LENGTH_LABELS[settings.storyLength]}，全剧至少需要 ${structureRequirement.minimumScenes} 个 scene，且每个 scene 至少 ${structureRequirement.minimumShotsPerScene} 个镜头；当前剧本共有 ${script.scenes.length} 个场景，你必须完整覆盖全部场景，不得跳场
3. 全剧至少需要 ${recommendedMinimumShotCount} 个镜头，且不能低于按场景下限累积出的 ${minimumShotCount} 个镜头
4. 分场最低镜头数要求如下：
${sceneRules}
5. ${splitReferenceSeconds} 秒左右只是判断是否该继续拆镜的参考尺度，不是硬性时长限制；包含对话来回、动作升级、信息反转、人物进出场的场景要继续拆开，不要把多个戏剧节拍塞进一个镜头；但同一段连续动作、同一次反应链、同一段情绪发酵，优先留在一个镜头内部完成，避免频繁硬切
6. ${shotDurationGuideline}
7. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；这是硬上限，不是建议值。任何一个规划镜头的 durationSeconds 都不能超过它
8. 每个规划镜头都要给出 1 句 overview，说明这个镜头的画面焦点、动作/对白推进和情绪/转场作用，概况要具体但紧凑
9. title、purpose、overview 各写 1 句；overview 必须足够支持后续单镜头展开
10. totalShots、sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
11. totalShots 必须严格等于 shots.length
12. shotNumber 必须在每个 scene 内从 1 开始连续递增
13. 输出结构：
{
  "totalShots": ${recommendedMinimumShotCount},
  "shots": [
    {
      "sceneNumber": 1,
      "shotNumber": 1,
      "title": "镜头标题",
      "purpose": "镜头作用",
      "durationSeconds": ${defaultShotDurationSeconds},
      "overview": "这个镜头的画面焦点、动作/对白推进和情绪/转场概况"
    }
  ]
}`;
}

function truncateStoryboardPromptText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildStoryboardScenePlanContext(planShots: StoryboardPlanShot[], sceneNumber: number): string {
  const scenePlanShots = planShots.filter((shot) => shot.sceneNumber === sceneNumber);

  if (!scenePlanShots.length) {
    return '无';
  }

  return scenePlanShots
    .map(
      (shot) =>
        `- shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜时长：${shot.durationSeconds}s｜概况：${shot.overview}`
    )
    .join('\n');
}

function buildStoryboardAdjacentPlanContext(planShots: StoryboardPlanShot[], shotIndex: number): string {
  return [planShots[shotIndex - 1], planShots[shotIndex], planShots[shotIndex + 1]]
    .filter((shot): shot is StoryboardPlanShot => Boolean(shot))
    .map(
      (shot) =>
        `- scene ${shot.sceneNumber} shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜时长：${shot.durationSeconds}s｜概况：${shot.overview}`
    )
    .join('\n');
}

function formatGeneratedStoryboardShotContext(shot: StoryboardShot): string {
  return [
    `- scene ${shot.sceneNumber} shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜时长：${shot.durationSeconds}s`,
    `  对白：${shot.dialogue || '无'}｜画外音：${shot.voiceover || '无'}`,
    `  结束参考帧：${shot.useLastFrameReference ? truncateStoryboardPromptText(shot.lastFramePrompt, 140) : '无'}`,
    `  转场：${shot.transitionHint}`
  ].join('\n');
}

function buildCompletedStoryboardContext(storyboard: StoryboardShot[], currentPlan: StoryboardPlanShot): string {
  if (!storyboard.length) {
    return '当前还没有已完成镜头。';
  }

  const sameSceneShots = storyboard.filter((shot) => shot.sceneNumber === currentPlan.sceneNumber).slice(-2);
  const previousGlobalShot = storyboard.at(-1) ?? null;
  const contextShots = [
    ...sameSceneShots,
    ...(previousGlobalShot && !sameSceneShots.some((shot) => shot.id === previousGlobalShot.id) ? [previousGlobalShot] : [])
  ];

  return contextShots.length
    ? contextShots.map((shot) => formatGeneratedStoryboardShotContext(shot)).join('\n')
    : '当前还没有与本镜头直接相关的已完成镜头。';
}

function buildStoryboardShotTurnPrompt(
  script: ScriptPackage,
  settings: ProjectSettings,
  shotPlan: StoryboardPlanShot,
  planShots: StoryboardPlanShot[],
  shotIndex: number,
  storyboard: StoryboardShot[],
  retryFeedback = ''
): string {
  const scene = script.scenes.find((item) => item.sceneNumber === shotPlan.sceneNumber);

  if (!scene) {
    throw new Error(`分镜生成失败：找不到 sceneNumber = ${shotPlan.sceneNumber} 的剧本场景。`);
  }

  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const splitReferenceSeconds = getStoryboardShotSplitReferenceSeconds(settings);
  const retryNotice = retryFeedback
    ? `\n上一次结果不合格，必须修正以下问题：\n${retryFeedback}\n本次输出必须一次性给出修正后的完整镜头 JSON。\n`
    : '';
  const continuityNotice =
    shotIndex > 0
      ? `前面已经完成了 ${shotIndex}/${planShots.length} 个镜头。你必须延续已建立的人物外观、服装、道具状态、空间关系和情绪推进。`
      : '这是第一个完整镜头，需要为整部短剧建立稳定的人物与视觉基调。';

  return `现在生成第 ${shotIndex + 1}/${planShots.length} 个镜头的完整分镜 JSON。${retryNotice}

${continuityNotice}

当前镜头固定规划：
{
  "sceneNumber": ${shotPlan.sceneNumber},
  "shotNumber": ${shotPlan.shotNumber},
  "title": ${JSON.stringify(shotPlan.title)},
  "purpose": ${JSON.stringify(shotPlan.purpose)},
  "durationSeconds": ${shotPlan.durationSeconds},
  "overview": ${JSON.stringify(shotPlan.overview)}
}

当前场分镜规划：
${buildStoryboardScenePlanContext(planShots, shotPlan.sceneNumber)}

当前镜头前后规划：
${buildStoryboardAdjacentPlanContext(planShots, shotIndex)}

已完成镜头摘要：
${buildCompletedStoryboardContext(storyboard, shotPlan)}

要求：
1. 只能输出这一个镜头的完整 JSON，不能输出其他镜头
2. sceneNumber 必须是 ${shotPlan.sceneNumber}，shotNumber 必须是 ${shotPlan.shotNumber}，title 必须保持为 ${JSON.stringify(shotPlan.title)}，purpose 必须保持为 ${JSON.stringify(shotPlan.purpose)}，durationSeconds 必须保持为 ${shotPlan.durationSeconds}
3. 必须把当前规划里的 overview 展开成完整可执行分镜，但不能偏离该镜头承担的戏剧功能
4. 每个镜头必须包含起始参考帧描述 firstFramePrompt、布尔字段 useLastFrameReference，以及视频片段描述 videoPrompt；只有在镜头确实需要明确结束画面约束时，才把 useLastFrameReference 设为 true 并提供 lastFramePrompt，否则设为 false 且 lastFramePrompt 置空字符串
5. 每个镜头必须额外提供 backgroundSoundPrompt，用于描述环境音、动作音、氛围音，不要写人物对白；如果镜头没有台词或旁白，也必须明确写出自然的环境声、动作声和空间氛围声，不能写成静音
6. 每个镜头必须额外提供 speechPrompt，用于描述该镜头的台词/旁白配音方式、语气、节奏、情绪；如果镜头里有人说话，必须通过人物身份、年龄感、外观和气质特征明确当前说话者，不要只写角色名；如果没有台词或旁白，要明确写无语音内容
7. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
8. ${splitReferenceSeconds} 秒左右只是判断是否该继续拆镜的参考尺度，不是硬性时长限制；当前镜头已经固定为 ${shotPlan.durationSeconds} 秒，你必须在这个时长内把起势、过程、停顿和收势写完整
9. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；当前镜头时长已固定为 ${shotPlan.durationSeconds} 秒，不得改写
10. 构图、镜头运动、光线、表情、动作的起势、过程、停顿和收势都要写清楚，避免动作刚开始就立刻结束，避免镜头内状态跳变过猛
11. firstFramePrompt 不能只写剧情摘要或抽象事件，必须写成可直接生图的起始参考帧画面说明：明确景别、机位、构图、主体位置、人物外观与姿态、视线、表情、手部动作、关键道具、前中后景层次、环境细节、时间与光线，并冻结在镜头起始瞬间；它必须对应一张单张电影级静帧，不能写成海报、拼贴、多联画、设定板、字幕画面或概念草图
12. 只有在镜头需要明确落幅、动作落点、收束构图、镜头终点状态或不提供结束参考帧就容易跑偏时，才把 useLastFrameReference 设为 true；不要机械地给每个镜头都加尾帧约束
13. 当 useLastFrameReference 为 true 时，lastFramePrompt 必须写成可直接生图的结束参考帧画面说明，明确镜头结束时的景别、机位、构图、人物状态、道具状态和环境状态；当 useLastFrameReference 为 false 时，lastFramePrompt 必须输出空字符串
14. videoPrompt 必须先描述镜头本身，再描述人物、动作、表演、环境、光线和氛围。优先从景别、机位、运镜、镜头节奏写起，不要一上来先写剧情摘要或对白内容
15. 人物一致性是硬约束。只要剧本没有明确要求变化，角色的脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和整体气质都必须在当前镜头与已完成镜头之间保持稳定
16. videoPrompt 和 speechPrompt 如果需要描述台词内容，不要用中文或英文引号包裹台词文本，直接描述某人说某句话即可
17. 为避免输出过长被截断，在保证可生成性的前提下，每个字段写得具体但紧凑：title、purpose、camera、composition 各 1 句；firstFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt 各 1 到 2 句；只有在 useLastFrameReference 为 true 时才输出 1 到 2 句的 lastFramePrompt，但它必须优先保证画面信息完整，不要偷懒简写成剧情提示
18. sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
19. 你必须结合上文“可用参考资产列表”里的名称、摘要和细节判断这个镜头该用哪些资产，并把对应 id 写进 referenceAssetIds；不能只看 id 猜测含义
20. 如果同一角色存在多个年龄段资产，必须根据当前 scene 的时间线和剧情阶段选择正确年龄段，不能把少年版和成年版混用
21. 如果同一场景存在多个不同角度的场景资产，只要这些角度都能帮助锁定空间关系、机位方向或环境细节，可以同时选入 referenceAssetIds
22. 输出结构：
{
  "shot": {
    "id": "scene-${shotPlan.sceneNumber}-shot-${shotPlan.shotNumber}",
    "sceneNumber": ${shotPlan.sceneNumber},
    "shotNumber": ${shotPlan.shotNumber},
    "title": ${JSON.stringify(shotPlan.title)},
    "purpose": ${JSON.stringify(shotPlan.purpose)},
    "durationSeconds": ${shotPlan.durationSeconds},
    "dialogue": "本镜头核心台词，没有可留空",
    "voiceover": "本镜头画外音，没有可留空",
    "camera": "镜头语言",
    "composition": "构图说明",
    "transitionHint": "转场方式，优先自然承接、动作延续或情绪延续，避免突兀硬切",
    "useLastFrameReference": true,
    "firstFramePrompt": "用于起始参考帧静态图生成的详细中文提示词，必须是可直接生图的单张电影级静帧说明，不要只写剧情提示，也不要写成海报、拼贴、多联画、设定板或概念草图",
    "lastFramePrompt": "当 useLastFrameReference 为 true 时，用于结束参考帧静态图生成的详细中文提示词；当 useLastFrameReference 为 false 时，必须输出空字符串",
    "videoPrompt": "用于视频生成的详细中文提示词；先写景别、机位、运镜和镜头节奏，再写人物动作、表演、环境、光线和氛围，不要用引号包裹台词文本",
    "backgroundSoundPrompt": "用于背景声音生成的详细中文提示词；无对白时也要写自然环境声、动作声和空间氛围声，不含人物对白",
    "speechPrompt": "用于台词或旁白配音的详细中文提示词；有语音内容时通过人物特征明确说话者，没有语音内容时明确写无语音，不要用引号包裹台词文本",
    "referenceAssetIds": ["scene:场景资产ID", "character:角色资产ID", "object:物品资产ID"]
  }
}

目标场景上下文：
${buildStoryboardSceneContext(script, scene)}`;
}

function buildStoryboardPlanAssistantMessage(planShots: StoryboardPlanShot[]): string {
  return JSON.stringify(
    {
      totalShots: planShots.length,
      shots: planShots.map((shot) => ({
        sceneNumber: shot.sceneNumber,
        shotNumber: shot.shotNumber,
        title: shot.title,
        purpose: shot.purpose,
        durationSeconds: shot.durationSeconds,
        overview: shot.overview
      }))
    },
    null,
    2
  );
}

async function generateStoryboardPlan(
  conversation: ChatCompletionMessageParam[],
  script: ScriptPackage,
  settings: ProjectSettings,
  options?: StoryboardGenerationOptions
): Promise<{ requestPrompt: string; planShots: StoryboardPlanShot[] }> {
  let retryFeedback = '';
  const minimumShots = getMinimumStoryboardShotCount(script, settings);
  const expectedSceneNumbers = script.scenes.map((scene) => scene.sceneNumber);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestPrompt = buildStoryboardPlanTurnPrompt(script, settings, retryFeedback);
    const payload = await requestJson<StoryboardPlanPayload>([...conversation, { role: 'user', content: requestPrompt }], {
      temperature: attempt === 0 ? 0.4 : 0.3,
      maxTokens: getStoryboardPlanGenerationMaxTokens(minimumShots),
      signal: options?.signal
    });

    const planShots = normalizeAndFinalizeStoryboardPlanShots(payload.shots ?? [], settings, expectedSceneNumbers);
    const validation = validateStoryboardPlanAgainstScript(script, planShots, settings, payload.totalShots);

    if (validation.ok) {
      return {
        requestPrompt,
        planShots
      };
    }

    retryFeedback = validation.feedback;
  }

  throw new Error(`分镜规划生成失败：连续多次输出仍不完整。${retryFeedback}`);
}

async function generateStoryboardShot(
  conversation: ChatCompletionMessageParam[],
  script: ScriptPackage,
  settings: ProjectSettings,
  shotPlan: StoryboardPlanShot,
  planShots: StoryboardPlanShot[],
  shotIndex: number,
  storyboard: StoryboardShot[],
  options?: StoryboardGenerationOptions
): Promise<{ requestPrompt: string; shot: StoryboardShot }> {
  let retryFeedback = '';
  const availableReferenceAssetIds = getStoryboardAvailableReferenceAssetIdSet(options?.referenceLibrary);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestPrompt = buildStoryboardShotTurnPrompt(
      script,
      settings,
      shotPlan,
      planShots,
      shotIndex,
      storyboard,
      retryFeedback
    );
    const payload = await requestJson<StoryboardSingleShotPayload>(
      [...conversation, { role: 'user', content: requestPrompt }],
      {
        temperature: attempt === 0 ? 0.4 : 0.3,
        maxTokens: getStoryboardShotGenerationMaxTokens(),
        signal: options?.signal
      }
    );
    const rawShot = payload.shot ?? payload.shots?.[0];

    if (!rawShot) {
      retryFeedback = '没有生成可用的镜头 JSON。';
      continue;
    }

    const normalizedShot = normalizeStoryboardShotForGeneration(
      {
        ...rawShot,
        id: shotPlan.id,
        sceneNumber: shotPlan.sceneNumber,
        shotNumber: shotPlan.shotNumber,
        title: shotPlan.title,
        purpose: shotPlan.purpose,
        durationSeconds: shotPlan.durationSeconds
      },
      settings,
      availableReferenceAssetIds
    );

    if (!normalizedShot) {
      retryFeedback = '没有生成可用的镜头 JSON。';
      continue;
    }

    const validation = validateStoryboardShotAgainstPlan(
      normalizedShot,
      shotPlan,
      settings,
      availableReferenceAssetIds
    );

    if (validation.ok) {
      return {
        requestPrompt,
        shot: normalizedShot
      };
    }

    retryFeedback = validation.feedback;
  }

  throw new Error(
    `scene ${shotPlan.sceneNumber} shot ${shotPlan.shotNumber} 生成失败：连续多次输出仍不完整。${retryFeedback}`
  );
}

function appendStoryboardShot(
  storyboard: StoryboardShot[],
  shot: StoryboardShot,
  settings: ProjectSettings,
  expectedSceneNumbers: number[],
  availableReferenceAssetIds?: Set<string>
): StoryboardShot[] {
  return normalizeAndFinalizeStoryboardShots(
    [...storyboard, shot],
    settings,
    expectedSceneNumbers,
    availableReferenceAssetIds
  );
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
  const structureRequirement = getStoryLengthScriptStructureRequirement(settings);

  return `创作参考：
1. 目标受众：${settings.audience}
2. 语气风格：${settings.tone}
3. 视觉调性：${settings.visualStyle}
4. 输出语言：${settings.language}
5. 项目篇幅为${STORY_LENGTH_LABELS[settings.storyLength]}；结构下限必须达到至少 ${structureRequirement.minimumActs} 幕，每一幕至少具备可支撑 ${structureRequirement.minimumShotsPerAct} 个镜头的剧情、动作、表演和情绪变化。JSON 不需要单独输出“幕”字段，但 scenes 的整体推进必须能清晰分成至少 ${structureRequirement.minimumActs} 幕，而且每一幕都要有足够事件量支撑后续拆镜
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
9. 场景数量由你根据原文素材自然决定，但整体结构不得低于上面给出的篇幅对应幕数与每幕镜头量级下限
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
8. 场景数量由你根据输入素材自然决定，但整体结构不得低于上面给出的篇幅对应幕数与每幕镜头量级下限
9. 返回结构必须严格符合以下 JSON：
${outputSchema}

输入素材：
${sourceText}`
    }
  ];
}

export async function generateScriptFromText(
  sourceText: string,
  settings: ProjectSettings,
  options?: {
    signal?: AbortSignal;
  }
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
  }>(buildScriptMessages(sourceText, settings), {
    temperature: settings.scriptMode === 'generate' ? 0.8 : 0.7,
    signal: options?.signal
  });

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
  settings: ProjectSettings,
  options?: StoryboardGenerationOptions
): Promise<StoryboardShot[]> {
  assertStoryboardSourceScriptMeetsStructureRequirement(script, settings);
  const expectedSceneNumbers = script.scenes.map((scene) => scene.sceneNumber);
  const totalScenes = script.scenes.length;
  const availableReferenceAssetIds = getStoryboardAvailableReferenceAssetIdSet(options?.referenceLibrary);
  const baseConversation = buildStoryboardConversationPrelude(script, settings, options?.referenceLibrary);
  const planResult = await generateStoryboardPlan(baseConversation, script, settings, options);
  const planningConversation = [
    ...baseConversation,
    { role: 'user' as const, content: planResult.requestPrompt },
    { role: 'assistant' as const, content: buildStoryboardPlanAssistantMessage(planResult.planShots) }
  ];
  let storyboard: StoryboardShot[] = [];

  await options?.onPlanGenerated?.({
    planShots: planResult.planShots,
    totalShots: planResult.planShots.length,
    totalScenes,
    storyboard
  });

  for (const [index, shotPlan] of planResult.planShots.entries()) {
    const scene = script.scenes.find((item) => item.sceneNumber === shotPlan.sceneNumber);

    if (!scene) {
      throw new Error(`分镜生成失败：找不到 sceneNumber = ${shotPlan.sceneNumber} 的剧本场景。`);
    }

    await options?.onShotStart?.({
      scene,
      shotPlan,
      globalShotIndex: index + 1,
      totalShots: planResult.planShots.length,
      storyboard,
      completedShots: index,
      totalScenes
    });

    const result = await generateStoryboardShot(
      planningConversation,
      script,
      settings,
      shotPlan,
      planResult.planShots,
      index,
      storyboard,
      options
    );
    storyboard = appendStoryboardShot(
      storyboard,
      result.shot,
      settings,
      expectedSceneNumbers,
      availableReferenceAssetIds
    );

    await options?.onShotGenerated?.({
      scene,
      shotPlan,
      shot: result.shot,
      planShots: planResult.planShots,
      globalShotIndex: index + 1,
      totalShots: planResult.planShots.length,
      storyboard,
      completedShots: index + 1,
      totalScenes
    });
  }

  const validation = validateStoryboardAgainstScript(script, storyboard, settings, availableReferenceAssetIds);
  if (!validation.ok) {
    throw new Error(`分镜生成失败：最终结果不完整。${validation.feedback}`);
  }

  return storyboard;
}
