import OpenAI from 'openai';
import type {
  LlmModelDiscoveryRequest,
  ProjectReferenceLibrary,
  ProjectSettings,
  ReferenceAssetItem,
  ReferenceAssetKind,
  ScriptDialogueLine,
  ScriptPackage,
  ScriptReferenceAssetLibrary,
  ScriptScene,
  ScriptSceneBlock,
  StoryboardDialogueIdentifier,
  StoryboardShot
} from '../shared/types.js';
import {
  DEFAULT_SETTINGS,
  STORY_LENGTH_LABELS,
  filterReferenceLibraryForShot,
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

const VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT = [
  '# Role',
  '你是一名好莱坞级别的图生视频（Image-to-Video）导演兼 LTX-2 提示词架构师。你的核心任务是：接收用户提供的一张【画面描述/参考图信息】以及【动作与台词描述】，将其转化为一段极具视觉冲击力、一镜到底、且物理逻辑严密的长段落英文提示词。你深刻理解 LTX-2 模型的 I2V 机制，懂得如何“唤醒”静态图片，并通过视觉线索代替抽象情感。',
  '',
  '# Core Writing Logic (LTX-2 I2V Dynamic Engine 3.0)',
  '1. Initial Frame Anchoring (首帧锚定): 提示词开头必须精准描述原图的构图、光影和人物状态，以此作为起幅。使用 Starting from a [shot type] of... 或 The scene opens on... 锁定画面，防止模型脱离原图。',
  '2. Single Unbroken Take (一镜到底法则): 必须使用 A single continuous tracking shot、Unbroken take、The camera steadily pans/pushes 等词汇，严禁暗示切镜头，确保原图元素在运动中平滑演进。',
  '3. Chronological Chaining (时间动作链条): 动作必须按时间顺序展开，用 As..., Suddenly..., Then..., Gradually... 等连接词牵引模型一秒一秒渲染，防止动作糊在一起。',
  '4. Visual Subtext & Micro-Physics (视觉潜台词与微观物理): 禁止直接写抽象情感，必须通过微观动作、表情、物理干涉、环境反馈来外化表现。',
  '5. Audio-Visual Sync (音画同步): 对话严格采用 [Character Name] ([Vocal/Physical cue]): "中文台词" 格式。',
  '6. Motivated Gaze Direction (动机化视线): 人物视线必须服务于当前互动对象、动作目标、道具位置、画外空间或运动方向；除非用户明确要求 POV / first-person shot / direct-to-camera monologue / confrontational stare into lens，否则不要默认写成 looking into camera / facing camera / staring at viewer，也不要让所有人物同时正对屏幕。若输入没有明确注视对象，你必须主动设计 off-axis gaze，例如 looking toward the opponent off-camera left/right、down at the object in hand、toward the doorway/deep corridor、or toward the direction of travel，并避免 direct eye contact with the lens。',
  '7. Single Character Instance Rule (角色单实例法则): 除非用户明确要求镜像、监控画面、照片、投影或分身叙事，同一个已命名角色在同一帧/同一镜头里只能出现一次。不要生成 same character twice、character clone、duplicate body、same-face background extra、twin duplicate 或独立存在的第二个同角色实体。',
  '8. Style & Character Lock (风格与角色锁定): 如果用户输入包含 [结构化摄影风格] 和 [角色硬约束]，必须把它们当作不可改写的视觉锁定条件，只允许翻译、融合和具体化，不允许替换角色脸型五官、发型发色、体型、服装主色、关键配饰、年龄感、气质、说话者身份或项目级镜头光学/布光/色彩/质感方向。',
  '',
  '# Input/Output Constraints',
  '- English Only: 所有视觉、动作、环境描述必须使用高水准的好莱坞剧本级英语。',
  '- Keep Chinese: 只有对白必须保留原始中文，严禁翻译成英文。',
  '- Sentence Count: 保持在 8-16 句之间，按“起幅锚定 -> 动作推进 -> 微表演/物理反馈 -> 台词/声音 -> 收束落幅”充分展开；可以写成长段落，但不要压缩成过短摘要。',
  '- Output Format: 直接输出一段连贯的英文段落（插入中文台词），不要标题，不要解释。',
  '',
  '# The Formula',
  '输出必须遵循以下叙事结构并融合成一个自然段落：',
  '1. [Initial Frame Anchor]: Starting from a [Shot Type] of [准确描述图片中的人物/场景/光影状态].',
  '2. [Activation & Camera]: The scene comes to life as a single continuous tracking shot [pushes in / slowly pans]...',
  '3. [Chronological Action 1]: As [Character] does [Action], 描述物理细节与微表情。',
  '4. [Dialogue Block]: Character (cue): "中文台词"',
  '5. [Chronological Action 2]: 角色说话后或说话同时的连带动作。',
  '6. [Resolution Frame]: 镜头如何收尾。',
  '7. [Cinematic Suffix]: 导演风格、镜头参数、材质与光影术语，例如 35mm anamorphic lens, hyper-realistic textures, volumetric light。',
  '',
  '# Execution',
  '当用户提供 [Image State + Action/Dialogue] 后，直接输出优化后的 Cinematic Description，不要确认规则，不要复述输入，不要添加任何额外文字。'
].join('\n');

const STORYBOARD_DIALOGUE_MARKER_DURATION_BONUS_SECONDS = 2;

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

function applyStoryboardDialogueMarkerDurationBonus(
  durationSeconds: number,
  dialogueIdentifier: StoryboardDialogueIdentifier | null,
  settings: ProjectSettings
): number {
  if (!dialogueIdentifier?.groupId) {
    return durationSeconds;
  }

  return Math.min(
    durationSeconds + STORYBOARD_DIALOGUE_MARKER_DURATION_BONUS_SECONDS,
    getEffectiveMaxVideoSegmentDurationSeconds(settings)
  );
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

function normalizeScriptReferenceAssets(
  value: unknown,
  settings: ProjectSettings
): ScriptReferenceAssetLibrary {
  const input =
    value && typeof value === 'object'
      ? (value as {
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
        })
      : {};

  return {
    characters: (input.characters ?? []).map((item, index) => ({
      name: normalizeString(item.name, `角色${index + 1}`),
      summary: normalizeString(item.summary, '核心角色设定'),
      genderHint: normalizeOptionalString(item.genderHint),
      ageHint: normalizeOptionalString(item.ageHint),
      ethnicityHint: normalizeOptionalString(item.ethnicityHint),
      generationPrompt: normalizeString(
        item.generationPrompt,
        normalizeString(item.summary, `${settings.visualStyle}，人物外观与服装特征稳定设定`)
      )
    })),
    scenes: (input.scenes ?? []).map((item, index) => ({
      name: normalizeString(item.name, `场景${index + 1}`),
      summary: normalizeString(item.summary, '核心场景设定'),
      generationPrompt: normalizeSceneReferencePrompt(
        item.generationPrompt,
        settings,
        normalizeString(item.name, `场景${index + 1}`)
      )
    })),
    objects: (input.objects ?? []).map((item, index) => ({
      name: normalizeString(item.name, `物品${index + 1}`),
      summary: normalizeString(item.summary, '关键剧情道具'),
      generationPrompt: normalizeString(item.generationPrompt, `${settings.visualStyle}，关键道具特写`)
    }))
  };
}

function buildReferenceLibraryFromScriptReferenceAssets(
  referenceAssets: ScriptReferenceAssetLibrary | undefined,
  settings: ProjectSettings
): ProjectReferenceLibrary | null {
  const normalized = normalizeScriptReferenceAssets(referenceAssets, settings);
  const hasItems =
    normalized.characters.length > 0 || normalized.scenes.length > 0 || normalized.objects.length > 0;

  if (!hasItems) {
    return null;
  }

  return {
    characters: normalized.characters.map((item, index) =>
      createReferenceItem(
        'character',
        item.name,
        item.summary,
        item.generationPrompt,
        index,
        item.ethnicityHint,
        item.genderHint,
        item.ageHint
      )
    ),
    scenes: normalized.scenes.map((item, index) =>
      createReferenceItem('scene', item.name, item.summary, item.generationPrompt, index)
    ),
    objects: normalized.objects.map((item, index) =>
      createReferenceItem('object', item.name, item.summary, item.generationPrompt, index)
    )
  };
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

function isMaxTokensUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /max_tokens|max completion tokens|max_completion_tokens/i.test(message) &&
    /unsupported|not support|invalid|unknown|unrecognized/i.test(message)
  );
}

function isMaxTokensTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /max_tokens|max completion tokens|max_completion_tokens|max_tokens_limit|maximum context length|context_length_exceeded/i.test(
      message
    ) && /exceed|too large|maximum|context_length|less than or equal|at most|up to/i.test(message)
  );
}

