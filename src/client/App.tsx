import { useEffect, useState } from 'react';
import type { AppMeta, AppSettings, Project, ProjectSettings, RunStage, StageId } from '../shared/types';
import { STAGES, STAGE_LABELS } from '../shared/types';
import { SettingsDialog } from './SettingsDialog';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

interface ProjectDraft {
  title: string;
  sourceText: string;
  settings: ProjectSettings;
}

function apiPath(pathname: string): string {
  return API_BASE ? `${API_BASE}${pathname}` : pathname;
}

function assetUrl(relativePath: string): string {
  return apiPath(`/storage/${relativePath}`);
}

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(pathname), {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const message = await response
      .json()
      .then((payload) => payload?.message as string | undefined)
      .catch(() => undefined);
    throw new Error(message ?? `请求失败: ${response.status}`);
  }

  return (await response.json()) as T;
}

function createDraft(project: Project): ProjectDraft {
  return {
    title: project.title,
    sourceText: project.sourceText,
    settings: { ...project.settings }
  };
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) {
    return '-';
  }

  return new Date(iso).toLocaleString('zh-CN', {
    hour12: false
  });
}

function statusLabel(status: Project['stages'][StageId]['status']): string {
  if (status === 'idle') {
    return '未执行';
  }
  if (status === 'running') {
    return '执行中';
  }
  if (status === 'success') {
    return '成功';
  }
  return '失败';
}

