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
    character: status?.characterWorkflowExists ?? false,
    scene: status?.sceneWorkflowExists ?? false,
    object: status?.objectWorkflowExists ?? false,
    video: status?.videoWorkflowExists ?? false,
    storyboard: status?.storyboardWorkflowExists ?? false,
    tts: status?.ttsWorkflowExists ?? false
  } satisfies Record<ComfyWorkflowType, boolean>;

  const workflowConfigs: Array<{
    key: ComfyWorkflowType;
    label: string;
    description: string;
    workflowPlaceholder: string;
    checkpointPlaceholder: string;
  }> = [
    {
      key: 'character',
      label: '人物资产生成',
      description: '用于角色参考图生成',
      workflowPlaceholder: '/absolute/path/to/character-workflow.json',
      checkpointPlaceholder: 'character-model.safetensors'
    },
    {
      key: 'scene',
      label: '场景资产生成',
      description: '用于场景参考图生成',
      workflowPlaceholder: '/absolute/path/to/scene-workflow.json',
      checkpointPlaceholder: 'scene-model.safetensors'
    },
    {
      key: 'object',
      label: '物品资产生成',
      description: '用于物品参考图生成',
      workflowPlaceholder: '/absolute/path/to/object-workflow.json',
      checkpointPlaceholder: 'object-model.safetensors'
    },
    {
      key: 'video',
      label: '视频生成',
      description: '用于基于首帧图生成视频片段',
      workflowPlaceholder: '/absolute/path/to/video-workflow.json',
      checkpointPlaceholder: 'video-model.safetensors'
    },
    {
      key: 'storyboard',
      label: '分镜图片生成',
      description: '用于分镜阶段首帧图生成',
      workflowPlaceholder: '/absolute/path/to/storyboard-workflow.json',
      checkpointPlaceholder: 'storyboard-model.safetensors'
    },
    {
      key: 'tts',
      label: 'TTS / 声音生成',
      description: '可选；用于台词、旁白或声音生成。不配置时会回退为把声音 prompt 合并到视频 prompt',
      workflowPlaceholder: '/absolute/path/to/tts-workflow.json',
      checkpointPlaceholder: 'tts-model.safetensors'
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
            <span>统一地址，六类任务分别绑定各自工作流和检查点，其中 TTS 为可选项</span>
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
                    <label className="field span-2">
                      <span>检查点名称</span>
                      <input
                        value={workflowDraft.checkpointName}
                        onChange={(event) =>
                          updateWorkflow(workflow.key, {
                            checkpointName: event.target.value
                          })
                        }
                        placeholder={workflow.checkpointPlaceholder}
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