function normalizeMaxTokensBudget(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function downshiftMaxTokensBudget(maxTokens: number): number {
  return Math.max(1_024, Math.floor(maxTokens * 0.75));
}

async function requestJson<T>(
  messages: ChatCompletionMessageParam[],
  options?: StructuredJsonRequestOptions
): Promise<T> {
  const client = createClient();
  const settings = getAppSettings();
  let useJsonResponseFormat = true;
  let maxTokens = normalizeMaxTokensBudget(options?.maxTokens);
  let useMaxTokens = maxTokens > 0;
  let response: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;

  while (!response) {
    const request = {
      model: settings.llm.model,
      temperature: options?.temperature ?? 0.6,
      messages,
      ...(useMaxTokens ? { max_tokens: maxTokens } : {}),
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

      if (useMaxTokens && isMaxTokensUnsupportedError(error)) {
        useMaxTokens = false;
        continue;
      }

      if (useMaxTokens && isMaxTokensTooLargeError(error)) {
        const nextMaxTokens = downshiftMaxTokensBudget(maxTokens);

        if (nextMaxTokens >= maxTokens || maxTokens <= 1_024) {
          useMaxTokens = false;
        } else {
          maxTokens = nextMaxTokens;
        }

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

async function requestText(
  messages: ChatCompletionMessageParam[],
  options?: StructuredJsonRequestOptions
): Promise<string> {
  const client = createClient();
  const settings = getAppSettings();
  let maxTokens = normalizeMaxTokensBudget(options?.maxTokens);
  let useMaxTokens = maxTokens > 0;
  let response: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;

  while (!response) {
    try {
      response = await client.chat.completions.create(
        {
          model: settings.llm.model,
          temperature: options?.temperature ?? 0.7,
          messages,
          ...(useMaxTokens ? { max_tokens: maxTokens } : {})
        },
        options?.signal
          ? {
              signal: options.signal
            }
          : undefined
      );
    } catch (error) {
      if (useMaxTokens && isMaxTokensUnsupportedError(error)) {
        useMaxTokens = false;
        continue;
      }

      if (useMaxTokens && isMaxTokensTooLargeError(error)) {
        const nextMaxTokens = downshiftMaxTokensBudget(maxTokens);

        if (nextMaxTokens >= maxTokens || maxTokens <= 1_024) {
          useMaxTokens = false;
        } else {
          maxTokens = nextMaxTokens;
        }

        continue;
      }

      throw error;
    }
  }

  const content = extractTextContent(response.choices[0]?.message?.content);

  if (!content.trim()) {
    throw new Error('文本模型没有返回内容。');
  }

  return content.trim();
}

function buildImageToVideoPromptOptimizationInput(
  shot: Pick<
    StoryboardShot,
    'camera' | 'composition' | 'firstFramePrompt' | 'videoPrompt' | 'dialogue' | 'voiceover'
  >,
  options: {
    includeSpeechPrompt: boolean;
    cinematicProfile?: ProjectSettings['cinematicProfile'];
    characterConstraintPrompt?: string;
    lastFramePrompt?: string;
  }
): string {
  const cinematicProfileLines = [
    options.cinematicProfile?.lensAndDepth.trim()
      ? `镜头与景深：${options.cinematicProfile.lensAndDepth.trim()}`
      : '',
    options.cinematicProfile?.lightingAndContrast.trim()
      ? `布光与反差：${options.cinematicProfile.lightingAndContrast.trim()}`
      : '',
    options.cinematicProfile?.colorPalette.trim()
      ? `色彩与调色：${options.cinematicProfile.colorPalette.trim()}`
      : '',
    options.cinematicProfile?.textureAndAtmosphere.trim()
      ? `质感与氛围：${options.cinematicProfile.textureAndAtmosphere.trim()}`
      : ''
  ].filter(Boolean);
  const motionAndSpeechDetails = [
    shot.videoPrompt.trim() ? `镜头动作：${shot.videoPrompt.trim()}` : '',
    options.includeSpeechPrompt && shot.dialogue.trim() ? `对白：${shot.dialogue.trim()}` : '',
    options.includeSpeechPrompt && shot.voiceover.trim() ? `旁白：${shot.voiceover.trim()}` : '',
    !options.includeSpeechPrompt && shot.dialogue.trim()
      ? '说话表现：镜头内不生成独立对白音频，但人物说话时需要通过口型、呼吸、停顿和身体动作体现说话节奏，不要把具体台词文字写进输出。'
      : '',
    !options.includeSpeechPrompt && shot.voiceover.trim()
      ? '旁白承接：镜头内不生成独立旁白音频，画面只承接旁白带来的情绪和节奏，不要把具体旁白文字写进输出。'
      : '',
    options.lastFramePrompt?.trim() ? `结尾画面：${options.lastFramePrompt.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  return [
    `[图片状态]：${shot.firstFramePrompt.trim()}`,
    `[镜头语言]：${[shot.camera.trim(), shot.composition.trim()].filter(Boolean).join('；') || '沿用当前镜头语言'}`,
    cinematicProfileLines.length ? `[结构化摄影风格]：\n${cinematicProfileLines.join('\n')}` : '',
    options.characterConstraintPrompt?.trim()
      ? `[角色硬约束]：\n${options.characterConstraintPrompt.trim()}`
      : '',
    '[动作与台词]：',
    motionAndSpeechDetails || '保持当前镜头内部的连续动作演进。',
    '视线硬约束：如果上方没有明确写“主观镜头 / POV / 对镜独白 / 直视镜头”，则必须把人物眼神改写为看向画外左/右侧对象、手中道具、行进方向或远处环境锚点，并在英文里明确写出 off-camera / toward the object / toward the doorway / in the direction of travel 等离轴注视目标；不要写 looking into camera、staring at viewer、facing camera，也不要只写 looks ahead。',
    '人物单实例硬约束：如果上方没有明确要求镜子、监控屏、照片、投影或分身叙事，则同一个已命名角色在同一帧/同一镜头里只能出现一次；不要写 same character twice、character clone、duplicate body、same-face extra、twin duplicate，也不要把同一角色复制到背景中。',
    '如果上方没有明确提供对白或旁白文本，不要臆造新的中文台词或旁白。',
    '请直接输出最终英文段落，不要标题，不要解释，不要确认规则。'
  ].join('\n');
}

function normalizeOptimizedVideoPrompt(value: string): string {
  const fenced = value.match(/```(?:text)?\s*([\s\S]*?)```/i);
  const content = (fenced?.[1] ?? value)
    .replace(/\r/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return content.replace(/^[“"'`]+|[”"'`]+$/g, '').trim();
}

export async function optimizeImageToVideoPrompt(
  shot: Pick<
    StoryboardShot,
    'camera' | 'composition' | 'firstFramePrompt' | 'videoPrompt' | 'dialogue' | 'voiceover'
  >,
  options: {
    includeSpeechPrompt: boolean;
    cinematicProfile?: ProjectSettings['cinematicProfile'];
    characterConstraintPrompt?: string;
    lastFramePrompt?: string;
    signal?: AbortSignal;
  }
): Promise<string> {
  const optimized = await requestText(
    [
      {
        role: 'system',
        content: VIDEO_PROMPT_OPTIMIZER_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: buildImageToVideoPromptOptimizationInput(shot, {
          includeSpeechPrompt: options.includeSpeechPrompt,
          cinematicProfile: options.cinematicProfile,
          characterConstraintPrompt: options.characterConstraintPrompt,
          lastFramePrompt: options.lastFramePrompt
        })
      }
    ],
    {
      temperature: 0.7,
      maxTokens: 1_200,
      signal: options.signal
    }
  );

  return normalizeOptimizedVideoPrompt(optimized);
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
  const embeddedReferenceLibrary = buildReferenceLibraryFromScriptReferenceAssets(script.referenceAssets, settings);

  if (embeddedReferenceLibrary) {
    return embeddedReferenceLibrary;
  }

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
        '你是一名影视美术设定导演和资产统筹。请基于剧本尽可能完整、分层、去重地提取可单独生成参考资产的角色、场景和物品，让后续美术资产库更丰富且可复用。只输出 JSON，不要输出额外解释。'
    },
    {
      role: 'user',
      content: `请根据下面剧本提取三类可生成资产：

1. characters：主角、重要配角、反复出现的群演/职业身份型背景人物、以及同一人物的关键造型/年龄/伤妆状态变体，用于角色定妆和统一形象
2. scenes：可复用的场景母版、同一地点的不同机位/分区/时间氛围变体，用于场景设定图和后续镜头参考
3. objects：推动剧情的重要物件、反复出现的陈设/交通工具/武器/电子设备/文书/标识/服饰配件等高辨识度道具，用于道具参考图

要求：
1. 资产提取要尽量覆盖“后续画面里确实可能反复用到、且视觉上有明确差异”的内容，不要只保留最核心的少数资产；但也不要把一句台词里临时闪过、难以复用、视觉信息不足的微小元素过度拆分
2. characters.generationPrompt 由你在这个阶段直接生成人物外貌特点，供“无参考图角色三视图生成”与后续首帧/视频生成功能共用；只写稳定的人物外观与身份特征，重点描述年龄感、脸型五官、发型、体型、服装层次、面料材质、标志性配饰、轮廓差异、气质、常态表情，不要写三视图、镜头运动或具体剧情动作
3. 如果同一个人在剧本中以明显不同年龄段、职业/身份伪装、制服/礼服/便装切换、伤妆/湿身/战损等显著造型状态出场，characters 必须拆成多个独立资产，不能合并成一个；每个资产只对应一个清晰年龄段或造型状态，并且 name 必须直接带上变体标记，例如“林晚（少年）”“林晚（成年）”“林晚（晚宴礼服）”“林晚（雨夜战损）”
4. characters.summary、characters.genderHint、characters.ageHint、characters.ethnicityHint、characters.generationPrompt 都必须严格对应各自年龄段或造型状态，不要把多个年龄感/造型混在一个人物资产里
5. characters.genderHint 需要给出一个简短稳定的性别提示，例如“女性”“男性”“少女”“男孩”，不要写成长句
6. characters.ageHint 需要给出一个简短稳定的年龄阶段提示，例如“8岁儿童”“16岁少女”“30岁成年女性”“50岁中年男性”，必须和该人物资产对应的年龄段完全一致；如果是同年龄不同造型变体，也保持同一个年龄阶段提示
7. characters.ethnicityHint 需要额外给出一个简短的人种/族裔提示，用于稳定角色的人群观感、面部特征和肤色倾向；优先依据剧本明确线索，若剧本没有明确写出，可根据角色姓名、时代、地域和语境给出最稳妥的默认提示，使用简短短语即可
8. scenes.generationPrompt 和 objects.generationPrompt 必须适合直接用于 AI 生图，描述清晰、具体、统一，并体现视觉风格：${settings.visualStyle}
9. scenes 这里提取的是“可复用场景母版集合”，也就是同一空间在不同主机位、不同功能分区、不同时间/天气/光线氛围下可复用的空镜环境；不要只给每个地点一个单一角度，如果某个场景明显有多个可拍区域或多次回访状态，应拆成多个独立 scene 资产，name 直接带上视角/分区/时间标记，例如“老宅客厅-正厅广角-夜雨”“老宅走廊-侧向纵深-夜雨”“码头仓库-卷帘门入口-黎明”
10. 场景 prompt 必须和剧情解耦，只生成“空间设定图 / 空镜环境”，不要包含人物、角色名字、剧情动作、冲突、事件瞬间、对白、具体剧情信息
11. 场景 prompt 要强调空间结构、前中后景层次、入口/动线/遮挡关系、时间、光线、氛围、材质、陈设密度和可复用性，把剧情场面抽象成稳定的环境母版；每个 scene 资产只对应一个清晰机位或空间分区，但同一地点可以输出多个互补母版
12. scenes 的 summary 也必须描述空间用途、空间分区和氛围，不要写剧情作用、事件经过或角色行为
13. scenes 数量不要太少。默认至少不应少于剧本场次数；如果某场明显需要多个主机位/空间分区/时间光线状态，应该在这个基础上继续增加 1 到 3 个 scene 变体，不要因为怕多而合并
14. 对较长或较复杂的场景，优先补足建立空间的广角母版、人物活动主轴母版、入口/走廊/窗边等纵深或侧向分区母版，以及不同时间/天气/灯光状态母版；宁可多准备互补 scene 资产，也不要只给一个“万能场景”
15. objects 不能只保留“推动剧情的大道具”，也要尽量提取反复出现、画面辨识度高、会影响布景质感或角色动作的小道具/陈设/载具/屏幕设备/文件纸张/标志物/随身配饰；如果同一物品有明显状态变化，例如完好/破损、干燥/沾血、关闭/亮屏、收纳/展开，也要拆成独立资产并在 name 标注状态
16. 物品 prompt 要强调完整外形轮廓、核心材质、磨损/污渍/反光状态、摆放方式、可读的主视角或 3/4 角度、尺寸感和特写可辨识度；不要把道具写成被角色手持中的剧情动作瞬间
17. 只输出 JSON，结构如下：
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
  const referenceAssets = script.referenceAssets
    ? ([
        ['角色资产', script.referenceAssets.characters.map((item) => `- ${item.name}｜${item.summary}`)],
        ['场景资产', script.referenceAssets.scenes.map((item) => `- ${item.name}｜${item.summary}`)],
        ['物品资产', script.referenceAssets.objects.map((item) => `- ${item.name}｜${item.summary}`)]
      ] as const)
        .filter(([, items]) => items.length)
        .map(([label, items]) => `### ${label}\n${items.join('\n')}`)
        .join('\n\n')
    : '';

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
  const validationWarnings = script.validationWarnings?.trim()
    ? `## 结构提醒\n${script.validationWarnings.trim()}\n\n`
    : '';

  return `# ${script.title}

一句话卖点：${script.tagline}

剧情梗概：${script.synopsis}

风格说明：${script.styleNotes}

${validationWarnings}
## 角色设定
${characters}

${referenceAssets ? `## 资产列表\n${referenceAssets}\n\n` : ''}## 分场剧本
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
  const splitReferenceSeconds = Math.max(
    1,
    Math.min(
      getStoryboardShotSplitReferenceSeconds(settings),
      getEffectiveMaxVideoSegmentDurationSeconds(settings)
    )
  );

  return Math.max(
    structureRequirement.minimumShotsPerScene,
    Math.ceil(scene.durationSeconds / splitReferenceSeconds)
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

function buildStoryboardShotDurationGuideline(settings: ProjectSettings): string {
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const preferredLongShotDurationSeconds = Math.max(
    2,
    Math.min(getPreferredLongShotDurationSeconds(settings), maxVideoSegmentDurationSeconds)
  );

  return `每个镜头的 durationSeconds 必须由你在分镜时独立决定。项目篇幅只决定整片总量，不决定单个镜头该拍几秒。请根据当前镜头承载的信息量、动作完整度、表演停顿、对白长度、运镜路径和情绪发酵空间自行给出时长；反应、插入、视线、道具和动作细节镜头可以明显短一些，大多数镜头优先控制在 ${preferredLongShotDurationSeconds} 秒以内，只有明确需要完整长动作或连续情绪沉浸时才写得更长，但任何一个镜头都不能超过 ${maxVideoSegmentDurationSeconds} 秒。`;
}

function buildStoryboardShotSplitGuideline(settings: ProjectSettings): string {
  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const preferredLongShotDurationSeconds = Math.max(
    2,
    Math.min(getPreferredLongShotDurationSeconds(settings), maxVideoSegmentDurationSeconds)
  );

  return `是否继续拆镜首先看当前内容是否已经出现新的戏剧节拍、对白接话点、反应点、动作阶段变化、视线目标变化、人物进出场、空间揭示或信息反转；只要这些变化成立，就优先主动拆成多个镜头，用反打、插入、推拉、跟移、过肩、主观视角、细节特写和环境承接镜头把节奏拆细。只有当一个镜头确实只承担单一动作/单一反应/单一情绪停顿，并且明确需要保持一镜到底时，才把它保留在一个镜头内；如果预计单镜头会超过 ${preferredLongShotDurationSeconds} 秒且内部已有多个节拍，优先拆成 2 到 4 个镜头；如果一条连续长镜头总时长超过 ${maxVideoSegmentDurationSeconds} 秒，必须拆成多个带同一 longTakeIdentifier 的连续分段。`;
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
      minimumScenes: 12,
      maximumScenes: 18,
      minimumTotalDurationSeconds: 900,
      maximumTotalDurationSeconds: 1800,
      pacingInstruction: '允许做更完整的铺垫、关系递进、代价升级、支线回收和主题回响；中段可以加入数个直接服务主线的阻碍/误判/反转场，但每场都要有新的信息增量和明确场尾钩子，避免只拉长情绪不推进事件。'
    };
  }

  if (settings.storyLength === 'medium') {
    return {
      minimumScenes: 8,
      maximumScenes: 12,
      minimumTotalDurationSeconds: 360,
      maximumTotalDurationSeconds: 720,
      pacingInstruction: '需要有完整起承转合和至少一轮中段误判/反打/代价升级；允许增加直接服务主线的过渡场、调查场、追逼场或关系转折场来拉开篇幅，但每场都必须推动局势或人物关系变化。'
    };
  }

  return {
    minimumScenes: 4,
    maximumScenes: 6,
    minimumTotalDurationSeconds: 90,
    maximumTotalDurationSeconds: 180,
    pacingInstruction: '仍然聚焦单一主线，但允许用更完整的铺垫、对抗升级和场尾反转把短篇写扎实；不要把多个关键事件压缩成一句 summary。'
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
      minimumShotsPerScene: 12
    };
  }

  if (settings.storyLength === 'medium') {
    return {
      minimumScenes: 5,
      minimumShotsPerScene: 8
    };
  }

  return {
    minimumScenes: 3,
    minimumShotsPerScene: 4
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
  return Math.min(24_000, Math.max(6_000, minimumShots * 260));
}

function getStoryboardShotGenerationMaxTokens(): number {
  return 8_000;
}

function getScriptGenerationMaxTokens(settings: ProjectSettings): number {
  if (settings.scriptMode === 'upload') {
    return 12_000;
  }

  if (settings.storyLength === 'test') {
    return 6_000;
  }

  if (settings.storyLength === 'long') {
    return 24_000;
  }

  if (settings.storyLength === 'medium') {
    return 18_000;
  }

  return 12_000;
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
    items.map((item) => ({
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

function buildStoryboardFallbackReferenceAssetIds(
  shot: StoryboardShot,
  script: ScriptPackage,
  referenceLibrary?: ProjectReferenceLibrary
): string[] {
  if (!referenceLibrary) {
    return [];
  }

  const matchedReferenceLibrary = filterReferenceLibraryForShot(referenceLibrary, shot, script);

  return [
    ...matchedReferenceLibrary.characters.map((item) => buildStoryboardReferenceSelectionId('character', item.id)),
    ...matchedReferenceLibrary.scenes.map((item) => buildStoryboardReferenceSelectionId('scene', item.id)),
    ...matchedReferenceLibrary.objects.map((item) => buildStoryboardReferenceSelectionId('object', item.id))
  ];
}

function applyStoryboardReferenceAssetFallback(
  shot: StoryboardShot,
  script: ScriptPackage,
  referenceLibrary?: ProjectReferenceLibrary
): StoryboardShot {
  if (shot.referenceAssetIds.length) {
    return shot;
  }

  const fallbackReferenceAssetIds = buildStoryboardFallbackReferenceAssetIds(shot, script, referenceLibrary);
  if (!fallbackReferenceAssetIds.length) {
    return shot;
  }

  return {
    ...shot,
    referenceAssetIds: [...new Set(fallbackReferenceAssetIds)]
  };
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

interface StoryboardReferenceAssetReviewShotAssignmentPayload {
  sceneNumber?: number;
  shotNumber?: number;
  referenceAssetIds?: string[];
}

interface StoryboardReferenceAssetReviewCharacterPayload {
  tempId?: string;
  name?: string;
  summary?: string;
  genderHint?: string;
  ageHint?: string;
  ethnicityHint?: string;
  generationPrompt?: string;
}

interface StoryboardReferenceAssetReviewVisualPayload {
  tempId?: string;
  name?: string;
  summary?: string;
  generationPrompt?: string;
}

interface StoryboardReferenceAssetReviewPayload {
  shotAssignments?: StoryboardReferenceAssetReviewShotAssignmentPayload[];
  newAssets?: {
    characters?: StoryboardReferenceAssetReviewCharacterPayload[];
    scenes?: StoryboardReferenceAssetReviewVisualPayload[];
    objects?: StoryboardReferenceAssetReviewVisualPayload[];
  };
}

export interface StoryboardReferenceAssetReviewResult {
  storyboard: StoryboardShot[];
  referenceLibrary: ProjectReferenceLibrary;
  addedReferenceAssetCount: number;
  addedCharacterCount: number;
  addedSceneCount: number;
  addedObjectCount: number;
  reassignedShotCount: number;
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
  const dialogueIdentifier = normalizeStoryboardDialogueIdentifier(input?.dialogueIdentifier);
  const durationSeconds = applyStoryboardDialogueMarkerDurationBonus(
    normalizeDuration(input?.durationSeconds, getStoryboardShotFallbackDurationSeconds(settings)),
    dialogueIdentifier,
    settings
  );

  return {
    id: `scene-${sceneNumber}-shot-${shotNumber}`,
    sceneNumber,
    shotNumber,
    title,
    purpose: normalizeString(input?.purpose, '推进剧情'),
    durationSeconds,
    dialogueIdentifier,
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
  const shotDurationGuideline = buildStoryboardShotDurationGuideline(settings);
  const shotSplitGuideline = buildStoryboardShotSplitGuideline(settings);
  const sceneRules = script.scenes
    .map(
      (scene) =>
        `- 场景 ${scene.sceneNumber}（${scene.durationSeconds}s）：至少 ${getMinimumShotsForScene(scene, settings)} 个镜头；如果对白来回、动作阶段、空间揭示或反应点更密集，可以继续增加反打/插入/细节/环境承接镜头`
    )
    .join('\n');

  return [
    {
      role: 'system',
      content:
        '你是一名专业电影分镜导演，负责把电影剧本拆成适合 AI 生图和 AI 视频生成的镜头。接下来会通过多轮对话先完成全局拆镜规划，再逐轮生成单个完整镜头。每一轮都只输出当前要求的 JSON，不要输出任何额外说明。'
    },
    {
      role: 'user',
      content: `我们将通过多轮对话完成整部影片的分镜设计。第 1 轮先输出整部影片的分镜规划，必须给出总镜头数和每个镜头的概况；从第 2 轮开始，我会按规划顺序逐轮向你索取单个完整镜头，你必须在连续多轮中保持人物外观、服装、道具、空间关系和情绪推进一致。

全局要求：
1. 每个镜头必须包含起始参考帧描述 firstFramePrompt、布尔字段 useLastFrameReference，以及视频片段描述 videoPrompt；只有在镜头确实需要明确结束画面约束时，才把 useLastFrameReference 设为 true 并提供 lastFramePrompt，否则设为 false 且 lastFramePrompt 置空字符串
2. 每个镜头必须额外提供 backgroundSoundPrompt，用于描述环境音、动作音、氛围音，不要写人物对白；如果镜头没有台词或旁白，也必须明确写出自然的环境声、动作声和空间氛围声，不能写成静音
3. 每个镜头必须额外提供 speechPrompt，用于描述该镜头的台词/旁白配音方式、语气、节奏、情绪；如果镜头里有人说话，必须通过人物身份、年龄感、外观和气质特征明确当前说话者，不要只写角色名；如果没有台词或旁白，要明确写“无语音内容”。${spokenLanguageRequirement}
4. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
5. 项目篇幅为 ${STORY_LENGTH_LABELS[settings.storyLength]}；当前剧本共有 ${script.scenes.length} 个场景，你必须在多轮对话结束后完整覆盖全部现有场景，不得跳场，也不要臆造新的 scene。如果当前剧本场景数低于该篇幅的推荐值，也继续基于现有场景完成拆镜
6. 镜头数量不要预设上限，由你根据戏剧节奏、信息密度、动作复杂度、对白来回和情绪变化自行决定；但镜头颗粒度不能过粗。当前剧本总时长约 ${script.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)} 秒，全剧至少按 ${recommendedMinimumShotCount} 个镜头起步，允许明显高于这个参考值；尤其在对白交锋、追逐打斗、搜证调查、关键道具动作、视线反应和空间揭示处，要优先多拆反打、过肩、插入、主观、动作细节和环境承接镜头，避免把多个戏剧节拍硬塞进一个镜头。只有确实单一动作/单一反应/明确一镜到底的段落，才保留为一个长一点的镜头
7. 分场镜头密度参考如下：
${sceneRules}
8. ${shotSplitGuideline}
9. ${shotDurationGuideline}
10. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；这是硬上限，不是建议值。任何一个镜头的 durationSeconds 都不能超过它；如果一段动作、对白或情绪变化超出这个上限，你必须主动拆成多个镜头，不要依赖系统自动拼接兜底
11. 构图、镜头运动、光线、表情、动作的起势、过程、停顿和收势都要写清楚，避免动作刚开始就立刻结束，避免镜头内状态跳变过猛
12. firstFramePrompt 不能只写剧情摘要或抽象事件，必须写成可直接生图的起始参考帧画面说明：明确景别、机位、构图、主体位置、人物外观与姿态、视线方向、眼神焦点、眼神状态、表情、手部动作、关键道具、前中后景层次、环境细节、时间与光线，并冻结在镜头起始瞬间；人物视线必须根据对手、道具、动作目标、画外空间或运动方向来设计，除非这个镜头明确需要主观凝视、对镜交流或正面压迫感，否则不要默认所有角色都面朝镜头或直视屏幕；如果是单人独处镜头且没有明确互动对象，默认让人物看向画外左/右侧、手中物件、门口/窗外/走廊深处等环境锚点或行进方向，不要只写“看向前方”；它必须对应一张单张电影级静帧，不能写成海报、拼贴、多联画、设定板、字幕画面或概念草图。不要使用文学性隐喻或抽象修辞，优先写墙面返潮、地面反光、水汽、污渍、光线方向、材质和人物姿态这些可直接看见的画面信息
13. 只有在镜头需要明确落幅、动作落点、收束构图、镜头终点状态或不提供结束参考帧就容易跑偏时，才把 useLastFrameReference 设为 true；不要机械地给每个镜头都加尾帧约束
14. 当 useLastFrameReference 为 true 时，lastFramePrompt 必须写成可直接生图的结束参考帧画面说明，明确镜头结束时的景别、机位、构图、人物状态、视线方向、眼神焦点、眼神状态、道具状态和环境状态；人物视线同样要跟随互动对象、动作落点、画外方向或下一步运动趋势，除非镜头语言明确要求对镜看，否则不要默认正对屏幕；如果是单人独处镜头且没有明确互动对象，默认让人物看向画外左/右侧、手中物件、门口/窗外/走廊深处等环境锚点或下一步运动方向，不要只写“看向前方”；同样不要使用文学性隐喻或抽象修辞，要优先写可直接看见的环境、光线、材质、姿态和视线落点；当 useLastFrameReference 为 false 时，lastFramePrompt 必须输出空字符串
15. longTakeIdentifier 只用于“明确要保持一镜到底，但因总时长超过 ${maxVideoSegmentDurationSeconds} 秒不得不拆段生成”的连续分段，例如 scene-2-longtake-1；如果只是按对白接话、反应点、动作细节、景别变化或空间揭示主动切成多个普通镜头，即使这一组镜头总时长不长，也应分别输出 longTakeIdentifier = null；如果某条一镜到底在 ${maxVideoSegmentDurationSeconds} 秒内可以拍完且内部没有必要拆节拍，也可以保留为一个镜头并输出 null
16. 当某个镜头与前一个镜头的 longTakeIdentifier 相同，系统会直接复用前一个镜头视频的尾帧作为当前镜头首帧，不再单独生成当前镜头的起始参考帧；因此只有在画面、机位、动作和空间关系都应连续承接时，才能复用同一个 longTakeIdentifier
17. videoPrompt 必须先描述镜头本身，再描述人物、动作、表演、环境、光线和氛围。优先从景别、机位、运镜、镜头节奏写起，不要一上来先写剧情摘要或对白内容；它只能描述当前镜头内部可执行的连续画面，不要写“切到某人反应”“转到另一个机位”“插入特写”“切到下一镜”等段内切镜指令
18. 人物一致性是硬约束。只要剧本没有明确要求变化，角色的脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和整体气质都必须在多轮对话和相邻镜头中保持稳定
19. videoPrompt 和 speechPrompt 如果需要描述台词内容，不要用中文或英文引号包裹台词文本，直接描述某人说某句话即可
20. 为保证单镜头字段可直接执行，每个字段都要写得具体、画面信息完整、动作节奏清楚，但不要堆砌重复形容词：title、purpose、camera、composition 各 1 句；firstFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt 各 1 到 2 句；只有在 useLastFrameReference 为 true 时才输出 1 到 2 句的 lastFramePrompt，但它必须优先保证画面信息完整，不要偷懒简写成剧情提示
21. 如果一个镜头包含对白、旁白、接话停顿、说话口型表演或以语音反应为核心的表演节奏，必须额外输出 dialogueIdentifier；非语音镜头输出 null
22. dialogueIdentifier 现在只作为“该镜头最终时长在规划归一化阶段自动 +${STORYBOARD_DIALOGUE_MARKER_DURATION_BONUS_SECONDS} 秒，且不超过 ${maxVideoSegmentDurationSeconds} 秒上限”的标记，不再触发额外连续对白简报；字段里只需要输出稳定可读的 groupId，例如 scene-2-dialogue-1，系统会自动补全 sequenceIndex、sequenceLength 和 flowRole
23. 每个镜头必须额外输出 referenceAssetIds 数组，用来指明这个镜头后续需要哪些参考图。下方资产列表会在资产阶段统一生成成参考图；你现在要先根据名称、类别、摘要和细节选出这个镜头实际需要依赖的项，不能只看 ID 猜测
24. referenceAssetIds 只能使用下方资产列表里给出的 id，不能杜撰新 id；优先包含镜头中实际出现或需要约束的场景、角色和关键物品，保持精简但不要漏掉关键资产
25. 如果同一角色存在多个年龄段资产，必须根据当前 scene 的时间线和剧情阶段选择正确年龄段，不能把少年版和成年版混用
26. referenceAssetIds 至少要覆盖当前镜头的核心场景和主要出镜角色；关键道具在构图、动作或剧情推进中重要时也要补入
27. sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
28. 第 1 轮只输出总镜头数和所有镜头概况，不要提前输出完整镜头字段；后续每一轮只输出当前指定的单个完整镜头 JSON，不能提前生成其他镜头，也不要重复已完成镜头

剧本 JSON：
${JSON.stringify(script, null, 2)}

资产列表（资产阶段会统一生成参考图）：
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
  const shotDurationGuideline = buildStoryboardShotDurationGuideline(settings);
  const shotSplitGuideline = buildStoryboardShotSplitGuideline(settings);
  const retryNotice = retryFeedback
    ? `\n上一次规划结果不合格，必须修正以下问题：\n${retryFeedback}\n本次输出必须一次性给出修正后的完整分镜规划 JSON。\n`
    : '';
  const sceneRules = script.scenes
    .map(
      (scene) =>
        `- 场景 ${scene.sceneNumber}（${scene.durationSeconds}s）：至少 ${getMinimumShotsForScene(scene, settings)} 个镜头；如果对白来回、动作阶段、空间揭示或反应点更密集，可以继续增加反打/插入/细节/环境承接镜头`
    )
    .join('\n');

  return `现在进行第 1 轮：先生成整部影片的分镜规划。${retryNotice}

要求：
1. 这一轮只能输出整部剧的分镜规划 JSON，必须先明确 totalShots，并给出全部镜头的概况；不要输出 firstFramePrompt、lastFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt、camera、composition、transitionHint 等完整镜头字段
2. 项目篇幅为 ${STORY_LENGTH_LABELS[settings.storyLength]}；当前剧本共有 ${script.scenes.length} 个场景，你必须完整覆盖全部现有场景，不得跳场，也不要臆造新的 scene。如果当前剧本场景数低于该篇幅的推荐值，也继续基于现有场景完成规划
3. 全剧至少按 ${recommendedMinimumShotCount} 个镜头起步，按场景下限累积出的最低参考值约为 ${minimumShotCount} 个镜头；可以根据对白交锋、动作细节、视线反应、道具插入和空间揭示继续往上加镜头，但不要低于各场景下限，也不要用无效空镜凑数
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
14. 如果一个规划镜头包含对白、旁白、接话停顿、说话口型表演或以语音反应为核心的表演节奏，必须输出 dialogueIdentifier；非语音镜头输出 null
15. dialogueIdentifier 现在只作为“该镜头最终时长在规划归一化阶段自动 +${STORYBOARD_DIALOGUE_MARKER_DURATION_BONUS_SECONDS} 秒，且不超过 ${maxVideoSegmentDurationSeconds} 秒上限”的标记，不再触发额外连续对白简报；这一轮只需要输出稳定可读的 groupId，例如 scene-1-dialogue-1，系统会自动补全 sequenceIndex、sequenceLength 和 flowRole
16. longTakeIdentifier 只用于“明确要保持一镜到底，但因总时长超过 ${maxVideoSegmentDurationSeconds} 秒不得不拆段生成”的连续分段，例如 scene-1-longtake-1；如果只是按对白接话、反应点、动作细节、景别变化或空间揭示主动切成多个普通镜头，即使这一组镜头总时长不长，也应分别输出 longTakeIdentifier = null；如果某条一镜到底在 ${maxVideoSegmentDurationSeconds} 秒内可以拍完且内部没有必要拆节拍，也可以保留为一个规划镜头并输出 null
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
6. camera、composition、transitionHint、promptHint 必须服务于连续对白拍法，强调轴线、视线方向、人物站位、景别切换、谁接谁的话、在哪里切到反应、如何从上一镜自然进入下一镜；视线默认应看向说话对象、被关注的人/物或画外反应方向，不要把所有角色都安排成面朝镜头，除非该镜头明确是主观镜头、对镜独白或刻意直视观众
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
      '保持人物站位、视线方向、情绪升级和动作承接连续，切镜优先跟随接话点、反应点和情绪波峰；视线应主要落在对手、道具或画外空间上，不要默认所有人物都正对镜头。'
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
          `${planShot.title}需要明确当前说话者、听者反应和两人的空间关系，避免视线与站位突然跳变；不要默认人物都面朝镜头，优先让视线落在对话对象或画外反应方向。`
        ),
        transitionHint: normalizeString(
          matched?.transitionHint,
          '通过接话、视线承接、动作延续或情绪反应自然切入下一镜，避免硬切。'
        ),
        promptHint: normalizeString(
          matched?.promptHint,
          `${planShot.title}需要保留对白接力点、停顿节奏、人物视线方向和空间朝向的连续性；除非该镜头明确需要对镜交流，否则不要把人物视线统一写成直视镜头。`
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
  retryFeedback = ''
): string {
  const scene = script.scenes.find((item) => item.sceneNumber === shotPlan.sceneNumber);

  if (!scene) {
    throw new Error(`分镜生成失败：找不到 sceneNumber = ${shotPlan.sceneNumber} 的剧本场景。`);
  }

  const maxVideoSegmentDurationSeconds = getEffectiveMaxVideoSegmentDurationSeconds(settings);
  const spokenLanguageRequirement = buildStoryboardSpokenLanguageRequirement(settings.language);
  const spokenLanguageLabel = describeProjectLanguage(settings.language);
  const shotSplitGuideline = buildStoryboardShotSplitGuideline(settings);
  const retryNotice = retryFeedback
    ? `\n上一次结果不合格，必须修正以下问题：\n${retryFeedback}\n本次输出必须一次性给出修正后的完整镜头 JSON。\n`
    : '';
  const continuityNotice =
    shotIndex > 0
      ? `前面已经完成了 ${shotIndex}/${planShots.length} 个镜头。你必须延续已建立的人物外观、服装、道具状态、空间关系和情绪推进。`
      : '这是第一个完整镜头，需要为整部影片建立稳定的人物与视觉基调。';
  const dialogueIdentifierOutput = shotPlan.dialogueIdentifier?.groupId
    ? JSON.stringify({ groupId: shotPlan.dialogueIdentifier.groupId })
    : 'null';
  const longTakeIdentifierOutput = shotPlan.longTakeIdentifier ? JSON.stringify(shotPlan.longTakeIdentifier) : 'null';
  const dialogueDurationNotice = shotPlan.dialogueIdentifier?.groupId
    ? `对话标记说明：当前镜头带 dialogueIdentifier，系统已在分镜规划阶段把该镜头时长按“原规划时长 + ${STORYBOARD_DIALOGUE_MARKER_DURATION_BONUS_SECONDS} 秒，且不超过 ${maxVideoSegmentDurationSeconds} 秒上限”做了补偿；这个标记现在只用于时长补偿，不再触发额外连续对白简报。`
    : '对话标记说明：当前镜头没有 dialogueIdentifier，不做额外时长补偿。';
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

${dialogueDurationNotice}

要求：
1. 只能输出这一个镜头的完整 JSON，不能输出其他镜头
2. sceneNumber 必须是 ${shotPlan.sceneNumber}，shotNumber 必须是 ${shotPlan.shotNumber}，title 必须保持为 ${JSON.stringify(shotPlan.title)}，purpose 必须保持为 ${JSON.stringify(shotPlan.purpose)}，durationSeconds 必须保持为 ${shotPlan.durationSeconds}
3. 必须把当前规划里的 overview 展开成完整可执行分镜，但不能偏离该镜头承担的戏剧功能
4. ${dialogueIdentifierRequirement}
5. ${longTakeIdentifierRequirement}
6. dialogue、voiceover、camera、composition、transitionHint 和 speechPrompt 直接根据当前剧本场景、当前镜头规划、前后镜头关系和已完成镜头摘要生成；videoPrompt 只保留当前单镜头内部可执行的动作、表演、运镜和连续性要求，不要把切到反应镜、换机位或进入下一镜直接写进当前视频段
7. 每个镜头必须包含起始参考帧描述 firstFramePrompt、布尔字段 useLastFrameReference，以及视频片段描述 videoPrompt；只有在镜头确实需要明确结束画面约束时，才把 useLastFrameReference 设为 true 并提供 lastFramePrompt，否则设为 false 且 lastFramePrompt 置空字符串
8. 每个镜头必须额外提供 backgroundSoundPrompt，用于描述环境音、动作音、氛围音，不要写人物对白；如果镜头没有台词或旁白，也必须明确写出自然的环境声、动作声和空间氛围声，不能写成静音
9. 每个镜头必须额外提供 speechPrompt，用于描述该镜头的台词/旁白配音方式、语气、节奏、情绪；如果镜头里有人说话，必须通过人物身份、年龄感、外观和气质特征明确当前说话者，不要只写角色名；如果没有台词或旁白，要明确写无语音内容。${spokenLanguageRequirement}
10. 人物外观必须稳定，场景信息要具体，方便 ComfyUI 直接使用
11. ${shotSplitGuideline} 当前镜头已经固定为 ${shotPlan.durationSeconds} 秒，你必须在这个时长内把起势、过程、停顿和收势写完整
12. 当前视频工作流允许的单个镜头时长上限就是 ${maxVideoSegmentDurationSeconds} 秒；当前镜头时长已固定为 ${shotPlan.durationSeconds} 秒，不得改写
13. 构图、镜头运动、光线、表情、动作的起势、过程、停顿和收势都要写清楚，避免动作刚开始就立刻结束，避免镜头内状态跳变过猛
14. firstFramePrompt 不能只写剧情摘要或抽象事件，必须写成可直接生图的起始参考帧画面说明：明确景别、机位、构图、主体位置、人物外观与姿态、视线方向、眼神焦点、眼神状态、表情、手部动作、关键道具、前中后景层次、环境细节、时间与光线，并冻结在镜头起始瞬间；人物视线必须根据对手、道具、动作目标、画外空间或运动方向来设计，除非这个镜头明确需要主观凝视、对镜交流或正面压迫感，否则不要默认所有角色都面朝镜头或直视屏幕；如果是单人独处镜头且没有明确互动对象，默认让人物看向画外左/右侧、手中物件、门口/窗外/走廊深处等环境锚点或行进方向，不要只写“看向前方”；它必须对应一张单张电影级静帧，不能写成海报、拼贴、多联画、设定板、字幕画面或概念草图。不要使用压着潮湿空气、绝望爬上墙面、空气在发抖这类文学性隐喻或抽象修辞，优先写墙面返潮、地面反光、水汽、污渍、光线方向、材质和人物姿态这些可直接看见的画面信息
15. 只有在镜头需要明确落幅、动作落点、收束构图、镜头终点状态或不提供结束参考帧就容易跑偏时，才把 useLastFrameReference 设为 true；不要机械地给每个镜头都加尾帧约束
16. 当 useLastFrameReference 为 true 时，lastFramePrompt 必须写成可直接生图的结束参考帧画面说明，明确镜头结束时的景别、机位、构图、人物状态、视线方向、眼神焦点、眼神状态、道具状态和环境状态；人物视线同样要跟随互动对象、动作落点、画外方向或下一步运动趋势，除非镜头语言明确要求对镜看，否则不要默认正对屏幕；如果是单人独处镜头且没有明确互动对象，默认让人物看向画外左/右侧、手中物件、门口/窗外/走廊深处等环境锚点或下一步运动方向，不要只写“看向前方”；同样不要使用文学性隐喻或抽象修辞，要优先写可直接看见的环境、光线、材质、姿态和视线落点；当 useLastFrameReference 为 false 时，lastFramePrompt 必须输出空字符串
17. 如果当前镜头与前一个镜头使用同一个 longTakeIdentifier，你仍然要给出完整的 firstFramePrompt 作为连续性描述，但系统会直接复用前一个视频尾帧作为当前首帧，不会单独生图；因此这类 longTakeIdentifier 只能用于真正无缝承接的长镜头拆段
18. videoPrompt 必须先描述镜头本身，再描述人物、动作、表演、环境、光线和氛围。优先从景别、机位、运镜、镜头节奏写起，不要一上来先写剧情摘要或对白内容；它只能描述当前镜头内部可执行的连续画面，不要写“切到某人反应”“转到另一个机位”“插入特写”“切到下一镜”等段内切镜指令
19. 人物一致性是硬约束。只要剧本没有明确要求变化，角色的脸型五官、发型发色、体型、服装主色、关键配饰、年龄感和整体气质都必须在当前镜头与已完成镜头之间保持稳定
20. videoPrompt 和 speechPrompt 如果需要描述台词内容，不要用中文或英文引号包裹台词文本，直接描述某人说某句话即可
21. 为保证单镜头字段可直接执行，每个字段都要写得具体、画面信息完整、动作节奏清楚，但不要堆砌重复形容词：title、purpose、camera、composition 各 1 句；firstFramePrompt、videoPrompt、backgroundSoundPrompt、speechPrompt 各 1 到 2 句；只有在 useLastFrameReference 为 true 时才输出 1 到 2 句的 lastFramePrompt，但它必须优先保证画面信息完整，不要偷懒简写成剧情提示
22. sceneNumber、shotNumber、durationSeconds 必须输出纯整数阿拉伯数字，不能写成 1,0、1.0、01 这类格式
23. 你必须结合上文资产列表里的名称、摘要和细节判断这个镜头后续该用哪些参考图，并把对应 id 写进 referenceAssetIds；资产阶段会统一把这些资产生成成参考图，不能只看 id 猜测含义
24. 如果同一角色存在多个年龄段资产，必须根据当前 scene 的时间线和剧情阶段选择正确年龄段，不能把少年版和成年版混用
25. referenceAssetIds 至少要覆盖当前镜头的核心场景和主要出镜角色；关键道具在构图、动作或剧情推进中重要时也要补入
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
        dialogueIdentifier: normalizeStoryboardDialogueIdentifier(rawShot.dialogueIdentifier),
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

    const resolvedShot = applyStoryboardReferenceAssetFallback(normalizedShot, script, options?.referenceLibrary);

    const validation = validateStoryboardShotAgainstPlan(
      resolvedShot,
      shotPlan,
      settings,
      availableReferenceAssetIds
    );

    if (validation.ok) {
      return {
        requestPrompt,
        shot: resolvedShot
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
  "referenceAssets": {
    "characters": [
      {
        "name": "角色名（年龄段）",
        "summary": "该年龄段角色作用和外观摘要",
        "genderHint": "简短的性别提示",
        "ageHint": "简短的年龄阶段提示",
        "ethnicityHint": "简短的人种/族裔提示",
        "generationPrompt": "该年龄段的人物外貌特点提示词，只写稳定外观和身份特征"
      }
    ],
    "scenes": [
      {
        "name": "场景名",
        "summary": "空间用途、空间分区和核心氛围",
        "generationPrompt": "用于单一可复用空镜机位/分区场景参考图生成的详细提示词；同一地点可拆分多个互补 scene 资产"
      }
    ],
    "objects": [
      {
        "name": "物品名",
        "summary": "物品的重要性和状态",
        "generationPrompt": "用于单体道具/陈设参考图生成的详细提示词；强调完整轮廓、材质、状态和可读角度"
      }
    ]
  },
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
5. 项目篇幅档位为${STORY_LENGTH_LABELS[settings.storyLength]}；这不是机械报数，但请优先把剧本写到 ${target.minimumScenes} 到 ${target.maximumScenes} 场、总时长约 ${target.minimumTotalDurationSeconds} 到 ${target.maximumTotalDurationSeconds} 秒的体量区间。若原始素材偏短，可以沿主线补足“行动准备/调查铺垫/正面冲突/反应余波/新钩子”这些有明确因果与戏剧功能的场次，把关键事件拆开写扎实，而不是把多个转折压缩在一场里。${target.pacingInstruction}
6. 每场必须写成真正可拍的剧本，而不是只有 summary、dialogue 列表的场景大纲；sceneHeading、conflict、turningPoint 和 scriptBlocks 都是硬约束
7. scriptBlocks 必须按实际发生顺序排列，至少包含 action；需要对白时再写 dialogue，需要画外音时再写 voiceover；只有必要时才写 transition
8. action 只能写看得见、拍得到的动作、表情、调度、空间变化和道具状态，不要写作者点评、主题说明或空泛总结
9. dialogue 要口语化、短促、带潜台词；parenthetical 只写必要表演提示，不要每句都加
10. 每场内部都要在 scriptBlocks 中体现起势、对抗、反应、转折和收束，尽量把动作推进、对白来回、停顿反应和道具调度拆成多条连续 block；除非该场极短，否则不要只写 2 到 3 条概括性交代
11. durationSeconds 必须给出正整数秒，并按剧情节奏自行决定；如果素材不足，不要为了凑总时长重复同类桥段；如果素材过多，优先压缩、合并和聚焦主线
12. 人物外观和身份要稳定，便于后续持续生成画面
13. referenceAssets 是硬约束，必须在剧本阶段一次性输出完整资产列表；后续资产阶段会直接按这个列表生成，不会再单独向模型二次提取
14. referenceAssets.characters 不要只保留主角，要尽量覆盖主角、重要配角、反复出现群演/职业身份型背景人物、以及同一人物的年龄/服装/伤妆/状态变体；如果同一人物在剧本里以明显不同年龄段或显著不同造型状态出场，必须拆成多个独立资产，name 要直接带上变体标记
15. referenceAssets.characters 的 generationPrompt 只写稳定的人物外观与身份特征，重点描述年龄感、脸型五官、发型、体型、服装层次、面料材质、标志性配饰、轮廓差异、气质、常态表情，不要写三视图、镜头运动或具体剧情动作
16. referenceAssets.scenes 提取可复用的场景母版集合，不要限制成“每个地点只有一个角度”；同一地点如有多个明确可拍区域、主机位、纵深关系、或不同时间/天气/光线状态，应拆成多个独立 scene 资产，name 带上分区/视角/时间标记；每个 scene 资产本身必须是单一空镜机位、无人物、无剧情动作，强调空间结构、前中后景、入口动线、光线、材质、陈设和氛围
17. referenceAssets.scenes 默认按“每场至少有对应母版，复杂场景再额外补 1 到 3 个 scene 变体”的密度来输出；不要少于剧本场次数，较长或复杂场景宁多勿少
18. referenceAssets.objects 不要只保留推动剧情的大道具，也要尽量覆盖反复出现、画面辨识度高、能增加布景质感或角色动作可信度的陈设、小道具、载具、屏幕设备、文件纸张、标志物、服饰配件；如果同一物品有明显状态变化要拆分资产，prompt 强调完整轮廓、材质、状态、摆放方式、尺寸感和可读角度
19. 如果输入素材很多，优先保住主线清晰度，但不要把关键对抗、调查过程、关系裂变和场尾反转过度压扁；如果输入素材有限，可以围绕角色动机、行动阻碍、线索推进、追逼反应、道具使用和情绪余波扩写有效场次，但不要靠重复桥段、解释性对白或无效过场凑体量
20. 只输出 JSON，不要输出解释、标题外文本或 Markdown 代码块`;
}

function buildUploadedScriptPromptContext(settings: ProjectSettings): string {
  return `上传剧本整理要求：
1. 输出语言：${settings.language}
2. 视觉调性：${settings.visualStyle}
3. 这次任务只做“结构化导入”，不是重新创作、不是剧本医生式优化、不是按篇幅档位扩写或删减
4. 必须尽量保留上传剧本原有场景顺序、人物关系、事件因果、动作描写、对白原文、画外音原文和转场意图
5. 允许补全结构字段 sceneHeading、location、timeOfDay、summary、emotionalBeat、conflict、turningPoint、durationSeconds、styleNotes、characters 和 referenceAssets，但补全必须根据原文可推断信息完成，不能新增无根据桥段或改写原有台词
6. 如果上传内容已经是完整 JSON 剧本，请优先做字段映射、纠错和补漏，不要重写剧情正文
7. 每场必须整理成真正可拍的 scriptBlocks，并按原文实际发生顺序排列；至少包含 action，需要对白时再写 dialogue，需要画外音时再写 voiceover，只有必要时才写 transition
8. action 只能写看得见、拍得到的动作、表情、调度、空间变化和道具状态，不要写作者点评、主题说明或新增剧情解释
9. dialogue 必须尽量保持原台词措辞，只在原文存在明显格式破损、标点错误或角色名缺失时做最低限度修正
10. durationSeconds 必须给出正整数秒；如果原文没有明确时长，只根据该场动作/对白信息量做保守估算，不要为了项目篇幅目标主动拉长或压缩
11. referenceAssets 必须在同一次输出里补齐，供后续资产阶段直接生成；在不虚构原文之外新桥段的前提下，尽量提取原剧本中真实存在且后续可复用的主角、重要配角、反复出现群演/背景身份、场景多机位/分区/时间氛围母版，以及高辨识度道具/陈设/载具/屏幕设备/文件/标志物/配饰
12. referenceAssets.characters 的 generationPrompt 只写稳定外观和身份特征，重点描述服装层次、材质、配饰、轮廓差异和常态表情；如果同一人物存在明显年龄/造型/状态差异，要拆成多个资产并在 name 标注变体，不要写镜头运动或具体剧情动作
13. referenceAssets.scenes 必须是空镜环境、无人物、无剧情动作、无事件瞬间；每个 scene 资产只描述一个可复用机位或空间分区，但同一地点可以拆成多个互补 scene 资产，并强调空间结构、前中后景、入口动线、时间、光线、材质、陈设和氛围
14. referenceAssets.objects 不要只保留推动剧情的大道具，也要覆盖反复出现或画面辨识度高的小道具/陈设/载具/屏幕设备/文件/标志物/配饰；如有明显状态变化要拆分资产，prompt 强调完整轮廓、材质、状态、摆放方式、尺寸感和可读角度
15. 只输出 JSON，不要输出解释、标题外文本或 Markdown 代码块`;
}

function buildScriptMessages(
  sourceText: string,
  settings: ProjectSettings,
  retryFeedback = ''
): ChatCompletionMessageParam[] {
  const outputSchema = buildScriptOutputSchema(settings);
  const sharedContext =
    settings.scriptMode === 'upload'
      ? buildUploadedScriptPromptContext(settings)
      : buildScriptPromptContext(settings);
  const retryNotice = retryFeedback
    ? `\n\n上一次输出存在以下问题，这次必须全部修正后再返回完整 JSON：\n${retryFeedback}`
    : '';

  if (settings.scriptMode === 'optimize') {
    return [
      {
        role: 'system',
        content:
          '你是一名资深中文电影剧本医生和总编剧，擅长在保留核心卖点的前提下修复节奏、增强戏剧张力、压缩废戏、强化转折，并把粗稿整理成可直接进入分镜阶段的专业电影剧本。只输出 JSON，不要输出任何额外说明。'
      },
      {
        role: 'user',
        content: `请优化下面的影视文本，使其更适合专业电影叙事和 AI 分镜生产。

${sharedContext}
${retryNotice}

优化目标：
1. 保留原文中可成立的核心设定、人物关系、主要事件和情绪走向，不要无故推翻故事根基
2. 优先修复开场不够抓人、冲突不够集中、情绪不够陡、场次重复、对白拖沓的问题
3. 开场必须尽快建立强悬念、威胁、欲望目标或核心利益冲突
4. 每一场都要有明确目标、阻碍、转折或信息增量，避免空转
5. 每场都必须写成连续剧本块 scriptBlocks，至少要让读者看到人物动作、表情反应、对白来回、道具调度和场尾转折；可以把原文里一笔带过的关键冲突拆成“铺垫-对抗-余波/新钩子”多个场次或多段 block，不能只给几句概要
6. 对白要口语化、短促、利于表演，不要写成长篇讲述
7. 画外音只在必要时使用，避免重复解释画面已经表达的信息
8. 如果原文结构混乱，可以重组场次顺序，但不要丢失关键剧情信息
9. 如果原文缺少必要细节，可以补足角色动机、场景信息和情绪推进，使其成为完整可拍的电影剧本
10. 必须在同一次输出里同步给出 referenceAssets 资产列表，供后续资产阶段直接生成
11. 请优先写到上面的建议篇幅下限以上；如果素材不足，优先围绕主线补足行动准备、调查推进、反应余波、对抗升级和新钩子，而不是硬塞重复桥段；如果素材过多，优先压缩离主线最远的支线，不要牺牲关键对抗过程
12. 返回结构必须严格符合以下 JSON：
${outputSchema}

待优化文本：
${sourceText}`
      }
    ];
  }

  if (settings.scriptMode === 'upload') {
    return [
      {
        role: 'system',
        content:
          '你是一名专业中文电影剧本整理助理，只负责把用户上传的剧本文本结构化转换成可进入分镜阶段的标准 JSON。必须尽量保留原场景顺序、原事件关系和原台词措辞，不能擅自重写剧情。只输出 JSON，不要输出任何额外说明。'
      },
      {
        role: 'user',
        content: `请把下面上传的剧本文本整理成系统可用的标准结构化剧本 JSON。

${sharedContext}
${retryNotice}

整理目标：
1. 保持原剧本场景顺序、人物关系、动作事件和对白原意，不要当成“新剧本生成”或“重写优化”任务
2. 如果原文已经有场景标题、内外景/地点/时间、角色对白、动作段落、转场，请直接映射到对应字段和 scriptBlocks
3. 如果原文是非标准格式、分场不完整或角色字段缺失，可以做结构化拆分和字段补齐，但不能新增原文没有依据的桥段
4. 每场都必须输出可直接用于分镜的 scriptBlocks，按原文顺序组织 action / dialogue / voiceover / transition
5. 必须补齐 characters 和 referenceAssets，供后续资产阶段直接生成；资产描述只能基于原文已有信息和合理外观归纳
6. 返回结构必须严格符合以下 JSON：
${outputSchema}

上传剧本文本：
${sourceText}`
      }
    ];
  }

  return [
    {
      role: 'system',
      content:
        '你是一名资深中文电影编剧和项目主笔，擅长把梗概、设定、文案和零散想法发展成具有电影感、戏剧张力、情绪推进和视听可执行性的成型剧本。只输出 JSON，不要输出任何额外说明。'
    },
    {
      role: 'user',
      content: `请根据下面的素材生成一版完整的电影剧本。

${sharedContext}
${retryNotice}

生成目标：
1. 将输入素材扩写为完整电影剧本，而不是复述原文
2. 开场必须尽快建立人物关系、处境、危机、悬念或利益冲突，让观众迅速进入故事
3. 全剧要有持续升级的冲突链路，避免平铺直叙
4. 每场都要服务于主线推进，并给出清晰的情绪变化；中段可以主动设计调查、试探、误判、追逼、反击、关系破裂、代价加码、线索揭露等直接服务主线的新场次，把故事写得更完整
5. 角色数量控制在必要范围内，每个核心角色都要有鲜明身份、稳定外观和清晰动机
6. 每场都必须写成连续剧本块 scriptBlocks，让动作、对白、反应、道具调度、空间走位和转折按顺序发生；除非该场极短，否则优先拆成多条连续 block，不能退化成“场景介绍 + 几句台词”
7. 场景信息要具体到地点、时间和动作状态，方便后续直接拆分镜
8. 对白要简洁、准确、利于表演，尽量避免大段说明性台词和直白解释
9. 必须在同一次输出里同步给出 referenceAssets 资产列表，供后续资产阶段直接生成
10. 请优先写到上面的建议篇幅下限以上；如果素材偏少，可以沿主线补出“铺垫-执行-受阻-反转-余波/新钩子”的动作与情绪链条，不要把多个关键节点压成一场；如果素材过多，优先压缩离主线最远的支线，不要牺牲核心情节密度
11. 返回结构必须严格符合以下 JSON：
${outputSchema}

输入素材：
${sourceText}`
    }
  ];
}

function validateGeneratedScriptStructure(
  script: Pick<ScriptPackage, 'scenes' | 'referenceAssets'>,
  settings: ProjectSettings
): {
  ok: boolean;
  feedback: string;
} {
  const issues: string[] = [];
  const target = getStoryLengthScriptGenerationTarget(settings);
  const totalDurationSeconds = script.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const minimumSceneReferenceAssetCount = getMinimumSceneReferenceAssetCountForScript(script);

  if (!script.scenes.length) {
    issues.push('必须至少生成 1 场戏。');
  }

  if (settings.scriptMode !== 'upload' && script.scenes.length < target.minimumScenes) {
    issues.push(
      `当前只生成了 ${script.scenes.length} 场戏，低于${STORY_LENGTH_LABELS[settings.storyLength]}建议下限 ${target.minimumScenes} 场；请保留主线清晰度的前提下补足有明确冲突、反应、推进或反转功能的新场次。`
    );
  }

  if (settings.scriptMode !== 'upload' && totalDurationSeconds < target.minimumTotalDurationSeconds) {
    issues.push(
      `当前剧本总时长约 ${totalDurationSeconds} 秒，低于${STORY_LENGTH_LABELS[settings.storyLength]}建议下限 ${target.minimumTotalDurationSeconds} 秒；请优先通过补足行动过程、对抗升级、关系反应和场尾钩子来扩写，而不是重复同类对白。`
    );
  }

  if (!script.referenceAssets?.characters.length) {
    issues.push('referenceAssets.characters 不能为空，至少要有核心角色资产。');
  }

  if (!script.referenceAssets?.scenes.length) {
    issues.push('referenceAssets.scenes 不能为空，至少要有核心场景资产。');
  } else if (
    settings.scriptMode !== 'upload' &&
    script.referenceAssets.scenes.length < minimumSceneReferenceAssetCount
  ) {
    issues.push(
      `referenceAssets.scenes 当前只有 ${script.referenceAssets.scenes.length} 个，低于建议下限 ${minimumSceneReferenceAssetCount} 个；请为各场和复杂地点补足更多 scene 机位/分区/时间光线变体，不要只给少数万能场景。`
    );
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

interface ScriptGenerationPayload {
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
  referenceAssets?: {
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
  };
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
}

function normalizeScriptPackagePayload(
  payload: ScriptGenerationPayload,
  settings: ProjectSettings
): Omit<ScriptPackage, 'markdown'> {
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
    const derivedDialogue = normalizedDialogue.length
      ? normalizedDialogue
      : deriveSceneDialogueFromBlocks(scriptBlocks);
    const normalizedVoiceover =
      normalizeOptionalString(scene.voiceover) || deriveSceneVoiceoverFromBlocks(scriptBlocks);

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

  return {
    title: normalizeString(payload.title, '未命名电影'),
    tagline: normalizeString(payload.tagline, '电影级戏剧故事'),
    synopsis: normalizeString(payload.synopsis, '暂无梗概'),
    styleNotes: normalizeString(payload.styleNotes, settings.visualStyle),
    characters: (payload.characters ?? []).map((character, index) => ({
      name: normalizeString(character.name, `角色${index + 1}`),
      identity: normalizeString(character.identity, '身份未说明'),
      visualTraits: normalizeString(character.visualTraits, '外观统一、利于连续生成'),
      motivation: normalizeString(character.motivation, '推动剧情发展')
    })),
    referenceAssets: normalizeScriptReferenceAssets(payload.referenceAssets, settings),
    scenes
  };
}

function buildValidatedScriptPackage(
  payload: ScriptGenerationPayload,
  settings: ProjectSettings
): {
  script: ScriptPackage;
  feedback: string;
} {
  const scriptCore = normalizeScriptPackagePayload(payload, settings);
  const validation = validateGeneratedScriptStructure(scriptCore, settings);
  const scriptDraft = {
    ...scriptCore,
    validationWarnings: validation.feedback || undefined
  };

  return {
    script: {
      ...scriptDraft,
      markdown: formatScriptMarkdown(scriptDraft)
    },
    feedback: validation.feedback
  };
}

function tryParseUploadedScriptPackage(
  sourceText: string,
  settings: ProjectSettings
): {
  script: ScriptPackage | null;
  feedback: string;
} | null {
  const trimmedSourceText = sourceText.trim();

  if (!trimmedSourceText.startsWith('{') && !trimmedSourceText.startsWith('```')) {
    return null;
  }

  try {
    const payload = parseJsonPayload<ScriptGenerationPayload>(trimmedSourceText);
    return buildValidatedScriptPackage(payload, settings);
  } catch {
    return null;
  }
}

export async function generateScriptFromText(
  sourceText: string,
  settings: ProjectSettings,
  options?: {
    signal?: AbortSignal;
  }
): Promise<ScriptPackage> {
  let retryFeedback = '';
  let fallbackScript: ScriptPackage | null = null;

  if (settings.scriptMode === 'upload') {
    const parsedUpload = tryParseUploadedScriptPackage(sourceText, settings);

    if (parsedUpload?.script) {
      return parsedUpload.script;
    }

    retryFeedback = parsedUpload?.feedback ?? '';
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = await requestJson<ScriptGenerationPayload>(
      buildScriptMessages(sourceText, settings, retryFeedback),
      {
        temperature:
          attempt === 0
            ? settings.scriptMode === 'generate'
              ? 0.8
              : settings.scriptMode === 'optimize'
                ? 0.7
                : 0.2
            : settings.scriptMode === 'generate'
              ? 0.6
              : settings.scriptMode === 'optimize'
                ? 0.55
                : 0.15,
        maxTokens: getScriptGenerationMaxTokens(settings),
        signal: options?.signal
      }
    );
    const validatedScript = buildValidatedScriptPackage(payload, settings);

    if (!validatedScript.feedback) {
      return validatedScript.script;
    }

    fallbackScript = validatedScript.script;
    retryFeedback = validatedScript.feedback;
  }

  if (fallbackScript) {
    return fallbackScript;
  }

  const actionLabel = settings.scriptMode === 'upload' ? '剧本导入失败' : '剧本生成失败';
  throw new Error(`${actionLabel}：连续多次输出仍不满足结构化电影剧本要求。${retryFeedback}`);
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

function normalizeReferenceAssetReviewIdentityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s"'`“”‘’「」『』（）()【】[\]{}<>《》，,。.!！？?；;：:/\\|_-]+/g, '')
    .trim();
}

interface StoryboardSceneAssetVariantRequirement {
  scene: ScriptScene;
  shotCount: number;
  minimumSceneAssetCount: number;
}

interface StoryboardSceneAssetCoverageIssue extends StoryboardSceneAssetVariantRequirement {
  actualSceneAssetCount: number;
}

function getStoryboardReferenceAssetReviewMaxTokens(storyboard: StoryboardShot[]): number {
  return Math.min(32_000, Math.max(8_000, storyboard.length * 220 + 4_000));
}

function getMinimumSceneAssetVariantCountForScene(scene: ScriptScene, shotCount: number): number {
  const effectiveShotCount = Math.max(shotCount, Math.ceil(scene.durationSeconds / 15));
  let minimumSceneAssetCount = 1;

  if (effectiveShotCount >= 3 || scene.durationSeconds >= 20) {
    minimumSceneAssetCount = 2;
  }

  if (effectiveShotCount >= 6 || scene.durationSeconds >= 45) {
    minimumSceneAssetCount = 3;
  }

  if (effectiveShotCount >= 10 || scene.durationSeconds >= 90) {
    minimumSceneAssetCount = 4;
  }

  return minimumSceneAssetCount;
}

function getStoryboardSceneAssetVariantRequirements(
  script: ScriptPackage,
  storyboard: StoryboardShot[]
): StoryboardSceneAssetVariantRequirement[] {
  return script.scenes.map((scene) => {
    const shotCount = storyboard.filter((shot) => shot.sceneNumber === scene.sceneNumber).length;

    return {
      scene,
      shotCount,
      minimumSceneAssetCount: getMinimumSceneAssetVariantCountForScene(scene, shotCount)
    };
  });
}

function buildStoryboardSceneAssetVariantRequirementPrompt(
  script: ScriptPackage,
  storyboard: StoryboardShot[]
): string {
  return getStoryboardSceneAssetVariantRequirements(script, storyboard)
    .map(
      ({ scene, shotCount, minimumSceneAssetCount }) =>
        `- 场景 ${scene.sceneNumber}（${shotCount} 个镜头，${scene.durationSeconds}s，${scene.sceneHeading || buildFallbackSceneHeading(scene.location, scene.timeOfDay)}）：至少准备 ${minimumSceneAssetCount} 个 scene 资产，覆盖主机位/空间分区/纵深方向/时间光线中的明显差异`
    )
    .join('\n');
}

function getStoryboardSceneAssetCoverageIssues(
  script: ScriptPackage,
  storyboard: StoryboardShot[]
): StoryboardSceneAssetCoverageIssue[] {
  return getStoryboardSceneAssetVariantRequirements(script, storyboard)
    .map((requirement) => {
      const actualSceneAssetCount = new Set(
        storyboard
          .filter((shot) => shot.sceneNumber === requirement.scene.sceneNumber)
          .flatMap((shot) => shot.referenceAssetIds.filter((item) => item.startsWith('scene:')))
      ).size;

      return {
        ...requirement,
        actualSceneAssetCount
      };
    })
    .filter((issue) => issue.actualSceneAssetCount < issue.minimumSceneAssetCount);
}

function getMinimumSceneReferenceAssetCountForScript(script: Pick<ScriptPackage, 'scenes'>): number {
  const mediumOrLongScenes = script.scenes.filter((scene) => scene.durationSeconds >= 30).length;
  return Math.max(2, script.scenes.length + Math.ceil(mediumOrLongScenes / 2));
}

function buildStoryboardSceneAssetCoverageFeedback(
  script: ScriptPackage,
  storyboard: StoryboardShot[]
): string {
  const issues = getStoryboardSceneAssetCoverageIssues(script, storyboard);

  if (!issues.length) {
    return '';
  }

  return issues
    .map(
      (issue) =>
        `场景 ${issue.scene.sceneNumber} 当前只覆盖了 ${issue.actualSceneAssetCount} 个 scene 资产，但按该场 ${issue.shotCount} 个镜头 / ${issue.scene.durationSeconds}s 的信息量，至少需要 ${issue.minimumSceneAssetCount} 个；请补出不同主机位、空间分区、纵深方向或时间光线的空镜 scene 变体，并重新分配到相关镜头。`
    )
    .join('；');
}

function buildStoryboardReferenceAssetReviewShotContext(
  script: ScriptPackage,
  storyboard: StoryboardShot[]
): string {
  const sceneHeadingMap = new Map(
    script.scenes.map((scene) => [
      scene.sceneNumber,
      scene.sceneHeading || buildFallbackSceneHeading(scene.location, scene.timeOfDay)
    ])
  );

  return storyboard
    .map((shot) =>
      [
        `- 镜头: scene ${shot.sceneNumber} shot ${shot.shotNumber} | id: ${shot.id}`,
        `  场景标头: ${sceneHeadingMap.get(shot.sceneNumber) ?? `场景 ${shot.sceneNumber}`}`,
        `  标题/作用: ${shot.title} | ${shot.purpose}`,
        `  景别构图: ${shot.camera} | ${shot.composition}`,
        `  首帧画面: ${shot.firstFramePrompt}`,
        `  视频动作: ${shot.videoPrompt}`,
        shot.dialogue.trim() ? `  对白: ${shot.dialogue.trim()}` : '',
        shot.voiceover.trim() ? `  旁白: ${shot.voiceover.trim()}` : '',
        shot.referenceAssetIds.length ? `  当前资产: ${shot.referenceAssetIds.join(', ')}` : '  当前资产: 无'
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}

function buildStoryboardReferenceAssetReviewPrompt(
  script: ScriptPackage,
  settings: ProjectSettings,
  storyboard: StoryboardShot[],
  referenceLibrary: ProjectReferenceLibrary,
  retryFeedback = ''
): string {
  const retryNotice = retryFeedback
    ? `\n上一次输出存在以下问题，这次必须修正后再返回完整 JSON：\n${retryFeedback}\n`
    : '';
  const sceneAssetVariantRules = buildStoryboardSceneAssetVariantRequirementPrompt(script, storyboard);

  return `请对“已生成全量分镜 + 当前资产库”做一次全局资产复盘，逐镜头决定应该复用哪些旧资产、应该新增哪些资产，并输出每个镜头最终要绑定的 referenceAssetIds。${retryNotice}

复盘目标：
1. 提高资产数量和视觉多样性，不要把大量不同机位/不同空间分区/不同时间光线/不同状态镜头都硬复用同一两个 scene/object 资产
2. scene 资产数量宁多勿少；同一剧本场景内如果镜头数已经较多，就必须主动拆出多个场景母版，而不是把所有镜头都绑到同一个宽泛场景 id
3. 对同一地点，如果镜头在主机位、空间分区、拍摄方向、纵深关系、时间段、天气、光线氛围、陈设状态上明显不同，而当前资产库没有对应母版，就新增 scene 变体资产；name 必须直接带视角/分区/时间/光线标记
4. 对同一人物，如果镜头中存在明显服装造型、年龄阶段、伤妆、湿身、伪装、制服/礼服切换等外观状态变化，而当前资产库没有对应角色变体，就新增 character 变体资产；name 必须带年龄/造型/状态后缀
5. 对关键道具、载具、屏幕设备、文件、标志物、配饰和高辨识度陈设，如果镜头里有重要构图/动作/状态变化且当前资产库没有对应道具资产，就新增 object 资产；完好/破损、亮屏/熄屏、展开/收纳、干净/沾血等状态不同要拆成独立资产
6. 如果现有资产已经能准确覆盖某个镜头，就优先复用现有 id，不要为了“显得新增很多”而重复造同义资产；但如果现有 scene 资产只有单一宽泛母版，面对明显不同机位/分区/光线的镜头时必须主动补 scene 变体
7. scene 资产必须是空镜环境设定图：无人物、无角色名字、无剧情动作、无事件瞬间，只描述可复用空间结构、材质、入口/动线/遮挡、前中后景层次、时间光线和氛围
8. 下面这组“每场最低 scene 资产目标”是硬约束；输出结果必须至少满足：
${sceneAssetVariantRules}
9. character 资产 prompt 只写稳定人物外观和身份特征，重点写年龄感、脸型五官、发型、体型、服装层次、材质、标志性配饰、轮廓差异、气质和常态表情，不要写镜头运动或具体剧情动作
10. object 资产 prompt 重点写完整轮廓、材质、磨损/污渍/反光状态、摆放方式、尺寸感和可读角度，不要写成被角色手持动作中的剧情瞬间
11. 每个镜头的 referenceAssetIds 可以混合使用“现有资产 id”和“本轮新增资产 tempId”；如果某个纯人物/纯道具特写不需要 scene 参考图，允许只绑定 character/object 资产，避免 scene 参考图过度锁死构图和光线；但不要通过大量省略 scene 资产来规避上面的每场最低 scene 资产目标
12. 新增资产 tempId 必须使用稳定短 id，建议 new-character-1 / new-scene-1 / new-object-1 这类格式；不要和现有资产 id 重名；如果新增资产与现有资产同名但视觉状态不同，必须在 name 和 tempId 里直接加变体后缀，不要复用旧名字伪装新资产
13. 必须覆盖下方列出的每一个镜头，为每个镜头都输出一条 shotAssignments 记录；sceneNumber、shotNumber 必须和原分镜一致
14. generationPrompt 必须适合直接用于 AI 生图，并统一符合项目视觉风格：${settings.visualStyle}
15. 只输出 JSON，结构如下：
{
  "newAssets": {
    "characters": [
      {
        "tempId": "new-character-1",
        "name": "角色名（造型/状态变体）",
        "summary": "该角色资产的外观和用途摘要",
        "genderHint": "简短性别提示",
        "ageHint": "简短年龄阶段提示",
        "ethnicityHint": "简短人种/族裔提示",
        "generationPrompt": "可直接生成人物参考图的详细外观提示词"
      }
    ],
    "scenes": [
      {
        "tempId": "new-scene-1",
        "name": "场景名-机位/分区/时间/光线变体",
        "summary": "空间用途、分区、光线氛围摘要，不要写剧情动作",
        "generationPrompt": "可直接生成空镜场景设定图的详细提示词"
      }
    ],
    "objects": [
      {
        "tempId": "new-object-1",
        "name": "物品名（状态变体）",
        "summary": "道具外观、状态和用途摘要",
        "generationPrompt": "可直接生成道具参考图的详细提示词"
      }
    ]
  },
  "shotAssignments": [
    {
      "sceneNumber": 1,
      "shotNumber": 1,
      "referenceAssetIds": ["现有资产ID 或 new-scene-1/new-character-1/new-object-1"]
    }
  ]
}

当前资产库：
${buildStoryboardReferenceLibraryPrompt(referenceLibrary)}

全量分镜：
${buildStoryboardReferenceAssetReviewShotContext(script, storyboard)}`;
}

function cloneProjectReferenceLibrary(referenceLibrary: ProjectReferenceLibrary): ProjectReferenceLibrary {
  return {
    characters: [...referenceLibrary.characters],
    scenes: [...referenceLibrary.scenes],
    objects: [...referenceLibrary.objects]
  };
}

function buildReferenceAssetSelectionIndex(
  referenceLibrary: ProjectReferenceLibrary
): {
  availableSelectionIds: Set<string>;
  selectionIdByItemId: Map<string, string>;
} {
  const availableSelectionIds = new Set<string>();
  const selectionIdByItemId = new Map<string, string>();

  for (const item of referenceLibrary.characters) {
    const selectionId = buildStoryboardReferenceSelectionId('character', item.id);
    availableSelectionIds.add(selectionId);
    selectionIdByItemId.set(item.id, selectionId);
  }

  for (const item of referenceLibrary.scenes) {
    const selectionId = buildStoryboardReferenceSelectionId('scene', item.id);
    availableSelectionIds.add(selectionId);
    selectionIdByItemId.set(item.id, selectionId);
  }

  for (const item of referenceLibrary.objects) {
    const selectionId = buildStoryboardReferenceSelectionId('object', item.id);
    availableSelectionIds.add(selectionId);
    selectionIdByItemId.set(item.id, selectionId);
  }

  return {
    availableSelectionIds,
    selectionIdByItemId
  };
}

function getReferenceAssetItemsByKind(
  referenceLibrary: ProjectReferenceLibrary,
  kind: ReferenceAssetKind
): ReferenceAssetItem[] {
  if (kind === 'character') {
    return referenceLibrary.characters;
  }

  if (kind === 'scene') {
    return referenceLibrary.scenes;
  }

  return referenceLibrary.objects;
}

function buildReferenceAssetIdentityMap(
  referenceLibrary: ProjectReferenceLibrary,
  kind: ReferenceAssetKind
): Map<string, ReferenceAssetItem> {
  const identityMap = new Map<string, ReferenceAssetItem>();

  for (const item of getReferenceAssetItemsByKind(referenceLibrary, kind)) {
    const key = normalizeReferenceAssetReviewIdentityText(item.name);
    if (key && !identityMap.has(key)) {
      identityMap.set(key, item);
    }
  }

  return identityMap;
}

function createUniqueReferenceAssetItem(
  kind: ReferenceAssetKind,
  name: string,
  summary: string,
  generationPrompt: string,
  referenceLibrary: ProjectReferenceLibrary,
  usedReferenceItemIds: Set<string>,
  options: {
    ethnicityHint?: string;
    genderHint?: string;
    ageHint?: string;
  } = {}
): ReferenceAssetItem {
  const existingCount = getReferenceAssetItemsByKind(referenceLibrary, kind).length;
  let index = existingCount;
  let item = createReferenceItem(
    kind,
    name,
    summary,
    generationPrompt,
    index,
    options.ethnicityHint ?? '',
    options.genderHint ?? '',
    options.ageHint ?? ''
  );

  while (usedReferenceItemIds.has(item.id)) {
    index += 1;
    item = createReferenceItem(
      kind,
      name,
      summary,
      generationPrompt,
      index,
      options.ethnicityHint ?? '',
      options.genderHint ?? '',
      options.ageHint ?? ''
    );
  }

  usedReferenceItemIds.add(item.id);
  return item;
}

function mergeStoryboardReferenceAssetReviewItems(
  payload: StoryboardReferenceAssetReviewPayload,
  referenceLibrary: ProjectReferenceLibrary,
  settings: ProjectSettings
): {
  referenceLibrary: ProjectReferenceLibrary;
  tempSelectionIdMap: Map<string, string>;
  addedCharacterCount: number;
  addedSceneCount: number;
  addedObjectCount: number;
} {
  const mergedReferenceLibrary = cloneProjectReferenceLibrary(referenceLibrary);
  const tempSelectionIdMap = new Map<string, string>();
  const usedReferenceItemIds = new Set(
    [
      ...mergedReferenceLibrary.characters,
      ...mergedReferenceLibrary.scenes,
      ...mergedReferenceLibrary.objects
    ].map((item) => item.id)
  );
  const characterIdentityMap = buildReferenceAssetIdentityMap(mergedReferenceLibrary, 'character');
  const sceneIdentityMap = buildReferenceAssetIdentityMap(mergedReferenceLibrary, 'scene');
  const objectIdentityMap = buildReferenceAssetIdentityMap(mergedReferenceLibrary, 'object');
  let addedCharacterCount = 0;
  let addedSceneCount = 0;
  let addedObjectCount = 0;

  for (const [index, item] of (payload.newAssets?.characters ?? []).entries()) {
    const tempId = normalizeString(item.tempId, `new-character-${index + 1}`);
    const name = normalizeString(item.name, `新增角色${index + 1}`);
    const summary = normalizeString(item.summary, '新增角色资产');
    const generationPrompt = normalizeString(
      item.generationPrompt,
      `${settings.visualStyle}，${name}，人物外观与服装特征稳定设定`
    );
    const identityKey = normalizeReferenceAssetReviewIdentityText(name);
    const reusedItem = identityKey ? characterIdentityMap.get(identityKey) : undefined;

    if (reusedItem) {
      registerStoryboardReviewTempSelectionId(
        tempSelectionIdMap,
        'character',
        tempId,
        buildStoryboardReferenceSelectionId('character', reusedItem.id)
      );
      continue;
    }

    const createdItem = createUniqueReferenceAssetItem(
      'character',
      name,
      summary,
      generationPrompt,
      mergedReferenceLibrary,
      usedReferenceItemIds,
      {
        ethnicityHint: normalizeOptionalString(item.ethnicityHint),
        genderHint: normalizeOptionalString(item.genderHint),
        ageHint: normalizeOptionalString(item.ageHint)
      }
    );
    mergedReferenceLibrary.characters.push(createdItem);
    if (identityKey) {
      characterIdentityMap.set(identityKey, createdItem);
    }
    registerStoryboardReviewTempSelectionId(
      tempSelectionIdMap,
      'character',
      tempId,
      buildStoryboardReferenceSelectionId('character', createdItem.id)
    );
    addedCharacterCount += 1;
  }

  for (const [index, item] of (payload.newAssets?.scenes ?? []).entries()) {
    const tempId = normalizeString(item.tempId, `new-scene-${index + 1}`);
    const name = normalizeString(item.name, `新增场景${index + 1}`);
    const summary = normalizeString(item.summary, '新增场景资产');
    const generationPrompt = normalizeSceneReferencePrompt(item.generationPrompt, settings, name);
    const identityKey = normalizeReferenceAssetReviewIdentityText(name);
    const reusedItem = identityKey ? sceneIdentityMap.get(identityKey) : undefined;

    if (reusedItem) {
      registerStoryboardReviewTempSelectionId(
        tempSelectionIdMap,
        'scene',
        tempId,
        buildStoryboardReferenceSelectionId('scene', reusedItem.id)
      );
      continue;
    }

    const createdItem = createUniqueReferenceAssetItem(
      'scene',
      name,
      summary,
      generationPrompt,
      mergedReferenceLibrary,
      usedReferenceItemIds
    );
    mergedReferenceLibrary.scenes.push(createdItem);
    if (identityKey) {
      sceneIdentityMap.set(identityKey, createdItem);
    }
    registerStoryboardReviewTempSelectionId(
      tempSelectionIdMap,
      'scene',
      tempId,
      buildStoryboardReferenceSelectionId('scene', createdItem.id)
    );
    addedSceneCount += 1;
  }

  for (const [index, item] of (payload.newAssets?.objects ?? []).entries()) {
    const tempId = normalizeString(item.tempId, `new-object-${index + 1}`);
    const name = normalizeString(item.name, `新增物品${index + 1}`);
    const summary = normalizeString(item.summary, '新增物品资产');
    const generationPrompt = normalizeString(item.generationPrompt, `${settings.visualStyle}，${name}，关键道具特写`);
    const identityKey = normalizeReferenceAssetReviewIdentityText(name);
    const reusedItem = identityKey ? objectIdentityMap.get(identityKey) : undefined;

    if (reusedItem) {
      registerStoryboardReviewTempSelectionId(
        tempSelectionIdMap,
        'object',
        tempId,
        buildStoryboardReferenceSelectionId('object', reusedItem.id)
      );
      continue;
    }

    const createdItem = createUniqueReferenceAssetItem(
      'object',
      name,
      summary,
      generationPrompt,
      mergedReferenceLibrary,
      usedReferenceItemIds
    );
    mergedReferenceLibrary.objects.push(createdItem);
    if (identityKey) {
      objectIdentityMap.set(identityKey, createdItem);
    }
    registerStoryboardReviewTempSelectionId(
      tempSelectionIdMap,
      'object',
      tempId,
      buildStoryboardReferenceSelectionId('object', createdItem.id)
    );
    addedObjectCount += 1;
  }

  return {
    referenceLibrary: mergedReferenceLibrary,
    tempSelectionIdMap,
    addedCharacterCount,
    addedSceneCount,
    addedObjectCount
  };
}

function registerStoryboardReviewTempSelectionId(
  tempSelectionIdMap: Map<string, string>,
  kind: ReferenceAssetKind,
  tempId: string,
  selectionId: string
): void {
  tempSelectionIdMap.set(tempId, selectionId);
  tempSelectionIdMap.set(buildStoryboardReferenceSelectionId(kind, tempId), selectionId);
}

function resolveStoryboardReferenceAssetReviewSelectionIds(
  value: unknown,
  availableSelectionIds: Set<string>,
  selectionIdByItemId: Map<string, string>,
  tempSelectionIdMap: Map<string, string>
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const resolved = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (availableSelectionIds.has(item)) {
        return item;
      }

      return tempSelectionIdMap.get(item) ?? selectionIdByItemId.get(item) ?? '';
    })
    .filter(Boolean);

  return [...new Set(resolved)];
}

function applyStoryboardReferenceAssetReviewAssignments(
  script: ScriptPackage,
  storyboard: StoryboardShot[],
  referenceLibrary: ProjectReferenceLibrary,
  payload: StoryboardReferenceAssetReviewPayload,
  tempSelectionIdMap: Map<string, string>
): {
  storyboard: StoryboardShot[];
  reassignedShotCount: number;
} {
  const assignmentMap = new Map<string, StoryboardReferenceAssetReviewShotAssignmentPayload>();
  for (const assignment of payload.shotAssignments ?? []) {
    const sceneNumber = normalizePositiveInteger(assignment.sceneNumber, 0);
    const shotNumber = normalizePositiveInteger(assignment.shotNumber, 0);
    if (sceneNumber > 0 && shotNumber > 0) {
      assignmentMap.set(`${sceneNumber}:${shotNumber}`, assignment);
    }
  }

  const { availableSelectionIds, selectionIdByItemId } = buildReferenceAssetSelectionIndex(referenceLibrary);
  let reassignedShotCount = 0;

  const updatedStoryboard = storyboard.map((shot) => {
    const assignment = assignmentMap.get(`${shot.sceneNumber}:${shot.shotNumber}`);
    const nextReferenceAssetIds = resolveStoryboardReferenceAssetReviewSelectionIds(
      assignment?.referenceAssetIds ?? shot.referenceAssetIds,
      availableSelectionIds,
      selectionIdByItemId,
      tempSelectionIdMap
    );
    const nextShot = applyStoryboardReferenceAssetFallback(
      {
        ...shot,
        referenceAssetIds: nextReferenceAssetIds
      },
      script,
      referenceLibrary
    );

    if (nextShot.referenceAssetIds.join('|') !== shot.referenceAssetIds.join('|')) {
      reassignedShotCount += 1;
    }

    return nextShot;
  });

  return {
    storyboard: updatedStoryboard,
    reassignedShotCount
  };
}

export async function reviewStoryboardReferenceAssets(
  script: ScriptPackage,
  storyboard: StoryboardShot[],
  referenceLibrary: ProjectReferenceLibrary,
  settings: ProjectSettings,
  options?: {
    signal?: AbortSignal;
  }
): Promise<StoryboardReferenceAssetReviewResult> {
  if (!storyboard.length) {
    return {
      storyboard,
      referenceLibrary,
      addedReferenceAssetCount: 0,
      addedCharacterCount: 0,
      addedSceneCount: 0,
      addedObjectCount: 0,
      reassignedShotCount: 0
    };
  }

  let retryFeedback = '';
  let fallbackResult: StoryboardReferenceAssetReviewResult | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = await requestJson<StoryboardReferenceAssetReviewPayload>(
      [
        {
          role: 'system',
          content:
            '你是一名影视资产统筹、美术设定导演和分镜连续性审核员。请通看全量分镜和现有资产库，决定每个镜头该复用哪些资产、该补哪些新资产，让资产库更丰富、更分层、更能支撑镜头变化，同时避免同义重复资产。只输出 JSON，不要输出任何额外说明。'
        },
        {
          role: 'user',
          content: buildStoryboardReferenceAssetReviewPrompt(script, settings, storyboard, referenceLibrary, retryFeedback)
        }
      ],
      {
        temperature: attempt === 0 ? 0.35 : 0.25,
        maxTokens: getStoryboardReferenceAssetReviewMaxTokens(storyboard),
        signal: options?.signal
      }
    );
    const mergeResult = mergeStoryboardReferenceAssetReviewItems(payload, referenceLibrary, settings);
    const assignmentResult = applyStoryboardReferenceAssetReviewAssignments(
      script,
      storyboard,
      mergeResult.referenceLibrary,
      payload,
      mergeResult.tempSelectionIdMap
    );
    const result = {
      storyboard: assignmentResult.storyboard,
      referenceLibrary: mergeResult.referenceLibrary,
      addedReferenceAssetCount:
        mergeResult.addedCharacterCount + mergeResult.addedSceneCount + mergeResult.addedObjectCount,
      addedCharacterCount: mergeResult.addedCharacterCount,
      addedSceneCount: mergeResult.addedSceneCount,
      addedObjectCount: mergeResult.addedObjectCount,
      reassignedShotCount: assignmentResult.reassignedShotCount
    } satisfies StoryboardReferenceAssetReviewResult;
    const sceneCoverageFeedback = buildStoryboardSceneAssetCoverageFeedback(script, result.storyboard);

    fallbackResult = result;
    if (!sceneCoverageFeedback) {
      return result;
    }

    retryFeedback = sceneCoverageFeedback;
  }

  if (fallbackResult) {
    return fallbackResult;
  }

  return {
    storyboard,
    referenceLibrary,
    addedReferenceAssetCount: 0,
    addedCharacterCount: 0,
    addedSceneCount: 0,
    addedObjectCount: 0,
    reassignedShotCount: 0
  };
}