export function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createSource, setCreateSource] = useState('');
  const [notice, setNotice] = useState<string>('');
  const [pending, setPending] = useState<string>('');

  async function loadMeta() {
    setMeta(await requestJson<AppMeta>('/api/meta'));
  }

  async function loadAppSettings() {
    const nextSettings = await requestJson<AppSettings>('/api/app-settings');
    setAppSettings(nextSettings);
    setSettingsDraft(nextSettings);
    setSettingsDirty(false);
  }

  async function loadProjects(preferredId?: string) {
    const nextProjects = await requestJson<Project[]>('/api/projects');
    setProjects(nextProjects);

    const nextSelectedId = preferredId ?? selectedId;
    if (!nextProjects.length) {
      setSelectedId(null);
      setProject(null);
      setDraft(null);
      return;
    }

    if (!nextSelectedId || !nextProjects.some((item) => item.id === nextSelectedId)) {
      setSelectedId(nextProjects[0].id);
    }
  }

  async function loadProject(projectId: string, silent = false, preserveDraft = false) {
    try {
      const nextProject = await requestJson<Project>(`/api/projects/${projectId}`);
      setProject(nextProject);
      setDraft((current) => {
        if (preserveDraft && current) {
          return current;
        }

        return createDraft(nextProject);
      });
      if (!preserveDraft) {
        setDraftDirty(false);
      }
    } catch (error) {
      if (!silent) {
        setNotice(error instanceof Error ? error.message : '加载项目失败');
      }
    }
  }

  useEffect(() => {
    void Promise.all([loadMeta(), loadProjects(), loadAppSettings()]);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    void loadProject(selectedId, false, false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProjects(selectedId);
      void loadProject(selectedId, true, draftDirty);
    }, 3000);

    return () => window.clearInterval(timer);
  }, [draftDirty, selectedId]);

  async function handleCreateProject() {
    try {
      setPending('create');
      const created = await requestJson<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          title: createTitle,
          sourceText: createSource
        })
      });

      setCreateTitle('');
      setCreateSource('');
      setNotice('项目已创建');
      await loadProjects(created.id);
      setSelectedId(created.id);
      setProject(created);
      setDraft(createDraft(created));
      setDraftDirty(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建项目失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveProject() {
    if (!selectedId || !draft) {
      return;
    }

    try {
      setPending('save');
      const updated = await requestJson<Project>(`/api/projects/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify(draft)
      });

      setProject(updated);
      setDraft(createDraft(updated));
      setDraftDirty(false);
      setNotice('项目参数已保存');
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setPending('');
    }
  }

  async function handleRunStage(stage: RunStage) {
    if (!selectedId) {
      return;
    }

    try {
      setPending(stage);
      await requestJson<{ ok: true }>(`/api/projects/${selectedId}/run`, {
        method: 'POST',
        body: JSON.stringify({ stage })
      });
      setNotice(stage === 'all' ? '已提交全流程任务' : `已提交 ${STAGE_LABELS[stage as StageId]} 任务`);
      await loadProject(selectedId, true, true);
      await loadProjects(selectedId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '执行失败');
    } finally {
      setPending('');
    }
  }

  async function handleSaveAppSettings() {
    if (!settingsDraft) {
      return;
    }

    try {
      setSettingsPending(true);
      const nextSettings = await requestJson<AppSettings>('/api/app-settings', {
        method: 'PUT',
        body: JSON.stringify(settingsDraft)
      });
      setAppSettings(nextSettings);
      setSettingsDraft(nextSettings);
      setSettingsDirty(false);
      setNotice('系统设置已保存');
      await loadMeta();
      setSettingsOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '系统设置保存失败');
    } finally {
      setSettingsPending(false);
    }
  }

  const imageMap = new Map(project?.assets.images.map((asset) => [asset.shotId, asset]) ?? []);
  const videoMap = new Map(project?.assets.videos.map((asset) => [asset.shotId, asset]) ?? []);

  return (
    <div className="shell">
      <header className="hero panel">
        <div>
          <span className="eyebrow">Short Drama Pipeline</span>
          <h1>短剧生成器</h1>
          <p>
            一套五阶段工作台：文字到剧本，剧本到分镜，分镜到图片，图片到视频，最后导出完整成片。
          </p>
        </div>
        <div className="hero-side">
          <div className="hero-actions">
            <div className="env-card">
              <span>文本模型</span>
              <strong>{meta?.envStatus.llmConfigured ? '已配置' : '未配置'}</strong>
            </div>
            <div className="env-card">
              <span>ComfyUI</span>
              <strong>{meta?.envStatus.comfyuiConfigured ? '已连接地址' : '未配置地址'}</strong>
            </div>
            <div className="env-card">
              <span>FFmpeg</span>
              <strong>{meta?.envStatus.ffmpegReady ? '可用' : '缺失'}</strong>
            </div>
          </div>
          <button className="button ghost settings-trigger" onClick={() => setSettingsOpen(true)}>
            系统设置
          </button>
        </div>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}

      <main className="workspace">
        <aside className="sidebar panel">
          <section className="create-block">
            <div className="section-head">
              <h2>新建项目</h2>
              <span>输入梗概、草稿或原始文案</span>
            </div>
            <label className="field">
              <span>项目标题</span>
              <input
                value={createTitle}
                onChange={(event) => setCreateTitle(event.target.value)}
                placeholder="例如：替身新娘复仇记"
              />
            </label>
            <label className="field">
              <span>原始文字</span>
              <textarea
                value={createSource}
                onChange={(event) => setCreateSource(event.target.value)}
                placeholder="输入故事梗概、现有剧本、角色设定或营销文案"
                rows={9}
              />
            </label>
            <button
              className="button primary"
              disabled={pending === 'create' || !createSource.trim()}
              onClick={() => void handleCreateProject()}
            >
              {pending === 'create' ? '创建中...' : '创建项目'}
            </button>
          </section>

          <section className="project-list">
            <div className="section-head">
              <h2>项目列表</h2>
              <span>{projects.length} 个项目</span>
            </div>
            {projects.length ? (
              projects.map((item) => (
                <button
                  key={item.id}
                  className={`project-card ${selectedId === item.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>{item.runState.isRunning ? `进行中: ${item.runState.currentStage ?? '排队'}` : '空闲'}</span>
                  <small>{formatTime(item.updatedAt)}</small>
                </button>
              ))
            ) : (
              <div className="empty-card">还没有项目，先在上方创建一个。</div>
            )}
          </section>
        </aside>

        <section className="main panel">
          {project && draft ? (
            <>
              <div className="project-header">
                <div>
                  <span className="eyebrow">Project Workspace</span>
                  <h2>{project.title}</h2>
                  <p>
                    创建于 {formatTime(project.createdAt)}，最近更新 {formatTime(project.updatedAt)}
                  </p>
                </div>
                <div className="header-actions">
                  <button
                    className="button ghost"
                    disabled={Boolean(project.runState.isRunning) || pending === 'save'}
                    onClick={() => void handleSaveProject()}
                  >
                    {pending === 'save' ? '保存中...' : '保存项目'}
                  </button>
                  <button
                    className="button primary"
                    disabled={Boolean(project.runState.isRunning) || pending === 'all'}
                    onClick={() => void handleRunStage('all')}
                  >
                    {pending === 'all' ? '提交中...' : '执行全流程'}
                  </button>
                </div>
              </div>

              <div className="status-strip">
                {meta ? (
                  <>
                    <div className="status-item">
                      <span>图片工作流</span>
                      <strong>{meta.envStatus.imageWorkflowExists ? '已找到模板' : '模板缺失'}</strong>
                    </div>
                    <div className="status-item">
                      <span>视频工作流</span>
                      <strong>{meta.envStatus.videoWorkflowExists ? '已找到模板' : '模板缺失'}</strong>
                    </div>
                    <div className="status-item">
                      <span>当前运行</span>
                      <strong>
                        {project.runState.isRunning
                          ? project.runState.currentStage
                            ? STAGE_LABELS[project.runState.currentStage]
                            : '排队中'
                          : '无'}
                      </strong>
                    </div>
                  </>
                ) : null}
              </div>

              <section className="stage-grid">
                {STAGES.map((stage) => {
                  const state = project.stages[stage];
                  return (
                    <article key={stage} className={`stage-card status-${state.status}`}>
                      <div className="stage-top">
                        <div>
                          <span className="stage-index">
                            {String(STAGES.indexOf(stage) + 1).padStart(2, '0')}
                          </span>
                          <h3>{STAGE_LABELS[stage]}</h3>
                        </div>
                        <span className={`pill ${state.status}`}>{statusLabel(state.status)}</span>
                      </div>
                      <p>
                        开始：{formatTime(state.startedAt)}
                        <br />
                        完成：{formatTime(state.finishedAt)}
                      </p>
                      {state.error ? <div className="error-box">{state.error}</div> : null}
                      <button
                        className="button secondary"
                        disabled={Boolean(project.runState.isRunning) || pending === stage}
                        onClick={() => void handleRunStage(stage)}
                      >
                        {pending === stage ? '提交中...' : `执行${STAGE_LABELS[stage]}`}
                      </button>
                    </article>
                  );
                })}
              </section>

              <section className="content-grid">
                <article className="panel inset">
                  <div className="section-head">
                    <h3>项目设定</h3>
                    <span>保存后用于后续所有阶段</span>
                  </div>
                  <div className="form-grid">
                    <label className="field span-2">
                      <span>项目标题</span>
                      <input
                        value={draft.title}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current ? { ...current, title: event.target.value } : current;
                          })
                        }
                      />
                    </label>
                    <label className="field span-2">
                      <span>原始文字</span>
                      <textarea
                        rows={8}
                        value={draft.sourceText}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current ? { ...current, sourceText: event.target.value } : current;
                          })
                        }
                      />
                    </label>

                    <label className="field">
                      <span>语气风格</span>
                      <input
                        value={draft.settings.tone}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? { ...current, settings: { ...current.settings, tone: event.target.value } }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>受众</span>
                      <input
                        value={draft.settings.audience}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: { ...current.settings, audience: event.target.value }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field span-2">
                      <span>视觉风格</span>
                      <textarea
                        rows={3}
                        value={draft.settings.visualStyle}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: { ...current.settings, visualStyle: event.target.value }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field span-2">
                      <span>反向提示词</span>
                      <textarea
                        rows={2}
                        value={draft.settings.negativePrompt}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: { ...current.settings, negativePrompt: event.target.value }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>语言</span>
                      <input
                        value={draft.settings.language}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? { ...current, settings: { ...current.settings, language: event.target.value } }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>画幅</span>
                      <select
                        value={draft.settings.aspectRatio}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    aspectRatio: event.target.value as ProjectSettings['aspectRatio']
                                  }
                                }
                              : current;
                          })
                        }
                      >
                        <option value="9:16">9:16 竖屏</option>
                        <option value="16:9">16:9 横屏</option>
                        <option value="1:1">1:1 方屏</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>图片宽度</span>
                      <input
                        type="number"
                        value={draft.settings.imageWidth}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    imageWidth: Number(event.target.value) || current.settings.imageWidth
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>图片高度</span>
                      <input
                        type="number"
                        value={draft.settings.imageHeight}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    imageHeight: Number(event.target.value) || current.settings.imageHeight
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>视频宽度</span>
                      <input
                        type="number"
                        value={draft.settings.videoWidth}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    videoWidth: Number(event.target.value) || current.settings.videoWidth
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>视频高度</span>
                      <input
                        type="number"
                        value={draft.settings.videoHeight}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    videoHeight: Number(event.target.value) || current.settings.videoHeight
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>FPS</span>
                      <input
                        type="number"
                        value={draft.settings.fps}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    fps: Number(event.target.value) || current.settings.fps
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>默认镜头秒数</span>
                      <input
                        type="number"
                        value={draft.settings.defaultShotDurationSeconds}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    defaultShotDurationSeconds:
                                      Number(event.target.value) || current.settings.defaultShotDurationSeconds
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>目标场景数</span>
                      <input
                        type="number"
                        value={draft.settings.targetSceneCount}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    targetSceneCount:
                                      Number(event.target.value) || current.settings.targetSceneCount
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>每场最多镜头</span>
                      <input
                        type="number"
                        value={draft.settings.maxShotsPerScene}
                        onChange={(event) =>
                          setDraft((current) => {
                            setDraftDirty(true);
                            return current
                              ? {
                                  ...current,
                                  settings: {
                                    ...current.settings,
                                    maxShotsPerScene:
                                      Number(event.target.value) || current.settings.maxShotsPerScene
                                  }
                                }
                              : current;
                          })
                        }
                      />
                    </label>
                  </div>
                </article>

                <article className="panel inset">
                  <div className="section-head">
                    <h3>剧本</h3>
                    <span>
                      {project.artifacts.scriptJson ? (
                        <a href={assetUrl(project.artifacts.scriptJson)} target="_blank" rel="noreferrer">
                          查看 JSON
                        </a>
                      ) : (
                        '等待生成'
                      )}
                    </span>
                  </div>
                  {project.script ? (
                    <pre className="content-block">{project.script.markdown}</pre>
                  ) : (
                    <div className="empty-card">执行第一阶段后会在这里显示完整剧本。</div>
                  )}
                </article>
              </section>

              <section className="panel inset">
                <div className="section-head">
                  <h3>分镜与素材</h3>
                  <span>
                    {project.artifacts.storyboardJson ? (
                      <a href={assetUrl(project.artifacts.storyboardJson)} target="_blank" rel="noreferrer">
                        下载分镜 JSON
                      </a>
                    ) : (
                      '等待分镜生成'
                    )}
                  </span>
                </div>
                {project.storyboard.length ? (
                  <div className="shots-grid">
                    {project.storyboard.map((shot) => {
                      const imageAsset = imageMap.get(shot.id);
                      const videoAsset = videoMap.get(shot.id);

                      return (
                        <article key={shot.id} className="shot-card">
                          <div className="shot-head">
                            <strong>
                              S{shot.sceneNumber} · #{shot.shotNumber}
                            </strong>
                            <span>{shot.durationSeconds}s</span>
                          </div>
                          <h4>{shot.title}</h4>
                          <p>{shot.purpose}</p>
                          <dl className="shot-meta">
                            <div>
                              <dt>镜头</dt>
                              <dd>{shot.camera}</dd>
                            </div>
                            <div>
                              <dt>构图</dt>
                              <dd>{shot.composition}</dd>
                            </div>
                            <div>
                              <dt>对白</dt>
                              <dd>{shot.dialogue || '无'}</dd>
                            </div>
                            <div>
                              <dt>画外音</dt>
                              <dd>{shot.voiceover || '无'}</dd>
                            </div>
                          </dl>
                          <div className="prompt-block">
                            <h5>首帧描述</h5>
                            <p>{shot.firstFramePrompt}</p>
                          </div>
                          <div className="prompt-block">
                            <h5>视频描述</h5>
                            <p>{shot.videoPrompt}</p>
                          </div>
                          <div className="asset-stack">
                            <div className="asset-box">
                              <span>图片</span>
                              {imageAsset ? (
                                <>
                                  <img src={assetUrl(imageAsset.relativePath)} alt={shot.title} />
                                  <a href={assetUrl(imageAsset.relativePath)} target="_blank" rel="noreferrer">
                                    打开原图
                                  </a>
                                </>
                              ) : (
                                <small>未生成</small>
                              )}
                            </div>
                            <div className="asset-box">
                              <span>视频</span>
                              {videoAsset ? (
                                <>
                                  <video src={assetUrl(videoAsset.relativePath)} controls playsInline />
                                  <a href={assetUrl(videoAsset.relativePath)} target="_blank" rel="noreferrer">
                                    打开片段
                                  </a>
                                </>
                              ) : (
                                <small>未生成</small>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-card">执行第二阶段后会在这里显示所有分镜、首帧图和视频片段。</div>
                )}
              </section>

              <section className="bottom-grid">
                <article className="panel inset">
                  <div className="section-head">
                    <h3>最终成片</h3>
                    <span>{project.assets.finalVideo ? '已导出' : '等待剪辑'}</span>
                  </div>
                  {project.assets.finalVideo ? (
                    <div className="final-video">
                      <video src={assetUrl(project.assets.finalVideo.relativePath)} controls playsInline />
                      <a href={assetUrl(project.assets.finalVideo.relativePath)} target="_blank" rel="noreferrer">
                        打开最终视频
                      </a>
                    </div>
                  ) : (
                    <div className="empty-card">执行第五阶段后会在这里预览完整视频。</div>
                  )}
                </article>

                <article className="panel inset">
                  <div className="section-head">
                    <h3>执行日志</h3>
                    <span>{project.logs.length} 条</span>
                  </div>
                  {project.logs.length ? (
                    <div className="log-list">
                      {[...project.logs].reverse().map((entry) => (
                        <div key={entry.id} className={`log-item ${entry.level}`}>
                          <strong>{entry.level.toUpperCase()}</strong>
                          <span>{entry.message}</span>
                          <small>{formatTime(entry.createdAt)}</small>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-card">执行阶段后会在这里持续记录日志。</div>
                  )}
                </article>
              </section>
            </>
          ) : (
            <div className="empty-state">
              <span className="eyebrow">Ready</span>
              <h2>先创建一个短剧项目</h2>
              <p>左侧输入文字素材后创建项目，随后即可按阶段执行或直接跑完整条生产线。</p>
            </div>
          )}
        </section>
      </main>

      <SettingsDialog
        open={settingsOpen}
        draft={settingsDraft}
        status={meta?.envStatus ?? null}
        dirty={settingsDirty}
        pending={settingsPending}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsDraft(appSettings);
          setSettingsDirty(false);
        }}
        onSave={() => void handleSaveAppSettings()}
        onChange={(next) => {
          setSettingsDraft(next);
          setSettingsDirty(true);
        }}
      />
    </div>
  );
}
