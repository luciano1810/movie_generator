import type { AppMeta, AppSettings } from '../shared/types';

interface SettingsDialogProps {
  open: boolean;
  draft: AppSettings | null;
  status: AppMeta['envStatus'] | null;
  dirty: boolean;
  pending: boolean;
  onClose: () => void;
  onSave: () => void;
  onChange: (next: AppSettings) => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { open, draft, status, dirty, pending, onClose, onSave, onChange } = props;

  if (!open || !draft) {
    return null;
  }

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
            <span>兼容 OpenAI Chat Completions 的接口</span>
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
            </label>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-head">
            <h3>ComfyUI API</h3>
            <span>本地工作流、检查点和轮询参数</span>
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
            <label className="field span-2">
              <span>图片工作流 JSON 路径</span>
              <input
                value={draft.comfyui.imageWorkflowPath}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      imageWorkflowPath: event.target.value
                    }
                  })
                }
                placeholder="/absolute/path/to/image-workflow.json"
              />
            </label>
            <label className="field span-2">
              <span>视频工作流 JSON 路径</span>
              <input
                value={draft.comfyui.videoWorkflowPath}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      videoWorkflowPath: event.target.value
                    }
                  })
                }
                placeholder="/absolute/path/to/video-workflow.json"
              />
            </label>
            <label className="field">
              <span>图片检查点</span>
              <input
                value={draft.comfyui.imageCheckpointName}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      imageCheckpointName: event.target.value
                    }
                  })
                }
                placeholder="sdxl.safetensors"
              />
            </label>
            <label className="field">
              <span>视频检查点</span>
              <input
                value={draft.comfyui.videoCheckpointName}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    comfyui: {
                      ...draft.comfyui,
                      videoCheckpointName: event.target.value
                    }
                  })
                }
                placeholder="wan2_1.safetensors"
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
