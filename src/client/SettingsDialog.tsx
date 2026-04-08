import { DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS, WORKFLOW_TEMPLATE_OPTIONS } from '../shared/workflow-templates';
import type {
  AppMeta,
  AppSettings,
  ComfyuiEnvironmentDiscovery,
  ComfyuiRuntimeInfo,
  ComfyWorkflowType
} from '../shared/types';

interface SettingsDialogProps {
  open: boolean;
  draft: AppSettings | null;
  status: AppMeta['envStatus'] | null;
  comfyuiRuntime: ComfyuiRuntimeInfo | null;
  comfyuiDiscovery: ComfyuiEnvironmentDiscovery | null;
  comfyuiDiscoveryPending: boolean;
  dirty: boolean;
  pending: boolean;
  llmModels: string[];
  llmModelsPending: boolean;
  llmModelsError: string;
  onClose: () => void;
  onSave: () => void;
  onRefreshModels: () => void;
  onRefreshComfyuiDiscovery: () => void;
  onChange: (next: AppSettings) => void;
}

function buildComfyuiEnvironmentSelectValue(type: AppSettings['comfyui']['environmentType'], id: string): string {
  return type && id ? `${type}:${id}` : '';
}

function parseComfyuiEnvironmentSelectValue(value: string): {
  environmentType: AppSettings['comfyui']['environmentType'];
  environmentId: string;
} {
  const separatorIndex = value.indexOf(':');

  if (separatorIndex <= 0) {
    return {
      environmentType: '',
      environmentId: ''
    };
  }

  const environmentType = value.slice(0, separatorIndex);
  const environmentId = value.slice(separatorIndex + 1);

  return {
    environmentType: environmentType === 'venv' || environmentType === 'conda' ? environmentType : '',
    environmentId
  };
}

function formatComfyuiRuntimeStatus(runtime: ComfyuiRuntimeInfo | null): string {
  if (!runtime) {
    return '未检测';
  }

  if (!runtime.supported) {
    return '当前仅支持 Linux';
  }

  if (!runtime.autoStartEnabled) {
    return '已关闭自动启动';
  }

  if (!runtime.launchConfigured) {
    return '待补全启动配置';
  }

  if (runtime.status === 'running') {
    return runtime.pid ? `运行中 · PID ${runtime.pid}` : '运行中';
  }

  if (runtime.status === 'starting') {
    return '启动中';
  }

  if (runtime.status === 'error') {
    return '启动失败';
  }

  return '未启动';
}

function runtimePillClassName(runtime: ComfyuiRuntimeInfo | null): string {
  if (!runtime) {
    return 'pill';
  }

  if (runtime.status === 'running') {
    return 'pill success';
  }

  if (runtime.status === 'starting') {
    return 'pill running';
  }

  if (runtime.status === 'error') {
    return 'pill error';
  }

  return 'pill';
}

