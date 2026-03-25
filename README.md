# 短剧生成器

一个面向本地生产流程的短剧工作台，包含五个阶段：

1. 剧本生成：根据输入文案生成或优化剧本
   剧本生成完成后会自动用 LLM 提取角色、场景和关键物品候选
2. 分镜生成：根据剧本拆解镜头，输出首帧描述和视频片段描述
3. 图片生成：调用本地 ComfyUI API 生成每个分镜首帧图
4. 视频生成：调用本地 ComfyUI API 基于首帧图和镜头描述生成视频片段
5. 视频剪辑：按分镜顺序拼接视频片段，导出完整成片

## 技术栈

- 前端：React + Vite
- 后端：Node.js + Express + TypeScript
- 文本生成：OpenAI 兼容 API
- 图片/视频生成：本地 ComfyUI API
- 剪辑：FFmpeg 或 `ffmpeg-static`

## 项目结构

```text
src/client            Web 管理界面
src/server            API、流程编排、ComfyUI/OpenAI 接口
src/shared            前后端共享类型
config/workflows      ComfyUI 工作流模板
storage/projects      项目数据、图片、视频、最终导出文件
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，至少填写以下参数：

```env
HOST=127.0.0.1
PORT=3001

OPENAI_BASE_URL=https://your-openai-compatible-api/v1
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4o-mini

COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_CHARACTER_WORKFLOW=./config/workflows/image-workflow.template.json
COMFYUI_SCENE_WORKFLOW=./config/workflows/image-workflow.template.json
COMFYUI_OBJECT_WORKFLOW=./config/workflows/image-workflow.template.json
COMFYUI_STORYBOARD_WORKFLOW=./config/workflows/image-workflow.template.json
COMFYUI_VIDEO_WORKFLOW=./config/workflows/video-workflow.template.json
COMFYUI_TTS_WORKFLOW=
COMFYUI_CHARACTER_CHECKPOINT=your_character_checkpoint.safetensors
COMFYUI_SCENE_CHECKPOINT=your_scene_checkpoint.safetensors
COMFYUI_OBJECT_CHECKPOINT=your_object_checkpoint.safetensors
COMFYUI_STORYBOARD_CHECKPOINT=your_storyboard_checkpoint.safetensors
COMFYUI_VIDEO_CHECKPOINT=your_video_checkpoint.safetensors
COMFYUI_TTS_CHECKPOINT=your_tts_checkpoint.safetensors
```

可选：

```env
FFMPEG_PATH=/absolute/path/to/ffmpeg
VITE_API_BASE_URL=http://127.0.0.1:3001
```

说明：

- `.env` 现在主要用于首次启动时提供默认值
- 启动后可以直接在 Web 界面的“系统设置”里修改 LLM API、ComfyUI API、可选的 TTS 工作流和 FFmpeg 路径
- 运行期设置会保存在项目根目录的 `.shortdrama-generator.settings.json`

### 3. 启动开发环境

```bash
npm run dev
```

- 前端默认地址：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- 后端默认地址：[http://127.0.0.1:3001](http://127.0.0.1:3001)

### 4. 构建生产版本

```bash
npm run build
npm start
```

## ComfyUI 工作流模板说明

这个项目把 ComfyUI 调用设计成“模板注入”模式，而不是写死某一套节点图。

原因很直接：

- 生图工作流节点差异相对小，可以提供一个基础模板
- 生视频工作流差异很大，不同模型和自定义节点的 API JSON 结构差别明显
- 真实项目里，最稳妥的做法是从你自己的 ComfyUI 里导出 API Workflow JSON，再替换模板
- 现在支持为人物、场景、物品、分镜图片、视频、TTS 六类任务分别绑定不同工作流
- `COMFYUI_TTS_WORKFLOW` 是可选配置；如果未配置，分镜里的背景声音 prompt 和台词/旁白 prompt 会自动合并到视频工作流的 `{{prompt}}` 输入
- 如果配置了可用的 `COMFYUI_TTS_WORKFLOW`，项目在“视频剪辑”阶段会先按镜头生成 TTS 配音，再把配音混入各个视频片段并导出最终成片

### 支持的占位符

模板 JSON 中可以使用以下变量：

- `{{prompt}}`
- `{{negative_prompt}}`
- `{{output_prefix}}`
- `{{checkpoint_name}}`
- `{{image_width}}`
- `{{image_height}}`
- `{{video_width}}`
- `{{video_height}}`
- `{{fps}}`
- `{{duration_seconds}}`
- `{{input_image}}`
- `{{scene_number}}`
- `{{shot_number}}`
- `{{seed}}`

### 生图模板

`config/workflows/image-workflow.template.json` 提供了一个基础示例，适合常见 `CheckpointLoaderSimple + KSampler + SaveImage` 结构。

### 生视频模板

`config/workflows/video-workflow.template.json` 只是占位示例，你需要替换成你自己的 API Workflow JSON。

建议步骤：

1. 在 ComfyUI 中搭好你的图生视频工作流
2. 导出 API Workflow JSON
3. 把其中的输入字段替换成上面的占位符
4. 将文件路径写入 `COMFYUI_VIDEO_WORKFLOW`

如果你需要独立配置参考资产或分镜图片工作流，可以分别写入：

- `COMFYUI_CHARACTER_WORKFLOW`
- `COMFYUI_SCENE_WORKFLOW`
- `COMFYUI_OBJECT_WORKFLOW`
- `COMFYUI_STORYBOARD_WORKFLOW`
- `COMFYUI_VIDEO_WORKFLOW`
- `COMFYUI_TTS_WORKFLOW`

## 生成产物

每个项目都会落盘到 `storage/projects/<project-id>/`：

- `project.json`：项目状态、日志、阶段结果
- `script/`：剧本 Markdown 和 JSON
- `storyboard/`：分镜 JSON
- `images/`：首帧图片
- `videos/`：视频片段
- `output/final.mp4`：最终拼接成片

## Web 界面能力

- 创建和切换项目
- 通过“系统设置”菜单配置 LLM API、ComfyUI API 和 FFmpeg
- 输入 LLM Base URL 和 API Key 后自动获取可用模型列表
- 编辑剧情、风格、画幅、分镜数量等参数
- 剧本完成后自动提取角色、场景和物品候选
- 在项目页修改候选 prompt，并单独生成或重新生成角色/场景/物品参考图
- 单独执行任一阶段
- 一键执行完整五阶段流程
- 查看剧本、分镜、图片、视频片段和最终成片
- 资产库分为流程产物、角色、场景、物品四类
- 查看实时日志和阶段状态

## 已验证

已完成本地验证：

- `npm run typecheck`
- `npm run build`

说明：

- 在当前沙箱里无法实际监听本地端口，所以没有完成浏览器级烟测
- 文本生成和 ComfyUI 调用需要你提供真实的 API 地址、密钥与工作流模板后才能跑通
