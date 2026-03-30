import type { AppMeta, AppSettings, ComfyWorkflowType } from '../shared/types';

interface SettingsDialogProps {
  open: boolean;
  draft: AppSettings | null;
  status: AppMeta['envStatus'] | null;
  dirty: boolean;
  pending: boolean;
  llmModels: string[];
  llmModelsPending: boolean;
  llmModelsError: string;
  onClose: () => void;
  onSave: () => void;
  onRefreshModels: () => void;
  onChange: (next: AppSettings) => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const {
    open,
    draft,
    status,
    dirty,
    pending,
    llmModels,
    llmModelsPending,
    llmModelsError,
    onClose,
    onSave,
    onRefreshModels,
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
    image_to_video: status?.imageToVideoWorkflowExists ?? false,
    tts: status?.ttsWorkflowExists ?? false
  } satisfies Record<ComfyWorkflowType, boolean>;

  const workflowConfigs: Array<{
    key: ComfyWorkflowType;
    label: string;
    description: string;
    workflowPlaceholder: string;
  }> = [
    {
      key: 'character_asset',
      label: '人物资产',
      description: '用于角色参考图生成',
      workflowPlaceholder: '/absolute/path/to/character-asset-workflow.json'
    },
    {
      key: 'storyboard_image',
      label: '参考帧生成',
      description: '用于镜头参考帧生成；服务端会自动注入最多 3 张参考图，超过 3 张时分批多轮执行',
      workflowPlaceholder: '/absolute/path/to/storyboard-image-workflow.json'
    },
    {
      key: 'text_to_image',
      label: '文生图',
      description: '用于纯文本驱动的图片生成，比如场景或物品资产',
      workflowPlaceholder: '/absolute/path/to/text-to-image-workflow.json'
    },
    {
      key: 'reference_image_to_image',
      label: '参考图生图',
      description: '用于带参考资产约束的参考帧图片生成',
      workflowPlaceholder: '/absolute/path/to/reference-image-to-image-workflow.json'
    },
    {
      key: 'image_edit',
      label: '图片编辑',
      description: '用于局部重绘、修图或后续图片编辑流程',
      workflowPlaceholder: '/absolute/path/to/image-edit-workflow.json'
    },
    {
      key: 'text_to_video',
      label: '文生视频',
      description: '用于纯文本驱动的视频生成',
      workflowPlaceholder: '/absolute/path/to/text-to-video-workflow.json'
    },
    {
      key: 'image_to_video',
      label: '图生视频',
      description: '用于基于参考帧或参考图生成视频片段',
      workflowPlaceholder: '/absolute/path/to/image-to-video-workflow.json'
    },
    {
      key: 'tts',
      label: 'TTS 工作流',
      description: '可选；用于台词、旁白或声音生成。不配置时会回退为把声音 prompt 合并到视频 prompt',
      workflowPlaceholder: '/absolute/path/to/tts-workflow.json'
    }
  ];

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
            <p>这里配置全局 LLM API、ComfyUI API 和本地 FFmpeg，保存后新任务立即生效。</p>
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
            <h3>ComfyUI API</h3>
            <span>统一地址，七类任务分别绑定各自工作流；工作流内自行固定 checkpoint</span>
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
            </label>
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
          <div className="workflow-config-grid">
            {workflowConfigs.map((workflow) => {
              const workflowDraft = draft.comfyui.workflows[workflow.key];
              const exists = workflowStatusMap[workflow.key];

              return (
                <article key={workflow.key} className="workflow-config-card">
                  <div className="workflow-config-head">
                    <div>
                      <h4>{workflow.label}</h4>
                      <p>{workflow.description}</p>
                    </div>
                    <span className={`pill ${exists ? 'success' : 'error'}`}>{exists ? '已就绪' : '未就绪'}</span>
                  </div>
                  <div className="form-grid">
                    <label className="field span-2">
                      <span>工作流 JSON 路径</span>
                      <input
                        value={workflowDraft.workflowPath}
                        onChange={(event) =>
                          updateWorkflow(workflow.key, {
                            workflowPath: event.target.value
                          })
                        }
                        placeholder={workflow.workflowPlaceholder}
                      />
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
            })}
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