export function SettingsDialog(props: SettingsDialogProps) {
  const {
    open,
    draft,
    status,
    comfyuiRuntime,
    comfyuiDiscovery,
    comfyuiDiscoveryPending,
    dirty,
    pending,
    llmModels,
    llmModelsPending,
    llmModelsError,
    onClose,
    onSave,
    onRefreshModels,
    onRefreshComfyuiDiscovery,
    onChange
  } = props;

  if (!open || !draft) {
    return null;
  }

  const workflowStatusMap = {
    character_asset: status?.characterAssetWorkflowExists ?? false,
    storyboard_image: status?.storyboardImageWorkflowExists ?? false,
    text_to_image: status?.textToImageWorkflowExists ?? false,
    reference_image_to_image: status?.referenceImageToImageWorkflowExists ?? false,
    image_edit: status?.imageEditWorkflowExists ?? false,
    text_to_video: status?.textToVideoWorkflowExists ?? false,
    image_to_video_first_last: status?.imageToVideoFirstLastWorkflowExists ?? false,
    image_to_video_first_frame: status?.imageToVideoFirstFrameWorkflowExists ?? false,
    tts: status?.ttsWorkflowExists ?? false
  } satisfies Record<ComfyWorkflowType, boolean>;

  const workflowConfigs: Record<
    ComfyWorkflowType,
    {
      label: string;
      description: string;
      purpose: string;
    }
  > = {
    character_asset: {
      label: '人物资产',
      description: '角色参考图 / 人物设定图',
      purpose: '用于角色资产生成，服务角色一致性和后续镜头约束。'
    },
    storyboard_image: {
      label: '参考帧生成',
      description: '镜头起始/结束参考帧',
      purpose: '主参考帧工作流；服务端会自动注入最多 3 张参考图，超过 3 张时分批多轮执行。'
    },
    text_to_image: {
      label: '文生图',
      description: '无参考图图片生成',
      purpose: '用于场景、物品等纯文本生图，也作为参考帧阶段无参考图时的回退。'
    },
    reference_image_to_image: {
      label: '参考图生图',
      description: '参考图约束图片生成',
      purpose: '用于场景、物品等有参考图的资产设定，也保留给旧链路兼容或特定参考图生图需求。'
    },
    image_edit: {
      label: '图片编辑',
      description: '重绘 / 修图 / 图片加工',
      purpose: '用于局部重绘、修图和二次编辑，也可作为参考帧阶段的兼容回退。'
    },
    text_to_video: {
      label: '文生视频',
      description: '无参考帧视频生成',
      purpose: '用于纯文本驱动的视频片段生成，适合没有参考帧约束的场景。'
    },
    image_to_video_first_last: {
      label: '首尾帧视频',
      description: '起始帧 + 结束帧约束视频生成',
      purpose: '用于需要明确收束到目标结尾画面的镜头，服务端会在有结束参考帧时优先调用。'
    },
    image_to_video_first_frame: {
      label: '首帧视频',
      description: '仅起始帧约束视频生成',
      purpose: '用于只提供首帧、不要求尾帧收束的镜头，服务端会在无结束参考帧时优先调用。'
    },
    tts: {
      label: 'TTS 工作流',
      description: '台词 / 旁白 / 配音',
      purpose: '可选；用于对白、旁白或声音生成。不配置时会回退为把声音 prompt 合并到视频 prompt。'
    }
  };

  const workflowGroups: Array<{
    title: string;
    description: string;
    sections: Array<{
      title: string;
      description: string;
      items: ComfyWorkflowType[];
    }>;
  }> = [
    {
      title: '资产设定',
      description: '先区分有无参考图的素材生成链路，供后续分镜和视频复用。',
      sections: [
        {
          title: '有参考设定',
          description: '人物有参考图时走人物资产；场景和物品有参考图时走参考图生图。',
          items: ['character_asset', 'reference_image_to_image']
        },
        {
          title: '无参考设定',
          description: '用于场景、物品等没有参考图的纯文本生图，也作为无参考回退。',
          items: ['text_to_image']
        }
      ]
    },
    {
      title: '参考帧与图片加工',
      description: '围绕镜头静帧、参考图约束和图片二次加工配置主工作流与兼容回退。',
      sections: [
        {
          title: '参考帧生成',
          description: '用于镜头首帧、尾帧的主静帧生成流程。',
          items: ['storyboard_image']
        },
        {
          title: '参考图与图片加工',
          description: '用于图片修补、局部重绘和其他二次加工处理。',
          items: ['image_edit']
        }
      ]
    },
    {
      title: '视频片段生成',
      description: '按使用方式拆成独立子设定项，文生视频、首尾帧视频和首帧视频分别配置。',
      sections: [
        {
          title: '文生视频设定',
          description: '没有参考帧时直接走纯文本视频生成。',
          items: ['text_to_video']
        },
        {
          title: '首尾帧视频设定',
          description: '镜头同时有起始帧和结束帧时使用，用于强化结尾画面收束。',
          items: ['image_to_video_first_last']
        },
        {
          title: '首帧视频设定',
          description: '镜头只有首帧约束时使用，适合不生成尾帧的镜头。',
          items: ['image_to_video_first_frame']
        }
      ]
    },
    {
      title: '声音生成',
      description: '单独管理对白、旁白和声音工作流。',
      sections: [
        {
          title: '语音设定',
          description: '管理对白、旁白和其他声音生成链路。',
          items: ['tts']
        }
      ]
    }
  ];

  const selectedEnvironmentValue = buildComfyuiEnvironmentSelectValue(
    draft.comfyui.environmentType,
    draft.comfyui.environmentId
  );
  const selectedEnvironmentMissing = Boolean(
    selectedEnvironmentValue &&
      comfyuiDiscovery &&
      !comfyuiDiscovery.environments.some(
        (environment) => buildComfyuiEnvironmentSelectValue(environment.type, environment.id) === selectedEnvironmentValue
      )
  );
  const installPathEnvironmentCount =
    comfyuiDiscovery?.environments.filter((environment) => environment.source === 'install_path').length ?? 0;
  const condaEnvironmentCount =
    comfyuiDiscovery?.environments.filter((environment) => environment.source === 'conda').length ?? 0;

  const renderWorkflowCard = (workflowKey: ComfyWorkflowType) => {
    const workflow = workflowConfigs[workflowKey];
    const workflowDraft = draft.comfyui.workflows[workflowKey];
    const exists = workflowStatusMap[workflowKey];
    const templateOptions = WORKFLOW_TEMPLATE_OPTIONS[workflowKey];
    const selectedTemplate =
      templateOptions.find((option) => option.path === workflowDraft.workflowPath) ?? null;
    const inputPlaceholder = DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS[workflowKey];

    return (
      <article key={workflowKey} className="workflow-config-card">
        <div className="workflow-config-head">
          <div>
            <h4>{workflow.label}</h4>
            <p>{workflow.description}</p>
          </div>
          <span className={`pill ${exists ? 'success' : 'error'}`}>{exists ? '已就绪' : '未就绪'}</span>
        </div>
        <p className="workflow-config-purpose">{workflow.purpose}</p>
        <div className="form-grid">
          <label className="field span-2">
            <span>内置模板</span>
            <select
              value={selectedTemplate?.path ?? ''}
              onChange={(event) =>
                updateWorkflow(workflowKey, {
                  workflowPath: event.target.value
                })
              }
            >
              <option value="">自定义路径 / 手动填写</option>
              {templateOptions.map((option) => (
                <option key={option.path} value={option.path}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="inline-note">
              {selectedTemplate
                ? selectedTemplate.description
                : '选择内置模板后会自动填入下方路径，也可以继续手动改成任意 JSON 文件。'}
            </div>
          </label>
          <label className="field span-2">
            <span>工作流 JSON 路径</span>
            <input
              list={`workflow-template-options-${workflowKey}`}
              value={workflowDraft.workflowPath}
              onChange={(event) =>
                updateWorkflow(workflowKey, {
                  workflowPath: event.target.value
                })
              }
              placeholder={inputPlaceholder}
            />
            <datalist id={`workflow-template-options-${workflowKey}`}>
              {templateOptions.map((option) => (
                <option key={option.path} value={option.path}>
                  {option.label}
                </option>
              ))}
            </datalist>
          </label>
        </div>
        <p className="settings-hint workflow-config-note">
          {workflowDraft.workflowPath
            ? exists
              ? '工作流文件已通过基础检查。'
              : '已填写路径，但当前文件不存在、无法访问，或仍是占位模板。'
            : '尚未配置工作流文件。'}
        </p>
      </article>
    );
  };

  const updateWorkflow = (
    workflow: ComfyWorkflowType,
    patch: Partial<AppSettings['comfyui']['workflows'][ComfyWorkflowType]>
  ) => {
    onChange({
      ...draft,
      comfyui: {
        ...draft.comfyui,
        workflows: {
          ...draft.comfyui.workflows,
          [workflow]: {
            ...draft.comfyui.workflows[workflow],
            ...patch
          }
        }
      }
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel panel"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">System Settings</span>
            <h2>系统设置</h2>
            <p>这里配置全局 LLM API、Gemini API、ComfyUI API 和本地 FFmpeg，保存后新任务立即生效。</p>
          </div>
          <button className="button ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="status-strip modal-status">
          <div className="status-item">
            <span>LLM API</span>
            <strong>{status?.llmConfigured ? '已配置' : '未配置'}</strong>
          </div>
          <div className="status-item">
            <span>Gemini API</span>
            <strong>{status?.geminiConfigured ? '已配置' : '未配置'}</strong>
          </div>
          <div className="status-item">
            <span>ComfyUI</span>
            <strong>{status?.comfyuiConfigured ? '已配置' : '未配置'}</strong>
          </div>
          <div className="status-item">
            <span>FFmpeg</span>
            <strong>{status?.ffmpegReady ? '可用' : '缺失'}</strong>
          </div>
        </div>

        <section className="settings-section">
          <div className="section-head">
            <h3>LLM API</h3>
            <div className="section-side">
              <span>兼容 OpenAI Chat Completions 的接口</span>
              <button className="button ghost mini-button" onClick={onRefreshModels} type="button">
                重新获取模型
              </button>
            </div>
          </div>
          <div className="form-grid">
            <label className="field span-2">
              <span>Base URL</span>
              <input
                value={draft.llm.baseUrl}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    llm: {
                      ...draft.llm,
                      baseUrl: event.target.value
                    }
                  })
                }
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label className="field span-2">
              <span>API Key</span>
              <input
                type="password"
                value={draft.llm.apiKey}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    llm: {
                      ...draft.llm,
                      apiKey: event.target.value
                    }
                  })
                }
                placeholder="sk-..."
              />
            </label>
            <label className="field span-2">
              <span>模型名</span>
              <input
                list="llm-model-options"
                value={draft.llm.model}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    llm: {
                      ...draft.llm,
                      model: event.target.value
                    }
                  })
                }
                placeholder="gpt-4o-mini"
              />
              <datalist id="llm-model-options">
                {llmModels.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <div className="inline-note">
                {llmModelsPending ? '正在自动获取可用模型...' : null}
                {!llmModelsPending && llmModels.length ? `已发现 ${llmModels.length} 个模型` : null}
                {!llmModelsPending && !llmModels.length && !llmModelsError
                  ? '输入 Base URL 和 API Key 后会自动获取模型列表'
                  : null}
                {!llmModelsPending && llmModelsError ? llmModelsError : null}
              </div>
            </label>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-head">
            <h3>Gemini API</h3>
            <span>用于项目级 Gemini 图片生成；推荐填写兼容 `generateContent` 的接口根地址</span>
          </div>
          <div className="form-grid">
            <label className="field span-2">
              <span>Base URL</span>
              <input
                value={draft.gemini.baseUrl}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    gemini: {
                      ...draft.gemini,
                      baseUrl: event.target.value
                    }
                  })
                }
                placeholder="https://generativelanguage.googleapis.com/v1beta"
              />
            </label>
            <label className="field span-2">
              <span>API Key</span>
              <input
                type="password"
                value={draft.gemini.apiKey}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    gemini: {
                      ...draft.gemini,
                      apiKey: event.target.value
                    }
                  })
                }
                placeholder="AIza..."
              />
            </label>
          </div>
          <p className="settings-hint">
            项目设置选择 Gemini 后，资产图和镜头首/尾参考帧会走这里配置的接口；视频生成仍然使用 ComfyUI。
          </p>
        </section>

        <section className="settings-section">
          <div className="section-head">
            <h3>ComfyUI</h3>
            <div className="section-side">
              <span>Linux 下可自动进入所选环境并运行 ComfyUI 根目录中的 `main.py`</span>
              <span className={runtimePillClassName(comfyuiRuntime)}>{formatComfyuiRuntimeStatus(comfyuiRuntime)}</span>
            </div>
          </div>
          <div className="form-grid">
            <label className="field span-2">
              <span>ComfyUI 地址</span>
              <input
                value={draft.comfyui.baseUrl}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      baseUrl: event.target.value
                    }
                  })
                }
                placeholder="http://127.0.0.1:8188"
              />
              <div className="inline-note">自动启动时会按这里的地址解析端口，并用它来探测服务是否已就绪。</div>
            </label>
            <label className="field span-2">
              <span>ComfyUI 根路径</span>
              <input
                value={draft.comfyui.installPath}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      installPath: event.target.value
                    }
                  })
                }
                placeholder="/absolute/path/to/ComfyUI"
              />
              <div className="inline-note">
                {comfyuiDiscoveryPending
                  ? '正在探测路径内虚拟环境和系统 Conda 环境...'
                  : draft.comfyui.installPath.trim()
                    ? [
                        comfyuiDiscovery?.installPathExists ? '路径可访问' : '路径不可访问',
                        comfyuiDiscovery?.mainPyExists ? '已找到 main.py' : '未找到 main.py',
                        installPathEnvironmentCount ? `路径内环境 ${installPathEnvironmentCount} 个` : '路径内未发现虚拟环境',
                        condaEnvironmentCount ? `Conda 环境 ${condaEnvironmentCount} 个` : '未发现 Conda 环境'
                      ].join(' · ')
                    : '填写 ComfyUI 根路径后会自动探测可用环境。'}
              </div>
            </label>
            <label className="field span-2">
              <span>启动环境</span>
              <div className="section-side">
                <select
                  value={selectedEnvironmentValue}
                  onChange={(event) => {
                    const nextEnvironment = parseComfyuiEnvironmentSelectValue(event.target.value);
                    onChange({
                      ...draft,
                      comfyui: {
                        ...draft.comfyui,
                        environmentType: nextEnvironment.environmentType,
                        environmentId: nextEnvironment.environmentId
                      }
                    });
                  }}
                >
                  <option value="">请选择自动探测到的环境</option>
                  {comfyuiDiscovery?.environments.map((environment) => (
                    <option
                      key={buildComfyuiEnvironmentSelectValue(environment.type, environment.id)}
                      value={buildComfyuiEnvironmentSelectValue(environment.type, environment.id)}
                    >
                      [{environment.type === 'venv' ? '路径内环境' : 'Conda'}] {environment.label}
                    </option>
                  ))}
                </select>
                <button className="button ghost mini-button" onClick={onRefreshComfyuiDiscovery} type="button">
                  重新探测
                </button>
              </div>
              <div className="inline-note">
                {selectedEnvironmentMissing
                  ? '当前已保存的环境不在最新探测结果中，请重新选择。'
                  : draft.comfyui.environmentType && draft.comfyui.environmentId
                    ? '已选择启动环境，保存后会用该环境运行 main.py。'
                    : '可从 ComfyUI 路径内虚拟环境或系统 Conda 环境中选择。'}
              </div>
            </label>
            <div className="span-2">
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={draft.comfyui.autoStart}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      comfyui: {
                        ...draft.comfyui,
                        autoStart: event.target.checked
                      }
                    })
                  }
                />
                <span>保存后自动启动并托管本地 ComfyUI（仅 Linux 生效）</span>
              </label>
              <div className="inline-note">
                关闭后系统只会调用你填写的 ComfyUI 地址，不会尝试启动本地进程。
              </div>
            </div>
            <label className="field">
              <span>轮询间隔 ms</span>
              <input
                type="number"
                value={draft.comfyui.pollIntervalMs}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      pollIntervalMs: Number(event.target.value) || draft.comfyui.pollIntervalMs
                    }
                  })
                }
              />
            </label>
            <label className="field">
              <span>超时时间 ms</span>
              <input
                type="number"
                value={draft.comfyui.timeoutMs}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      timeoutMs: Number(event.target.value) || draft.comfyui.timeoutMs
                    }
                  })
                }
              />
            </label>
            <label className="field">
              <span>镜头视频最长秒数</span>
              <input
                type="number"
                value={draft.comfyui.maxVideoSegmentDurationSeconds}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      maxVideoSegmentDurationSeconds:
                        Number(event.target.value) || draft.comfyui.maxVideoSegmentDurationSeconds
                    }
                  })
                }
              />
            </label>
          </div>
          {comfyuiDiscovery?.errors.length ? (
            <p className="settings-hint">{comfyuiDiscovery.errors.join(' ')}</p>
          ) : null}
          {comfyuiRuntime?.lastError ? <p className="settings-hint">{comfyuiRuntime.lastError}</p> : null}
          <p className="settings-hint">统一地址，按主分类和子设定项分别绑定工作流；工作流内自行固定 checkpoint。</p>
          <div className="workflow-group-list">
            {workflowGroups.map((group) => (
              <section key={group.title} className="workflow-group">
                <div className="workflow-group-head">
                  <h4>{group.title}</h4>
                  <p>{group.description}</p>
                </div>
                <div className="workflow-subgroup-list">
                  {group.sections.map((section) => (
                    <section key={`${group.title}-${section.title}`} className="workflow-subgroup">
                      <div className="workflow-subgroup-head">
                        <h5>{section.title}</h5>
                        <p>{section.description}</p>
                      </div>
                      <div className="workflow-config-grid">
                        {section.items.map((workflowKey) => renderWorkflowCard(workflowKey))}
                      </div>
                    </section>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="section-head">
            <h3>FFmpeg</h3>
            <span>留空则使用环境变量或 `ffmpeg-static`</span>
          </div>
          <div className="form-grid">
            <label className="field span-2">
              <span>FFmpeg 可执行文件路径</span>
              <input
                value={draft.ffmpeg.binaryPath}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    ffmpeg: {
                      binaryPath: event.target.value
                    }
                  })
                }
                placeholder="/absolute/path/to/ffmpeg"
              />
            </label>
          </div>
          <p className="settings-hint">
            设置会保存在本地 `.shortdrama-generator.settings.json`，用于 UI 运行期读取，不会提交到仓库。
          </p>
        </section>

        <div className="modal-actions">
          <span className="settings-dirty">{dirty ? '有未保存修改' : '设置已同步'}</span>
          <div className="modal-buttons">
            <button className="button ghost" onClick={onClose}>
              取消
            </button>
            <button className="button primary" disabled={pending} onClick={onSave}>
              {pending ? '保存中...' : '保存设置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
