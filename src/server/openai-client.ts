import OpenAI from 'openai';
import type {
  LlmModelDiscoveryRequest,
  ProjectReferenceLibrary,
  ProjectSettings,
  ReferenceAssetItem,
  ReferenceAssetKind,
  ScriptDialogueLine,
  ScriptPackage,
  ScriptScene,
  ScriptSceneBlock,
  StoryboardDialogueIdentifier,
  StoryboardShot
} from '../shared/types.js';
import {
  DEFAULT_SETTINGS,
  STORY_LENGTH_LABELS,
  getStoryboardShotFallbackDurationSeconds,
  getStoryLengthReference,
  normalizeStoryboardDialogueIdentifier,
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

function normalizeLongTakeIdentifier(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  ethnicityHint = '',
  genderHint = '',
  ageHint = ''
): ReferenceAssetItem {
  return {
    id: makeReferenceId(kind, name, index),
    kind,
    name,
    summary,
    genderHint,
    ageHint,
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
      genderHint?: string;
      ageHint?: string;
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
3. characters.summary、characters.genderHint、characters.ageHint、characters.ethnicityHint、characters.generationPrompt 都必须严格对应各自年龄段，不要把多个年龄感混在一个人物资产里
4. characters.genderHint 需要给出一个简短稳定的性别提示，例如“女性”“男性”“少女”“男孩”，不要写成长句
5. characters.ageHint 需要给出一个简短稳定的年龄阶段提示，例如“8岁儿童”“16岁少女”“30岁成年女性”“50岁中年男性”，必须和该人物资产对应的年龄段完全一致
6. characters.ethnicityHint 需要额外给出一个简短的人种/族裔提示，用于稳定角色的人群观感、面部特征和肤色倾向；优先依据剧本明确线索，若剧本没有明确写出，可根据角色姓名、时代、地域和语境给出最稳妥的默认提示，使用简短短语即可
7. scenes.generationPrompt 和 objects.generationPrompt 必须适合直接用于 AI 生图，描述清晰、具体、统一，并体现视觉风格：${settings.visualStyle}
8. scenes 这里只提取“基础场景母版”，也就是同一空间在同一时间与氛围设定下可复用的环境本体；不要为它直接写剧情瞬间、人物动作或某个镜头事件
9. 场景 prompt 必须和剧情解耦，只生成“空间设定图 / 空镜环境”，不要包含人物、角色名字、剧情动作、冲突、事件瞬间、对白、具体剧情信息
10. 场景 prompt 要强调空间结构、时间、光线、氛围、材质和可复用性，把剧情场面抽象成稳定的环境母版；后续系统会基于同一个场景母版自动扩成两个不同角度的场景资产，所以这里要先把空间描述写稳定、写完整
11. scenes 的 summary 也必须描述空间用途和氛围，不要写剧情作用、事件经过或角色行为
12. 物品 prompt 要强调材质、状态、摆放方式、特写形式
13. 只输出 JSON，结构如下：
{
  "characters": [
    {
      "name": "角色名（年龄段）",
      "summary": "该年龄段角色作用和外观摘要",
      "genderHint": "简短的性别提示",
      "ageHint": "简短的年龄阶段提示",
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
      normalizeOptionalString(item.ethnicityHint),
      normalizeOptionalString(item.genderHint),
      normalizeOptionalString(item.ageHint)
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

function normalizeScriptSceneBlockType(value: unknown): ScriptSceneBlock['type'] | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_');

  if (
    normalized === 'action' ||
    normalized === 'stage_direction' ||
    normalized === 'scene_action' ||
    normalized === 'description' ||
    normalized === '动作'
  ) {
    return 'action';
  }

  if (normalized === 'dialogue' || normalized === 'dialog' || normalized === 'speech' || normalized === '对白') {
    return 'dialogue';
  }

  if (
    normalized === 'voiceover' ||
    normalized === 'voice_over' ||
    normalized === 'vo' ||
    normalized === 'v_o' ||
    normalized === '旁白' ||
    normalized === '画外音'
  ) {
    return 'voiceover';
  }

  if (normalized === 'transition' || normalized === 'cut' || normalized === '转场') {
    return 'transition';
  }

  return null;
}

function buildFallbackSceneHeading(location: string, timeOfDay: string): string {
  const resolvedLocation = location.trim() || '未说明场景';
  const resolvedTimeOfDay = timeOfDay.trim() || '未说明时间';
  return `${resolvedLocation} - ${resolvedTimeOfDay}`;
}

function normalizeScriptSceneBlocks(value: unknown): ScriptSceneBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return null;
      }

      const input = block as Record<string, unknown>;
      const type = normalizeScriptSceneBlockType(input.type);

      if (!type) {
        return null;
      }

      const text = normalizeOptionalString(input.text) || normalizeOptionalString(input.line);

      if (!text) {
        return null;
      }

      if (type === 'dialogue') {
        return {
          type,
          character: normalizeString(input.character, '角色'),
          text,
          parenthetical: normalizeOptionalString(input.parenthetical) || normalizeOptionalString(input.performanceNote)
        } satisfies ScriptSceneBlock;
      }

      if (type === 'voiceover') {
        return {
          type,
          character: normalizeString(input.character, '旁白'),
          text
        } satisfies ScriptSceneBlock;
      }

      return {
        type,
        text
      } satisfies ScriptSceneBlock;
    })
    .filter((block): block is ScriptSceneBlock => block !== null);
}

function deriveSceneDialogueFromBlocks(scriptBlocks: ScriptSceneBlock[]): ScriptDialogueLine[] {
  return scriptBlocks
    .filter((block): block is Extract<ScriptSceneBlock, { type: 'dialogue' }> => block.type === 'dialogue')
    .map((block) => ({
      character: normalizeString(block.character, '角色'),
      line: normalizeString(block.text, ''),
      performanceNote: normalizeOptionalString(block.parenthetical)
    }))
    .filter((line) => Boolean(line.line));
}

function deriveSceneVoiceoverFromBlocks(scriptBlocks: ScriptSceneBlock[]): string {
  return scriptBlocks
    .filter((block): block is Extract<ScriptSceneBlock, { type: 'voiceover' }> => block.type === 'voiceover')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n');
}

function buildLegacySceneBlocks(scene: Pick<ScriptScene, 'summary' | 'dialogue' | 'voiceover'>): ScriptSceneBlock[] {
  const blocks: ScriptSceneBlock[] = [];

  if (scene.summary.trim()) {
    blocks.push({
      type: 'action',
      text: scene.summary.trim()
    });
  }

  for (const line of scene.dialogue) {
    if (!line.line.trim()) {
      continue;
    }

    blocks.push({
      type: 'dialogue',
      character: line.character.trim() || '角色',
      text: line.line.trim(),
      parenthetical: line.performanceNote.trim()
    });
  }

  if (scene.voiceover.trim()) {
    blocks.push({
      type: 'voiceover',
      character: '旁白',
      text: scene.voiceover.trim()
    });
  }

  return blocks;
}

function getSceneBlocksForRendering(scene: Pick<ScriptScene, 'summary' | 'dialogue' | 'voiceover' | 'scriptBlocks'>): ScriptSceneBlock[] {
  const scriptBlocks = Array.isArray(scene.scriptBlocks) ? scene.scriptBlocks : [];
  return scriptBlocks.length ? scriptBlocks : buildLegacySceneBlocks(scene);
}

function formatScriptSceneBlock(block: ScriptSceneBlock): string {
  if (block.type === 'action') {
    return block.text;
  }

  if (block.type === 'dialogue') {
    const parenthetical = block.parenthetical ? `\n（${block.parenthetical}）` : '';
    return `${block.character}${parenthetical}\n${block.text}`;
  }

  if (block.type === 'voiceover') {
    const speaker = block.character.trim() ? `${block.character}（V.O.）` : '旁白（V.O.）';
    return `${speaker}\n${block.text}`;
  }

  return `转场：${block.text}`;
}

function formatSceneBody(scene: Pick<ScriptScene, 'summary' | 'dialogue' | 'voiceover' | 'scriptBlocks'>): string {
  const blocks = getSceneBlocksForRendering(scene);

  if (!blocks.length) {
    return '暂无剧本正文';
  }

  return blocks.map((block) => formatScriptSceneBlock(block)).join('\n\n');
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
        `${scene.sceneHeading || buildFallbackSceneHeading(scene.location, scene.timeOfDay)}\n` +
        `时长 ${scene.durationSeconds}s｜冲突：${scene.conflict || '冲突未说明'}\n` +
        `情绪：${scene.emotionalBeat}｜转折：${scene.turningPoint || '转折未说明'}\n\n` +
        `${formatSceneBody(scene)}`
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

function buildStoryboardShotDurationGuideline(maxVideoSegmentDurationSeconds: number): string {
  return `每个镜头的 durationSeconds 必须由你在分镜时独立决定。项目篇幅只决定整片总量，不决定单个镜头该拍几秒。请根据当前镜头承载的信息量、动作完整度、表演停顿、对白长度、运镜路径和情绪发酵空间自行给出时长；短反应镜头可以更短，完整动作链、对白来回或情绪收束镜头可以更长，但任何一个镜头都不能超过 ${maxVideoSegmentDurationSeconds} 秒。`;
}

function buildStoryboardShotSplitGuideline(): string {
  return '是否继续拆镜只取决于当前内容是否包含多个戏剧节拍、对话来回、动作升级、信息反转或人物进出场，不由项目篇幅档位决定；同一段连续动作、同一次反应链、同一段情绪发酵，优先留在一个镜头内部完成，避免频繁硬切。';
}

function getStoryLengthScriptGenerationTarget(settings: ProjectSettings): {
  minimumScenes: number;
  maximumScenes: number;
  minimumTotalDurationSeconds: number;
  maximumTotalDurationSeconds: number;
  pacingInstruction: string;
} {
  if (settings.storyLength === 'test') {
    return {
      minimumScenes: 2,
      maximumScenes: 2,
      minimumTotalDurationSeconds: 12,
      maximumTotalDurationSeconds: 18,
      pacingInstruction: '这是测试档位，只保留最核心的起因和结果，快速验证整条流程，不要扩写支线或补充额外桥段。'
    };
  }

  if (settings.storyLength === 'long') {
    return {
      minimumScenes: 8,
      maximumScenes: 12,
      minimumTotalDurationSeconds: 600,
      maximumTotalDurationSeconds: 1200,
      pacingInstruction: '允许做多轮升级和更完整的铺垫，但仍然要保持短剧节奏，不要写成传统长剧慢热结构。'
    };
  }

  if (settings.storyLength === 'medium') {
    return {
      minimumScenes: 5,
      maximumScenes: 8,
      minimumTotalDurationSeconds: 240,
      maximumTotalDurationSeconds: 360,
      pacingInstruction: '需要有完整起承转合，但要持续推进主线，不要为了拉长体量硬塞重复桥段。'
    };
  }

  return {
    minimumScenes: 3,
    maximumScenes: 5,
    minimumTotalDurationSeconds: 45,
    maximumTotalDurationSeconds: 75,
    pacingInstruction: '必须直奔主冲突，聚焦单一主线和关键反转，不要扩写支线，不要把短篇写成长篇。'
  };
}

function getStoryboardStructureRequirement(settings: ProjectSettings): {
  minimumScenes: number;
  minimumShotsPerScene: number;
} {
  if (settings.storyLength === 'test') {
    return {
      minimumScenes: 2,
      minimumShotsPerScene: 2
    };
  }

  if (settings.storyLength === 'long') {
    return {
      minimumScenes: 8,
      minimumShotsPerScene: 8
    };
  }

  if (settings.storyLength === 'medium') {
    return {
      minimumScenes: 5,
      minimumShotsPerScene: 5
    };
  }

  return {
    minimumScenes: 3,
    minimumShotsPerScene: 3
  };
}

function describeProjectLanguage(language: string): string {
  const trimmed = language.trim() || DEFAULT_SETTINGS.language;
  const normalized = trimmed.toLowerCase();

  if (normalized.startsWith('zh')) {
    return `中文（${trimmed}）`;
  }

  if (normalized.startsWith('en')) {
    return `英语（${trimmed}）`;
  }

  if (normalized.startsWith('ja')) {
    return `日语（${trimmed}）`;
  }

  if (normalized.startsWith('ko')) {
    return `韩语（${trimmed}）`;
  }

  if (normalized.startsWith('fr')) {
    return `法语（${trimmed}）`;
  }

  if (normalized.startsWith('de')) {
    return `德语（${trimmed}）`;
  }

  if (normalized.startsWith('es')) {
    return `西班牙语（${trimmed}）`;
  }

  if (normalized.startsWith('ru')) {
    return `俄语（${trimmed}）`;
  }

  return trimmed;
}

function buildStoryboardSpokenLanguageRequirement(language: string): string {
  return `dialogue、voiceover 和 speechPrompt 里的语音内容都必须使用项目输出语言 ${describeProjectLanguage(language)}；不要默认写成中文，也不要无故混用其他语言。`;
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
  item: Pick<ReferenceAssetItem, 'summary' | 'generationPrompt' | 'ethnicityHint' | 'genderHint' | 'ageHint'>,
  kind: ReferenceAssetKind
): string {
  if (kind === 'character') {
    return [
      item.genderHint.trim() ? `性别：${item.genderHint.trim()}` : '',
      item.ageHint.trim() ? `年龄：${item.ageHint.trim()}` : '',
      item.ethnicityHint.trim() ? `人种/族裔提示：${item.ethnicityHint.trim()}` : '',
      item.generationPrompt.trim() || item.summary.trim()
    ]
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

interface StoryboardDialogueIdentifierPayload {
  groupId?: string;
}

interface StoryboardShotPayload {
  id?: string;
  sceneNumber?: number;
  shotNumber?: number;
  title?: string;
  purpose?: string;
  durationSeconds?: number;
  dialogueIdentifier?: StoryboardDialogueIdentifierPayload | null;
  longTakeIdentifier?: string | null;
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
  dialogueIdentifier?: StoryboardDialogueIdentifierPayload | null;
  longTakeIdentifier?: string | null;
  overview?: string;
}

export interface StoryboardPlanShot {
  id: string;
  sceneNumber: number;
  shotNumber: number;
  title: string;
  purpose: string;
  durationSeconds: number;
  dialogueIdentifier: StoryboardDialogueIdentifier | null;
  longTakeIdentifier: string | null;
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

interface StoryboardDialogueSequenceShotPayload {
  sceneNumber?: number;
  shotNumber?: number;
  dialogue?: string;
  voiceover?: string;
  camera?: string;
  composition?: string;
  transitionHint?: string;
  promptHint?: string;
}

interface StoryboardDialogueSequencePayload {
  groupId?: string;
  summary?: string;
  continuityNotes?: string;
  shots?: StoryboardDialogueSequenceShotPayload[];
}

interface StoryboardDialogueSequenceShotBrief {
  id: string;
  sceneNumber: number;
  shotNumber: number;
  dialogue: string;
  voiceover: string;
  camera: string;
  composition: string;
  transitionHint: string;
  promptHint: string;
}

interface StoryboardDialogueSequenceBrief {
  groupId: string;
  sceneNumber: number;
  summary: string;
  continuityNotes: string;
  shots: StoryboardDialogueSequenceShotBrief[];
}

interface StoryboardDialogueSequenceGroup {
  groupId: string;
  scene: ScriptScene;
  shots: StoryboardPlanShot[];
}

interface StoryboardDialogueSequenceShotContext {
  group: StoryboardDialogueSequenceBrief;
  shot: StoryboardDialogueSequenceShotBrief;
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
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const issues: string[] = [];

  if (missingScenes.length) {
    issues.push(`必须覆盖全部场景，当前缺少 sceneNumber: ${missingScenes.join(', ')}`);
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

function finalizeStoryboardPlanDialogueIdentifiers(planShots: StoryboardPlanShot[]): StoryboardPlanShot[] {
  const groupedShotIndexes = new Map<string, number[]>();

  planShots.forEach((shot, index) => {
    const groupId = shot.dialogueIdentifier?.groupId;

    if (!groupId) {
      return;
    }

    const groupKey = `${shot.sceneNumber}:${groupId}`;
    const indexes = groupedShotIndexes.get(groupKey) ?? [];
    indexes.push(index);
    groupedShotIndexes.set(groupKey, indexes);
  });

  if (!groupedShotIndexes.size) {
    return planShots;
  }

  return planShots.map((shot, index) => {
    const groupId = shot.dialogueIdentifier?.groupId;

    if (!groupId) {
      return shot;
    }

    const groupKey = `${shot.sceneNumber}:${groupId}`;
    const groupedIndexes = groupedShotIndexes.get(groupKey);

    if (!groupedIndexes?.length) {
      return shot;
    }

    const sequenceIndex = groupedIndexes.indexOf(index) + 1;
    const sequenceLength = groupedIndexes.length;

    return {
      ...shot,
      dialogueIdentifier: normalizeStoryboardDialogueIdentifier({
        groupId,
        sequenceIndex,
        sequenceLength
      })
    };
  });
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
      getStoryboardShotFallbackDurationSeconds(settings)
    ),
    dialogueIdentifier: normalizeStoryboardDialogueIdentifier(input?.dialogueIdentifier),
    longTakeIdentifier: normalizeLongTakeIdentifier(input?.longTakeIdentifier) || null,
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

  return finalizeStoryboardPlanDialogueIdentifiers(normalized.map((shot) => {
    const nextShotNumber = (shotNumberByScene.get(shot.sceneNumber) ?? 0) + 1;
    shotNumberByScene.set(shot.sceneNumber, nextShotNumber);

    return {
      ...shot,
      id: `scene-${shot.sceneNumber}-shot-${nextShotNumber}`,
      shotNumber: nextShotNumber
    };
  }));
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
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const issues: string[] = [];

  if (missingScenes.length) {
    issues.push(`必须覆盖全部场景，当前缺少 sceneNumber: ${missingScenes.join(', ')}`);
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

  const plannedDialogueGroupId = plan.dialogueIdentifier?.groupId ?? '';
  const actualDialogueGroupId = shot.dialogueIdentifier?.groupId ?? '';
  const plannedLongTakeIdentifier = plan.longTakeIdentifier ?? '';
  const actualLongTakeIdentifier = shot.longTakeIdentifier ?? '';

  if (plannedDialogueGroupId !== actualDialogueGroupId) {
    issues.push(
      plannedDialogueGroupId
        ? `dialogueIdentifier.groupId 必须为 ${plannedDialogueGroupId}，当前为 ${actualDialogueGroupId || '空'}`
        : `当前镜头不应输出 dialogueIdentifier，当前为 ${actualDialogueGroupId}`
    );
  }

  if (plannedLongTakeIdentifier !== actualLongTakeIdentifier) {
    issues.push(
      plannedLongTakeIdentifier
        ? `longTakeIdentifier 必须为 ${plannedLongTakeIdentifier}，当前为 ${actualLongTakeIdentifier || '空'}`
        : `当前镜头不应输出 longTakeIdentifier，当前为 ${actualLongTakeIdentifier}`
    );
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
  const spokenLanguageRequirement = buildStoryboardSpokenLanguageRequirement(settings.language);
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const recommendedMinimumShotCount = getRecommendedMinimumStoryboardShotCount(script, settings);
  const shotDurationGuideline = buildStoryboardShotDurationGuideline(maxVideoSegmentDurationSeconds);
  const shotSplitGuideline = buildStoryboardShotSplitGuideline();
  const sceneRules = script.scenes
    .map(
      (scene) =>
        `- 场景 ${scene.sceneNumber}（${scene.durationSeconds}s）：推荐不少于 ${getMinimumShotsForScene(scene, settings)} 个镜头`
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
3. 每个镜头必须额外提供 speechPrompt，用于描述该镜头的台词/旁白配音方式、语气、节奏、情绪；如果镜头里有人说话，必须通过人物身份、年龄感、外观和气质特征明确当前说话者，不要只写角色名；如果没有台词或旁白，要明确写“无语音内容”。${spokenLanguageRequirement}
4. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
5. 项目篇幅为 ${STORY_LENGTH_LABELS[settings.storyLength]}；当前剧本共有 ${script.scenes.length} 个场景，你必须在多轮对话结束后完整覆盖全部现有场景，不得跳场，也不要臆造新的 scene。如果当前剧本场景数低于该篇幅的推荐值，也继续基于现有场景完成拆镜
6. 镜头数量不要预设上限，由你根据戏剧节奏、信息密度、动作复杂度、对白来回和情绪变化自行决定；但镜头颗粒度不能过粗。当前剧本总时长约 ${script.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)} 秒，全剧推荐至少 ${recommendedMinimumShotCount} 个镜头，避免把多个戏剧节拍硬塞进一个镜头，也不要把本可在一个连续镜头内完成的动作、反应和情绪停顿机械切碎；如果实际略少于这个参考值，也不要为了凑数重复镜头或硬塞空镜
7. 分场镜头密度参考如下：
${sceneRules}
8. ${shotSplitGuideline}
9. ${shotDurationGuideline}
10. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；这是硬上限，不是建议值。任何一个镜头的 durationSeconds 都不能超过它；如果一段动作、对白或情绪变化超出这个上限，你必须主动拆成多个镜头，不要依赖系统自动拼接兜底
11. 构图、镜头运动、光线、表情、动作的起势、过程、停顿和收势都要写清楚，避免动作刚开始就立刻结束，避免镜头内状态跳变过猛
12. firstFramePrompt 不能只写剧情摘要或抽象事件，必须写成可直接生图的起始参考帧画面说明：明确景别、机位、构图、主体位置、人物外观与姿态、视线方向、眼神焦点、眼神状态、表情、手部动作、关键道具、前中后景层次、环境细节、时间与光线，并冻结在镜头起始瞬间；它必须对应一张单张电影级静帧，不能写成海报、拼贴、多联画、设定板、字幕画面或概念草图
13. 只有在镜头需要明确落幅、动作落点、收束构图、镜头终点状态或不提供结束参考帧就容易跑偏时，才把 useLastFrameReference 设为 true；不要机械地给每个镜头都加尾帧约束
14. 当 useLastFrameReference 为 true 时，lastFramePrompt 必须写成可直接生图的结束参考帧画面说明，明确镜头结束时的景别、机位、构图、人物状态、视线方向、眼神焦点、眼神状态、道具状态和环境状态；当 useLastFrameReference 为 false 时，lastFramePrompt 必须输出空字符串
15. 如果多个相邻镜头本质上属于同一条连续长镜头，只是为了分段生成或拆分时长才切成多个镜头，必须为这些连续镜头输出相同的 longTakeIdentifier，例如 scene-2-longtake-1；没有这种连续长镜头关系时输出 null
16. 当某个镜头与前一个镜头的 longTakeIdentifier 相同，系统会直接复用前一个镜头视频的尾帧作为当前镜头首帧，不再单独生成当前镜头的起始参考帧；因此只有在画面、机位、动作和空间关系都应连续承接时，才能复用同一个 longTakeIdentifier
17. videoPrompt 必须先描述镜头本身，再描述人物、动作、表演、环境、光线和氛围。优先从景别、机位、运镜、镜头节奏写起，不要一上来先写剧情摘要或对白内容
18. 人物一致性是硬约束。只要剧本没有明确要求变化，角色的脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和整体气质都必须在多轮对话和相邻镜头中保持稳定
19. videoPrompt 和 speechPrompt 如果需要描述台词内容，不要用中文或英文引号包裹台词文本，直接描述某人说某句话即可
20. 为避免输出过长被截断，在保证可生成性的前提下，每个字段写得具体但紧凑：title、purpose、camera、composition 各 1 句；firstFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt 各 1 到 2 句；只有在 useLastFrameReference 为 true 时才输出 1 到 2 句的 lastFramePrompt，但它必须优先保证画面信息完整，不要偷懒简写成剧情提示
21. 如果一个镜头属于同一段连续对白、接话反打、双人来回或以对白反应为核心的连续切镜，必须额外输出 dialogueIdentifier；同一段连续对白里的镜头使用同一个 groupId，例如 scene-2-dialogue-1。非对白镜头或不承担连续对白切换功能的镜头，dialogueIdentifier 输出 null
22. dialogueIdentifier 目前只需要输出 groupId；系统会根据镜头顺序自动补全 sequenceIndex、sequenceLength 和 flowRole。因此不要为同一段连续对白随意改 groupId，也不要把不同对白段混成同一个 groupId
23. 每个镜头必须额外输出 referenceAssetIds 数组，用来指明这个镜头在参考帧/视频生成时要加载哪些参考资产。你必须结合下方“可用参考资产列表”中的名称、类别、摘要和细节判断该镜头实际要用哪些资产，不能只看 ID 猜测
24. referenceAssetIds 只能使用“可用参考资产列表”里给出的 id，不能杜撰新 id；优先包含镜头中实际出现或需要约束的场景、角色和关键物品，保持精简但不要漏掉关键资产
25. 如果同一角色存在多个年龄段资产，必须根据当前 scene 的时间线和剧情阶段选择正确年龄段，不能把少年版和成年版混用
26. 如果同一场景存在多个不同角度的场景资产，只要这些角度都能帮助锁定空间关系、机位方向或环境细节，可以同时选入 referenceAssetIds
27. sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
28. 第 1 轮只输出总镜头数和所有镜头概况，不要提前输出完整镜头字段；后续每一轮只输出当前指定的单个完整镜头 JSON，不能提前生成其他镜头，也不要重复已完成镜头

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
        `- 场景 ${scene.sceneNumber}｜${scene.sceneHeading || buildFallbackSceneHeading(scene.location, scene.timeOfDay)}｜推进：${scene.summary}｜冲突：${scene.conflict || scene.emotionalBeat}`
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
- 场景标头：${targetScene.sceneHeading || buildFallbackSceneHeading(targetScene.location, targetScene.timeOfDay)}
- 地点：${targetScene.location}
- 时间：${targetScene.timeOfDay}
- 时长：${targetScene.durationSeconds}s
- 核心推进：${targetScene.summary}
- 核心冲突：${targetScene.conflict || '冲突未说明'}
- 情绪推进：${targetScene.emotionalBeat}
- 场尾转折：${targetScene.turningPoint || '转折未说明'}
- 剧本正文：
${formatSceneBody(targetScene)
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')}

相邻场景概览：
${contextScenes || '无相邻场景'}`;
}

function buildStoryboardPlanTurnPrompt(script: ScriptPackage, settings: ProjectSettings, retryFeedback = ''): string {
  const spokenLanguageRequirement = buildStoryboardSpokenLanguageRequirement(settings.language);
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const minimumShotCount = getMinimumStoryboardShotCount(script, settings);
  const recommendedMinimumShotCount = getRecommendedMinimumStoryboardShotCount(script, settings);
  const shotDurationGuideline = buildStoryboardShotDurationGuideline(maxVideoSegmentDurationSeconds);
  const shotSplitGuideline = buildStoryboardShotSplitGuideline();
  const retryNotice = retryFeedback
    ? `\n上一次规划结果不合格，必须修正以下问题：\n${retryFeedback}\n本次输出必须一次性给出修正后的完整分镜规划 JSON。\n`
    : '';
  const sceneRules = script.scenes
    .map(
      (scene) =>
        `- 场景 ${scene.sceneNumber}（${scene.durationSeconds}s）：推荐不少于 ${getMinimumShotsForScene(scene, settings)} 个镜头`
    )
    .join('\n');

  return `现在进行第 1 轮：先生成整部短剧的分镜规划。${retryNotice}

要求：
1. 这一轮只能输出整部剧的分镜规划 JSON，必须先明确 totalShots，并给出全部镜头的概况；不要输出 firstFramePrompt、lastFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt、camera、composition、transitionHint 等完整镜头字段
2. 项目篇幅为 ${STORY_LENGTH_LABELS[settings.storyLength]}；当前剧本共有 ${script.scenes.length} 个场景，你必须完整覆盖全部现有场景，不得跳场，也不要臆造新的 scene。如果当前剧本场景数低于该篇幅的推荐值，也继续基于现有场景完成规划
3. 全剧推荐至少 ${recommendedMinimumShotCount} 个镜头，按场景下限累积出的参考值约为 ${minimumShotCount} 个镜头；如果实际略少于这个参考值，也不要为了凑数重复镜头或硬塞空镜
4. 分场镜头密度参考如下：
${sceneRules}
5. ${shotSplitGuideline}
6. ${shotDurationGuideline}
7. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；这是硬上限，不是建议值。任何一个规划镜头的 durationSeconds 都不能超过它
8. 每个规划镜头都要给出 1 句 overview，说明这个镜头的画面焦点、动作/对白推进和情绪/转场作用，概况要具体但紧凑
9. title、purpose、overview 各写 1 句；overview 必须足够支持后续单镜头展开
10. ${spokenLanguageRequirement}
11. totalShots、sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
12. totalShots 必须严格等于 shots.length
13. shotNumber 必须在每个 scene 内从 1 开始连续递增
14. 如果一个规划镜头属于同一段连续对白、接话反打、双人来回或以对白反应为核心的连续切镜，必须输出 dialogueIdentifier，并为这段连续对白保持稳定的 groupId，例如 scene-1-dialogue-1；非此类镜头输出 null
15. 这一轮的 dialogueIdentifier 只需要输出 groupId；系统会根据镜头顺序自动补全 sequenceIndex、sequenceLength 和 flowRole
16. 如果多个相邻镜头本质上属于同一条连续长镜头，只是为了分段生成、拆时长或控制模型稳定性才拆开，必须输出相同的 longTakeIdentifier，例如 scene-1-longtake-1；没有这种关系时输出 null
17. 只有当前镜头与前一个镜头应该无缝连续承接、并且系统需要直接复用前一个视频尾帧作为当前首帧时，才允许复用同一个 longTakeIdentifier；不要把普通切镜误标成长镜头组
18. 输出结构：
{
  "totalShots": ${recommendedMinimumShotCount},
  "shots": [
    {
      "sceneNumber": 1,
      "shotNumber": 1,
      "title": "镜头标题",
      "purpose": "镜头作用",
      "durationSeconds": ${getStoryboardShotFallbackDurationSeconds(settings)},
      "dialogueIdentifier": { "groupId": "scene-1-dialogue-1" },
      "longTakeIdentifier": "scene-1-longtake-1",
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
        `- shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜时长：${shot.durationSeconds}s｜对话标识：${formatStoryboardDialogueIdentifier(shot.dialogueIdentifier)}｜长镜头组：${shot.longTakeIdentifier || '无'}｜概况：${shot.overview}`
    )
    .join('\n');
}

function buildStoryboardAdjacentPlanContext(planShots: StoryboardPlanShot[], shotIndex: number): string {
  return [planShots[shotIndex - 1], planShots[shotIndex], planShots[shotIndex + 1]]
    .filter((shot): shot is StoryboardPlanShot => Boolean(shot))
    .map(
      (shot) =>
        `- scene ${shot.sceneNumber} shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜时长：${shot.durationSeconds}s｜对话标识：${formatStoryboardDialogueIdentifier(shot.dialogueIdentifier)}｜长镜头组：${shot.longTakeIdentifier || '无'}｜概况：${shot.overview}`
    )
    .join('\n');
}

function formatStoryboardDialogueIdentifier(
  identifier: Pick<StoryboardDialogueIdentifier, 'groupId' | 'sequenceIndex' | 'sequenceLength' | 'flowRole'> | null
): string {
  if (!identifier?.groupId) {
    return '无';
  }

  const flowRoleLabel =
    identifier.flowRole === 'single'
      ? '单镜'
      : identifier.flowRole === 'start'
        ? '起始'
        : identifier.flowRole === 'middle'
          ? '中段'
          : '结束';

  return `${identifier.groupId}（${flowRoleLabel} ${identifier.sequenceIndex}/${identifier.sequenceLength}）`;
}

function formatGeneratedStoryboardShotContext(shot: StoryboardShot): string {
  return [
    `- scene ${shot.sceneNumber} shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜时长：${shot.durationSeconds}s`,
    `  对话标识：${formatStoryboardDialogueIdentifier(shot.dialogueIdentifier)}`,
    `  长镜头组：${shot.longTakeIdentifier || '无'}`,
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

function collectStoryboardDialogueSequenceGroups(
  script: ScriptPackage,
  planShots: StoryboardPlanShot[]
): StoryboardDialogueSequenceGroup[] {
  const groups = new Map<string, StoryboardDialogueSequenceGroup>();

  for (const shot of planShots) {
    const groupId = shot.dialogueIdentifier?.groupId;

    if (!groupId) {
      continue;
    }

    const scene = script.scenes.find((item) => item.sceneNumber === shot.sceneNumber);

    if (!scene) {
      continue;
    }

    const groupKey = `${shot.sceneNumber}:${groupId}`;
    const existing = groups.get(groupKey);

    if (existing) {
      existing.shots.push(shot);
      continue;
    }

    groups.set(groupKey, {
      groupId,
      scene,
      shots: [shot]
    });
  }

  return [...groups.values()].filter((group) => group.shots.length >= 2);
}

function buildStoryboardDialogueSequencePlanContext(group: StoryboardDialogueSequenceGroup): string {
  return group.shots
    .map(
      (shot) =>
        `- scene ${shot.sceneNumber} shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜时长：${shot.durationSeconds}s｜概况：${shot.overview}`
    )
    .join('\n');
}

function buildStoryboardDialogueSequenceNeighborContext(
  planShots: StoryboardPlanShot[],
  group: StoryboardDialogueSequenceGroup
): string {
  const firstIndex = planShots.findIndex((shot) => shot.id === group.shots[0]?.id);
  const lastIndex = planShots.findIndex((shot) => shot.id === group.shots.at(-1)?.id);
  const neighbors = [planShots[firstIndex - 1], ...group.shots, planShots[lastIndex + 1]].filter(
    (shot): shot is StoryboardPlanShot => Boolean(shot)
  );

  return neighbors
    .map(
      (shot) =>
        `- scene ${shot.sceneNumber} shot ${shot.shotNumber}｜${shot.title}｜作用：${shot.purpose}｜对话标识：${formatStoryboardDialogueIdentifier(shot.dialogueIdentifier)}｜概况：${shot.overview}`
    )
    .join('\n');
}

function getStoryboardDialogueSequenceGenerationMaxTokens(group: StoryboardDialogueSequenceGroup): number {
  return Math.min(4_000, Math.max(1_800, group.shots.length * 600));
}

function buildStoryboardDialogueSequencePrompt(
  script: ScriptPackage,
  settings: ProjectSettings,
  group: StoryboardDialogueSequenceGroup,
  planShots: StoryboardPlanShot[]
): string {
  const spokenLanguageRequirement = buildStoryboardSpokenLanguageRequirement(settings.language);
  const spokenLanguageLabel = describeProjectLanguage(settings.language);

  return `现在请为一组连续对白镜头生成“对白连续性简报” JSON，帮助后续逐镜头生成时把来回对话拍得连贯自然。

目标对白组：
- groupId: ${group.groupId}
- sceneNumber: ${group.scene.sceneNumber}
- 镜头数: ${group.shots.length}

该对白组镜头规划：
${buildStoryboardDialogueSequencePlanContext(group)}

前后承接规划：
${buildStoryboardDialogueSequenceNeighborContext(planShots, group)}

要求：
1. 只处理这个对白组，不要扩写其他镜头
2. 你需要根据目标场景的原始对白、剧情推进、情绪变化和镜头规划，把这组镜头拆成连续流畅的对白来回与反应链，重点优化接话点、停顿、眼神反打、动作承接、镜头切换理由和节奏递进
3. dialogue 和 voiceover 中的实际语音内容必须使用 ${spokenLanguageLabel}。${spokenLanguageRequirement}
4. 每个镜头都要给出 dialogue，可为空字符串；但如果该镜头承担对白来回、接话、反应后补句或用对白推动冲突，就必须给出紧凑清晰的 dialogue
5. 不要凭空添加关键剧情信息；可以为了镜头拆分，把同一场对白中的句子重新分配到不同镜头，或者把长句压缩成更利于切镜的短句，但不能改变原场景的事件逻辑和人物关系
6. camera、composition、transitionHint、promptHint 必须服务于连续对白拍法，强调轴线、视线方向、人物站位、景别切换、谁接谁的话、在哪里切到反应、如何从上一镜自然进入下一镜
7. camera、composition、transitionHint、promptHint 各写 1 句，具体但紧凑；promptHint 重点写后续生成单镜头 prompt 时必须保留的连续性要求
8. transitionHint 不要只写 cut，要说明这是接话切、视线切、反应切、动作承接切还是情绪延续切
9. 只输出 JSON，结构如下：
{
  "groupId": ${JSON.stringify(group.groupId)},
  "summary": "这组连续对白镜头的整体拍法和情绪推进概括",
  "continuityNotes": "这组镜头在轴线、站位、视线、节奏、动作承接上的统一约束",
  "shots": [
    {
      "sceneNumber": ${group.scene.sceneNumber},
      "shotNumber": ${group.shots[0]?.shotNumber ?? 1},
      "dialogue": "分配给这个镜头的对白，没有则留空字符串",
      "voiceover": "分配给这个镜头的画外音，没有则留空字符串",
      "camera": "当前镜头的对白拍法建议",
      "composition": "当前镜头的构图重心建议",
      "transitionHint": "当前镜头如何自然切入或切出",
      "promptHint": "后续生成完整镜头 prompt 时必须吸收的连续性提示"
    }
  ]
}

目标场景上下文：
${buildStoryboardSceneContext(script, group.scene)}`;
}

function normalizeStoryboardDialogueSequenceBrief(
  payload: StoryboardDialogueSequencePayload,
  group: StoryboardDialogueSequenceGroup
): StoryboardDialogueSequenceBrief {
  const shotsByKey = new Map(
    (payload.shots ?? []).map((shot) => [
      `${normalizePositiveInteger(shot.sceneNumber, group.scene.sceneNumber)}:${normalizePositiveInteger(shot.shotNumber, 1)}`,
      shot
    ])
  );

  return {
    groupId: group.groupId,
    sceneNumber: group.scene.sceneNumber,
    summary: normalizeString(
      payload.summary,
      `围绕 ${group.groupId} 这组连续对白镜头，通过接话与反应切换保持节奏递进。`
    ),
    continuityNotes: normalizeString(
      payload.continuityNotes,
      '保持人物站位、视线方向、情绪升级和动作承接连续，切镜优先跟随接话点、反应点和情绪波峰。'
    ),
    shots: group.shots.map((planShot) => {
      const matched = shotsByKey.get(`${planShot.sceneNumber}:${planShot.shotNumber}`);

      return {
        id: planShot.id,
        sceneNumber: planShot.sceneNumber,
        shotNumber: planShot.shotNumber,
        dialogue: normalizeString(matched?.dialogue, ''),
        voiceover: normalizeString(matched?.voiceover, ''),
        camera: normalizeString(
          matched?.camera,
          `${planShot.title}的对白拍法要清楚承接上一镜的接话点与人物反应，保持轴线和景别变化自然。`
        ),
        composition: normalizeString(
          matched?.composition,
          `${planShot.title}需要明确当前说话者、听者反应和两人的空间关系，避免视线与站位突然跳变。`
        ),
        transitionHint: normalizeString(
          matched?.transitionHint,
          '通过接话、视线承接、动作延续或情绪反应自然切入下一镜，避免硬切。'
        ),
        promptHint: normalizeString(
          matched?.promptHint,
          `${planShot.title}需要保留对白接力点、停顿节奏、人物视线方向和空间朝向的连续性。`
        )
      };
    })
  };
}

async function generateStoryboardDialogueSequenceBrief(
  script: ScriptPackage,
  settings: ProjectSettings,
  group: StoryboardDialogueSequenceGroup,
  planShots: StoryboardPlanShot[],
  options?: StoryboardGenerationOptions
): Promise<StoryboardDialogueSequenceBrief> {
  const payload = await requestJson<StoryboardDialogueSequencePayload>(
    [
      {
        role: 'system',
        content:
          '你是一名擅长拍对白戏的影视导演与场面调度顾问。请把连续对白镜头拆成流畅的 shot-reverse-shot / 双人镜头 / 反应镜头节奏方案。只输出 JSON，不要输出额外说明。'
      },
      {
        role: 'user',
        content: buildStoryboardDialogueSequencePrompt(script, settings, group, planShots)
      }
    ],
    {
      temperature: 0.35,
      maxTokens: getStoryboardDialogueSequenceGenerationMaxTokens(group),
      signal: options?.signal
    }
  );

  return normalizeStoryboardDialogueSequenceBrief(payload, group);
}

function buildStoryboardDialogueSequenceShotContextMap(
  briefs: StoryboardDialogueSequenceBrief[]
): Map<string, StoryboardDialogueSequenceShotContext> {
  const contextMap = new Map<string, StoryboardDialogueSequenceShotContext>();

  for (const group of briefs) {
    for (const shot of group.shots) {
      contextMap.set(shot.id, {
        group,
        shot
      });
    }
  }

  return contextMap;
}

function mergeStoryboardDialogueSequenceFallbacks(
  shot: StoryboardShotPayload,
  dialogueSequenceContext: StoryboardDialogueSequenceShotContext | null | undefined
): StoryboardShotPayload {
  if (!dialogueSequenceContext) {
    return shot;
  }

  return {
    ...shot,
    dialogueIdentifier: shot.dialogueIdentifier ?? { groupId: dialogueSequenceContext.group.groupId },
    dialogue: normalizeString(shot.dialogue, dialogueSequenceContext.shot.dialogue),
    voiceover: normalizeString(shot.voiceover, dialogueSequenceContext.shot.voiceover),
    camera: normalizeString(shot.camera, dialogueSequenceContext.shot.camera),
    composition: normalizeString(shot.composition, dialogueSequenceContext.shot.composition),
    transitionHint: normalizeString(shot.transitionHint, dialogueSequenceContext.shot.transitionHint)
  };
}

function buildStoryboardShotTurnPrompt(
  script: ScriptPackage,
  settings: ProjectSettings,
  shotPlan: StoryboardPlanShot,
  planShots: StoryboardPlanShot[],
  shotIndex: number,
  storyboard: StoryboardShot[],
  dialogueSequenceContext: StoryboardDialogueSequenceShotContext | null,
  retryFeedback = ''
): string {
  const scene = script.scenes.find((item) => item.sceneNumber === shotPlan.sceneNumber);

  if (!scene) {
    throw new Error(`分镜生成失败：找不到 sceneNumber = ${shotPlan.sceneNumber} 的剧本场景。`);
  }

  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const spokenLanguageRequirement = buildStoryboardSpokenLanguageRequirement(settings.language);
  const spokenLanguageLabel = describeProjectLanguage(settings.language);
  const shotSplitGuideline = buildStoryboardShotSplitGuideline();
  const retryNotice = retryFeedback
    ? `\n上一次结果不合格，必须修正以下问题：\n${retryFeedback}\n本次输出必须一次性给出修正后的完整镜头 JSON。\n`
    : '';
  const continuityNotice =
    shotIndex > 0
      ? `前面已经完成了 ${shotIndex}/${planShots.length} 个镜头。你必须延续已建立的人物外观、服装、道具状态、空间关系和情绪推进。`
      : '这是第一个完整镜头，需要为整部短剧建立稳定的人物与视觉基调。';
  const dialogueIdentifierOutput = shotPlan.dialogueIdentifier?.groupId
    ? JSON.stringify({ groupId: shotPlan.dialogueIdentifier.groupId })
    : 'null';
  const longTakeIdentifierOutput = shotPlan.longTakeIdentifier ? JSON.stringify(shotPlan.longTakeIdentifier) : 'null';
  const dialogueSequenceNotice = dialogueSequenceContext
    ? `连续对白补充约束：
- 当前镜头属于对白组 ${dialogueSequenceContext.group.groupId}，组内位置 ${shotPlan.dialogueIdentifier?.sequenceIndex ?? 1}/${shotPlan.dialogueIdentifier?.sequenceLength ?? 1}
- 组整体拍法：${dialogueSequenceContext.group.summary}
- 组统一连续性要求：${dialogueSequenceContext.group.continuityNotes}
- 当前镜头建议承载的对白：${dialogueSequenceContext.shot.dialogue || '无'}
- 当前镜头建议承载的画外音：${dialogueSequenceContext.shot.voiceover || '无'}
- 当前镜头对白拍法建议：${dialogueSequenceContext.shot.camera}
- 当前镜头构图建议：${dialogueSequenceContext.shot.composition}
- 当前镜头切换建议：${dialogueSequenceContext.shot.transitionHint}
- 生成完整镜头时必须吸收的额外提示：${dialogueSequenceContext.shot.promptHint}`
    : '连续对白补充约束：当前镜头不属于需要额外优化的连续对白组。';
  const dialogueIdentifierRequirement = shotPlan.dialogueIdentifier?.groupId
    ? `当前镜头是对白标识镜头，dialogueIdentifier 必须输出为 ${dialogueIdentifierOutput}，不能改写 groupId，也不要输出其他额外字段。`
    : '当前镜头不是对白标识镜头，dialogueIdentifier 必须输出 null。';
  const longTakeIdentifierRequirement = shotPlan.longTakeIdentifier
    ? `当前镜头是长镜头组镜头，longTakeIdentifier 必须输出为 ${longTakeIdentifierOutput}，不能改写或省略。`
    : '当前镜头不属于长镜头组，longTakeIdentifier 必须输出 null。';

  return `现在生成第 ${shotIndex + 1}/${planShots.length} 个镜头的完整分镜 JSON。${retryNotice}

${continuityNotice}

当前镜头固定规划：
{
  "sceneNumber": ${shotPlan.sceneNumber},
  "shotNumber": ${shotPlan.shotNumber},
  "title": ${JSON.stringify(shotPlan.title)},
  "purpose": ${JSON.stringify(shotPlan.purpose)},
  "durationSeconds": ${shotPlan.durationSeconds},
  "dialogueIdentifier": ${dialogueIdentifierOutput},
  "longTakeIdentifier": ${longTakeIdentifierOutput},
  "overview": ${JSON.stringify(shotPlan.overview)}
}

当前场分镜规划：
${buildStoryboardScenePlanContext(planShots, shotPlan.sceneNumber)}

当前镜头前后规划：
${buildStoryboardAdjacentPlanContext(planShots, shotIndex)}

已完成镜头摘要：
${buildCompletedStoryboardContext(storyboard, shotPlan)}

${dialogueSequenceNotice}

要求：
1. 只能输出这一个镜头的完整 JSON，不能输出其他镜头
2. sceneNumber 必须是 ${shotPlan.sceneNumber}，shotNumber 必须是 ${shotPlan.shotNumber}，title 必须保持为 ${JSON.stringify(shotPlan.title)}，purpose 必须保持为 ${JSON.stringify(shotPlan.purpose)}，durationSeconds 必须保持为 ${shotPlan.durationSeconds}
3. 必须把当前规划里的 overview 展开成完整可执行分镜，但不能偏离该镜头承担的戏剧功能
4. ${dialogueIdentifierRequirement}
5. ${longTakeIdentifierRequirement}
6. 如果上方存在“连续对白补充约束”，你必须把其中的对白分配、轴线、视线、站位、接话点、反应点和切换节奏吸收到 dialogue、camera、composition、transitionHint、videoPrompt 和 speechPrompt 中，让镜头切换自然顺滑
7. 每个镜头必须包含起始参考帧描述 firstFramePrompt、布尔字段 useLastFrameReference，以及视频片段描述 videoPrompt；只有在镜头确实需要明确结束画面约束时，才把 useLastFrameReference 设为 true 并提供 lastFramePrompt，否则设为 false 且 lastFramePrompt 置空字符串
8. 每个镜头必须额外提供 backgroundSoundPrompt，用于描述环境音、动作音、氛围音，不要写人物对白；如果镜头没有台词或旁白，也必须明确写出自然的环境声、动作声和空间氛围声，不能写成静音
9. 每个镜头必须额外提供 speechPrompt，用于描述该镜头的台词/旁白配音方式、语气、节奏、情绪；如果镜头里有人说话，必须通过人物身份、年龄感、外观和气质特征明确当前说话者，不要只写角色名；如果没有台词或旁白，要明确写无语音内容。${spokenLanguageRequirement}
10. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
11. ${shotSplitGuideline} 当前镜头已经固定为 ${shotPlan.durationSeconds} 秒，你必须在这个时长内把起势、过程、停顿和收势写完整
12. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；当前镜头时长已固定为 ${shotPlan.durationSeconds} 秒，不得改写
13. 构图、镜头运动、光线、表情、动作的起势、过程、停顿和收势都要写清楚，避免动作刚开始就立刻结束，避免镜头内状态跳变过猛
14. firstFramePrompt 不能只写剧情摘要或抽象事件，必须写成可直接生图的起始参考帧画面说明：明确景别、机位、构图、主体位置、人物外观与姿态、视线方向、眼神焦点、眼神状态、表情、手部动作、关键道具、前中后景层次、环境细节、时间与光线，并冻结在镜头起始瞬间；它必须对应一张单张电影级静帧，不能写成海报、拼贴、多联画、设定板、字幕画面或概念草图
15. 只有在镜头需要明确落幅、动作落点、收束构图、镜头终点状态或不提供结束参考帧就容易跑偏时，才把 useLastFrameReference 设为 true；不要机械地给每个镜头都加尾帧约束
16. 当 useLastFrameReference 为 true 时，lastFramePrompt 必须写成可直接生图的结束参考帧画面说明，明确镜头结束时的景别、机位、构图、人物状态、视线方向、眼神焦点、眼神状态、道具状态和环境状态；当 useLastFrameReference 为 false 时，lastFramePrompt 必须输出空字符串
17. 如果当前镜头与前一个镜头使用同一个 longTakeIdentifier，你仍然要给出完整的 firstFramePrompt 作为连续性描述，但系统会直接复用前一个视频尾帧作为当前首帧，不会单独生图；因此这类 longTakeIdentifier 只能用于真正无缝承接的长镜头拆段
18. videoPrompt 必须先描述镜头本身，再描述人物、动作、表演、环境、光线和氛围。优先从景别、机位、运镜、镜头节奏写起，不要一上来先写剧情摘要或对白内容
19. 人物一致性是硬约束。只要剧本没有明确要求变化，角色的脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和整体气质都必须在当前镜头与已完成镜头之间保持稳定
20. videoPrompt 和 speechPrompt 如果需要描述台词内容，不要用中文或英文引号包裹台词文本，直接描述某人说某句话即可
21. 为避免输出过长被截断，在保证可生成性的前提下，每个字段写得具体但紧凑：title、purpose、camera、composition 各 1 句；firstFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt 各 1 到 2 句；只有在 useLastFrameReference 为 true 时才输出 1 到 2 句的 lastFramePrompt，但它必须优先保证画面信息完整，不要偷懒简写成剧情提示
22. sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
23. 你必须结合上文“可用参考资产列表”里的名称、摘要和细节判断这个镜头该用哪些资产，并把对应 id 写进 referenceAssetIds；不能只看 id 猜测含义
24. 如果同一角色存在多个年龄段资产，必须根据当前 scene 的时间线和剧情阶段选择正确年龄段，不能把少年版和成年版混用
25. 如果同一场景存在多个不同角度的场景资产，只要这些角度都能帮助锁定空间关系、机位方向或环境细节，可以同时选入 referenceAssetIds
26. 输出结构：
{
  "shot": {
    "id": "scene-${shotPlan.sceneNumber}-shot-${shotPlan.shotNumber}",
    "sceneNumber": ${shotPlan.sceneNumber},
    "shotNumber": ${shotPlan.shotNumber},
    "title": ${JSON.stringify(shotPlan.title)},
    "purpose": ${JSON.stringify(shotPlan.purpose)},
    "durationSeconds": ${shotPlan.durationSeconds},
    "dialogueIdentifier": ${dialogueIdentifierOutput},
    "longTakeIdentifier": ${longTakeIdentifierOutput},
    "dialogue": "本镜头核心台词，必须使用${spokenLanguageLabel}，没有可留空",
    "voiceover": "本镜头画外音，必须使用${spokenLanguageLabel}，没有可留空",
    "camera": "镜头语言",
    "composition": "构图说明",
    "transitionHint": "转场方式，优先自然承接、动作延续或情绪延续，避免突兀硬切",
    "useLastFrameReference": true,
    "firstFramePrompt": "用于起始参考帧静态图生成的详细提示词，必须是可直接生图的单张电影级静帧说明，不要只写剧情提示，也不要写成海报、拼贴、多联画、设定板或概念草图",
    "lastFramePrompt": "当 useLastFrameReference 为 true 时，用于结束参考帧静态图生成的详细提示词；当 useLastFrameReference 为 false 时，必须输出空字符串",
    "videoPrompt": "用于视频生成的详细提示词；先写景别、机位、运镜和镜头节奏，再写人物动作、表演、环境、光线和氛围，不要用引号包裹台词文本",
    "backgroundSoundPrompt": "用于背景声音生成的详细提示词；无对白时也要写自然环境声、动作声和空间氛围声，不含人物对白",
    "speechPrompt": "用于台词或旁白配音的详细提示词；有语音内容时通过人物特征明确说话者，并确保实际语音内容使用${spokenLanguageLabel}；没有语音内容时明确写无语音，不要用引号包裹台词文本",
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
        dialogueIdentifier: shot.dialogueIdentifier?.groupId
          ? {
              groupId: shot.dialogueIdentifier.groupId
            }
          : null,
        longTakeIdentifier: shot.longTakeIdentifier,
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
  dialogueSequenceContext: StoryboardDialogueSequenceShotContext | null,
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
      dialogueSequenceContext,
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

    const mergedRawShot = mergeStoryboardDialogueSequenceFallbacks(rawShot, dialogueSequenceContext);

    const normalizedShot = normalizeStoryboardShotForGeneration(
      {
        ...mergedRawShot,
        dialogueIdentifier: normalizeStoryboardDialogueIdentifier(mergedRawShot.dialogueIdentifier),
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
      "sceneHeading": "内景，老宅客厅，夜",
      "location": "地点",
      "timeOfDay": "时间",
      "summary": "本场核心推进",
      "emotionalBeat": "情绪推进",
      "conflict": "本场直接冲突",
      "turningPoint": "本场结尾转折或钩子",
      "durationSeconds": ${defaultSceneDurationExample(settings)},
      "scriptBlocks": [
        {
          "type": "action",
          "text": "看得见、拍得到的动作、表情、空间变化和道具状态"
        },
        {
          "type": "dialogue",
          "character": "角色名",
          "parenthetical": "表演说明，没有则留空",
          "text": "台词"
        },
        {
          "type": "voiceover",
          "character": "旁白或角色名，没有则写旁白",
          "text": "必要时才写画外音，没有则可以省略这个块"
        },
        {
          "type": "transition",
          "text": "必要时才写场尾转场提示，没有则可以省略这个块"
        }
      ]
    }
  ]
}`;
}

function buildScriptPromptContext(settings: ProjectSettings): string {
  const target = getStoryLengthScriptGenerationTarget(settings);

  return `创作参考：
1. 目标受众：${settings.audience}
2. 语气风格：${settings.tone}
3. 视觉调性：${settings.visualStyle}
4. 输出语言：${settings.language}
5. 项目篇幅为${STORY_LENGTH_LABELS[settings.storyLength]}；这是强约束，不是参考值。整体控制在 ${target.minimumScenes} 到 ${target.maximumScenes} 场、总时长约 ${target.minimumTotalDurationSeconds} 到 ${target.maximumTotalDurationSeconds} 秒。${target.pacingInstruction}
6. 每场必须写成真正可拍的剧本，而不是只有 summary、dialogue 列表的场景大纲；sceneHeading、conflict、turningPoint 和 scriptBlocks 都是硬约束
7. scriptBlocks 必须按实际发生顺序排列，至少包含 action；需要对白时再写 dialogue，需要画外音时再写 voiceover；只有必要时才写 transition
8. action 只能写看得见、拍得到的动作、表情、调度、空间变化和道具状态，不要写作者点评、主题说明或空泛总结
9. dialogue 要口语化、短促、带潜台词；parenthetical 只写必要表演提示，不要每句都加
10. 每场内部都要在 scriptBlocks 中体现起势、对抗、转折和收束，不能只写 2 到 3 条概括性交代
11. durationSeconds 必须给出正整数秒，并按剧情节奏自行决定；所有场次相加后的总时长必须落在上面的篇幅区间内
12. 人物外观和身份要稳定，便于后续持续生成画面
13. 如果输入素材很多，优先压缩、合并和聚焦主线，不要为了“写全”而突破当前篇幅上限
14. 只输出 JSON，不要输出解释、标题外文本或 Markdown 代码块`;
}

function buildScriptMessages(
  sourceText: string,
  settings: ProjectSettings,
  retryFeedback = ''
): ChatCompletionMessageParam[] {
  const outputSchema = buildScriptOutputSchema(settings);
  const sharedContext = buildScriptPromptContext(settings);
  const retryNotice = retryFeedback
    ? `\n\n上一次输出存在以下问题，这次必须全部修正后再返回完整 JSON：\n${retryFeedback}`
    : '';

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
${retryNotice}

优化目标：
1. 保留原文中可成立的核心设定、人物关系、主要事件和情绪走向，不要无故推翻故事根基
2. 优先修复开场不够抓人、冲突不够集中、情绪不够陡、场次重复、对白拖沓的问题
3. 第一场必须尽快给出强钩子、悬念、威胁或利益冲突
4. 每一场都要有明确目标、阻碍、转折或信息增量，避免空转
5. 每场都必须写成连续剧本块 scriptBlocks，至少要让读者看到人物动作、表情反应、对白来回和场尾转折，不能只给几句概要
6. 对白要口语化、短促、利于表演，不要写成长篇讲述
7. 画外音只在必要时使用，避免重复解释画面已经表达的信息
8. 如果原文结构混乱，可以重组场次顺序，但不要丢失关键剧情信息
9. 如果原文缺少必要细节，可以补足角色动机、场景信息和情绪推进，使其成为完整可拍的短剧
10. 必须严格遵守上面的篇幅范围，宁可压缩和合并，也不要生成超出当前篇幅约束的长剧本
11. 返回结构必须严格符合以下 JSON：
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
${retryNotice}

生成目标：
1. 将输入素材扩写为完整短剧，而不是复述原文
2. 第一场必须快速建立人物关系、危机、悬念或利益冲突，让用户愿意继续看
3. 全剧要有持续升级的冲突链路，避免平铺直叙
4. 每场都要服务于主线推进，并给出清晰的情绪变化
5. 角色数量控制在必要范围内，每个核心角色都要有鲜明身份、稳定外观和清晰动机
6. 每场都必须写成连续剧本块 scriptBlocks，让动作、对白、反应和转折按顺序发生，不能退化成“场景介绍 + 几句台词”
7. 场景信息要具体到地点、时间和动作状态，方便后续直接拆分镜
8. 对白要短、准、狠，符合短剧节奏，尽量避免大段说明性台词
9. 必须严格遵守上面的篇幅范围，宁可压缩和合并情节，也不要生成超出当前篇幅约束的长剧本
10. 返回结构必须严格符合以下 JSON：
${outputSchema}

输入素材：
${sourceText}`
    }
  ];
}

function validateGeneratedScriptAgainstLength(
  script: Pick<ScriptPackage, 'scenes'>,
  settings: ProjectSettings
): {
  ok: boolean;
  feedback: string;
} {
  const target = getStoryLengthScriptGenerationTarget(settings);
  const sceneCount = script.scenes.length;
  const totalDurationSeconds = script.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const issues: string[] = [];

  if (!sceneCount) {
    issues.push('必须至少生成 1 场戏。');
  }

  if (sceneCount < target.minimumScenes) {
    issues.push(`场景数过少：当前 ${sceneCount} 场，至少需要 ${target.minimumScenes} 场。`);
  }

  if (sceneCount > target.maximumScenes) {
    issues.push(`场景数过多：当前 ${sceneCount} 场，最多只能 ${target.maximumScenes} 场。`);
  }

  if (totalDurationSeconds < target.minimumTotalDurationSeconds) {
    issues.push(`总时长过短：当前约 ${totalDurationSeconds} 秒，至少需要 ${target.minimumTotalDurationSeconds} 秒。`);
  }

  if (totalDurationSeconds > target.maximumTotalDurationSeconds) {
    issues.push(`总时长过长：当前约 ${totalDurationSeconds} 秒，最多只能 ${target.maximumTotalDurationSeconds} 秒。`);
  }

  for (const scene of script.scenes) {
    const minimumBlockCount = Math.max(4, Math.ceil(scene.durationSeconds / 8));
    const actionBlockCount = scene.scriptBlocks.filter((block) => block.type === 'action').length;
    const spokenBlockCount = scene.scriptBlocks.filter(
      (block) => block.type === 'dialogue' || block.type === 'voiceover'
    ).length;

    if (!scene.sceneHeading.trim()) {
      issues.push(`场景 ${scene.sceneNumber} 缺少 sceneHeading。`);
    }

    if (!scene.conflict.trim()) {
      issues.push(`场景 ${scene.sceneNumber} 缺少 conflict。`);
    }

    if (!scene.turningPoint.trim()) {
      issues.push(`场景 ${scene.sceneNumber} 缺少 turningPoint。`);
    }

    if (scene.scriptBlocks.length < minimumBlockCount) {
      issues.push(
        `场景 ${scene.sceneNumber} 的 scriptBlocks 过少：当前 ${scene.scriptBlocks.length} 条，至少需要 ${minimumBlockCount} 条，不能只写场景概述。`
      );
    }

    if (!actionBlockCount) {
      issues.push(`场景 ${scene.sceneNumber} 缺少 action 块，无法形成真正可拍的剧本调度。`);
    }

    if (!spokenBlockCount && actionBlockCount < 2) {
      issues.push(`场景 ${scene.sceneNumber} 缺少足够的动作或语音剧本块，内容仍然偏大纲。`);
    }
  }

  return {
    ok: issues.length === 0,
    feedback: issues.join('；')
  };
}

export async function generateScriptFromText(
  sourceText: string,
  settings: ProjectSettings,
  options?: {
    signal?: AbortSignal;
  }
): Promise<ScriptPackage> {
  let retryFeedback = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
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
        sceneHeading?: string;
        location?: string;
        timeOfDay?: string;
        summary?: string;
        emotionalBeat?: string;
        conflict?: string;
        turningPoint?: string;
        voiceover?: string;
        durationSeconds?: number;
        dialogue?: Array<{
          character?: string;
          line?: string;
          performanceNote?: string;
        }>;
        scriptBlocks?: Array<{
          type?: string;
          text?: string;
          line?: string;
          character?: string;
          parenthetical?: string;
          performanceNote?: string;
        }>;
      }>;
    }>(buildScriptMessages(sourceText, settings, retryFeedback), {
      temperature:
        attempt === 0
          ? settings.scriptMode === 'generate'
            ? 0.8
            : 0.7
          : settings.scriptMode === 'generate'
            ? 0.6
            : 0.55,
      signal: options?.signal
    });

    const scenes: ScriptScene[] = (payload.scenes ?? []).map((scene, index) => {
      const location = normalizeString(scene.location, `场景 ${index + 1}`);
      const timeOfDay = normalizeString(scene.timeOfDay, '未说明');
      const normalizedDialogue = (scene.dialogue ?? [])
        .map((line) => ({
          character: normalizeString(line.character, '角色'),
          line: normalizeString(line.line, ''),
          performanceNote: normalizeString(line.performanceNote, '')
        }))
        .filter((line) => Boolean(line.line));
      const scriptBlocks = normalizeScriptSceneBlocks(scene.scriptBlocks);
      const derivedDialogue = normalizedDialogue.length ? normalizedDialogue : deriveSceneDialogueFromBlocks(scriptBlocks);
      const normalizedVoiceover = normalizeOptionalString(scene.voiceover) || deriveSceneVoiceoverFromBlocks(scriptBlocks);

      return {
        sceneNumber: index + 1,
        sceneHeading: normalizeString(scene.sceneHeading, buildFallbackSceneHeading(location, timeOfDay)),
        location,
        timeOfDay,
        summary: normalizeString(scene.summary, '暂无剧情描述'),
        emotionalBeat: normalizeString(scene.emotionalBeat, '情绪持续推进'),
        conflict: normalizeString(scene.conflict, '冲突待补充'),
        turningPoint: normalizeString(scene.turningPoint, '转折待补充'),
        voiceover: normalizedVoiceover,
        durationSeconds: normalizeDuration(scene.durationSeconds, defaultSceneDurationExample(settings)),
        dialogue: derivedDialogue,
        scriptBlocks
      };
    });

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
    const validation = validateGeneratedScriptAgainstLength(scriptCore, settings);

    if (validation.ok) {
      return {
        ...scriptCore,
        markdown: formatScriptMarkdown(scriptCore)
      };
    }

    retryFeedback = validation.feedback;
  }

  throw new Error(`剧本生成失败：连续多次输出仍不符合${STORY_LENGTH_LABELS[settings.storyLength]}篇幅约束。${retryFeedback}`);
}

export async function generateStoryboardFromScript(
  script: ScriptPackage,
  settings: ProjectSettings,
  options?: StoryboardGenerationOptions
): Promise<StoryboardShot[]> {
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

  const dialogueSequenceGroups = collectStoryboardDialogueSequenceGroups(script, planResult.planShots);
  const dialogueSequenceBriefs: StoryboardDialogueSequenceBrief[] = [];

  for (const group of dialogueSequenceGroups) {
    dialogueSequenceBriefs.push(
      await generateStoryboardDialogueSequenceBrief(script, settings, group, planResult.planShots, options)
    );
  }

  const dialogueSequenceContextMap = buildStoryboardDialogueSequenceShotContextMap(dialogueSequenceBriefs);

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
      dialogueSequenceContextMap.get(shotPlan.id) ?? null,
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
