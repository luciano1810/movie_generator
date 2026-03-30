# 短剧生成器

一个面向本地生产流程的短剧工作台，包含五个阶段：

1. 剧本生成：根据输入文案生成或优化剧本
   剧本生成完成后会自动用 LLM 提取角色、场景和关键物品候选
2. 分镜生成：根据剧本拆解镜头，输出首帧描述、尾帧描述、视频片段描述，以及每个镜头在成片中的起止时间
3. 图片生成：调用本地 ComfyUI API 生成每个分镜首帧图，并自动把资产库参考信息作为输入
4. 视频生成：调用本地 ComfyUI API 基于首帧图和镜头描述生成视频片段；长镜头会自动拆段，并结合首尾帧约束生成收尾段，同时自动把资产库参考信息作为输入
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

COMFYUI_BASE_URL=http://100.100.8.2:8188
COMFYUI_CHARACTER_ASSET_WORKFLOW=./config/workflows/firered-image-edit-1.1_api.template.json
COMFYUI_STORYBOARD_IMAGE_WORKFLOW=./config/workflows/storyboard-image-edit-3ref.template.json
COMFYUI_TEXT_TO_IMAGE_WORKFLOW=./config/workflows/zimage_text_to_image.template.json
COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW=./config/workflows/image-workflow.template.json
COMFYUI_IMAGE_EDIT_WORKFLOW=./config/workflows/firered-image-edit-1.1_api.template.json
COMFYUI_TEXT_TO_VIDEO_WORKFLOW=
COMFYUI_IMAGE_TO_VIDEO_WORKFLOW=./config/workflows/ltx_2.3_ti2v_api.template.json
COMFYUI_TTS_WORKFLOW=
```

可选：

```env
FFMPEG_PATH=/absolute/path/to/ffmpeg
VITE_API_BASE_URL=http://127.0.0.1:3001
```

说明：

- `.env` 现在主要用于首次启动时提供默认值
- 启动后可以直接在 Web 界面的“系统设置”里修改 LLM API、ComfyUI API、八类 ComfyUI 工作流和 FFmpeg 路径
- ComfyUI 设置现在只填写工作流 JSON 路径；checkpoint 需要直接固化在你自己的工作流文件里
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
- 现在支持为人物资产、分镜图片、文生图、参考图生图、图片编辑、文生视频、图生视频、TTS 八类任务分别绑定不同工作流
- `COMFYUI_TTS_WORKFLOW` 是可选配置；如果未配置，分镜里的背景声音 prompt 和台词/旁白 prompt 会自动合并到视频工作流的 `{{prompt}}` 输入
- 默认 TTS 现在分成两条：参考音频版工作流作为默认模板；当镜头没有可用的角色参考音频时，视频片段生成阶段会自动回退到无参考音频版，直接根据对白文字生成语音
- 如果配置了可用的 `COMFYUI_TTS_WORKFLOW`，项目在“视频片段生成”阶段会先按镜头准备 TTS 配音，再按对白长度生成对应时长的视频片段；最终“视频剪辑”阶段主要负责把配音混入各个片段并导出成片
- 当前主流程实际会使用到：人物资产、分镜图片、文生图、参考图生图、图生视频、TTS；图片阶段会优先使用 `storyboard_image` 工作流，若未配置则回退到 `image_edit`，缺少参考图时再回退到 `text_to_image`
- 资产提取阶段现在会把“同一人物在不同年龄段的出场”拆成多个角色资产；每个基础场景也会自动扩成两个不同角度的场景资产，方便后续首帧和视频阶段同时注入多张空间参考图

### 支持的占位符

模板 JSON 中可以使用以下变量：

- `{{prompt}}`
- `{{negative_prompt}}`
- `{{output_prefix}}`
- `{{image_width}}`
- `{{image_height}}`
- `{{video_width}}`
- `{{video_height}}`
- `{{fps}}`
- `{{duration_seconds}}`
- `{{frame_count}}`
- `{{latent_video_width}}`
- `{{latent_video_height}}`
- `{{input_image}}`
- `{{last_frame_image}}`
- `{{last_frame_prompt}}`
- `{{reference_context}}`
- `{{reference_count}}`
- `{{reference_image_count}}`
- `{{reference_total_image_count}}`
- `{{reference_images}}`
- `{{reference_assets}}`
- `{{edit_image_1}}`
- `{{edit_image_2}}`
- `{{edit_image_3}}`
- `{{reference_batch_index}}`
- `{{reference_batch_total}}`
- `{{reference_batch_size}}`
- `{{reference_batch_images}}`
- `{{character_reference_image}}`
- `{{character_reference_images}}`
- `{{character_reference_assets}}`
- `{{scene_reference_image}}`
- `{{scene_reference_images}}`
- `{{scene_reference_assets}}`
- `{{object_reference_image}}`
- `{{object_reference_images}}`
- `{{object_reference_assets}}`
- `{{scene_number}}`
- `{{shot_number}}`
- `{{seed}}`
- `{{dialogue}}`
- `{{voiceover}}`
- `{{speech_prompt}}`
- `{{tts_script}}`
- `{{tts_plain_text}}`
- `{{tts_role_1_name}}`
- `{{tts_role_2_name}}`
- `{{tts_role_3_name}}`
- `{{narrator_reference_audio}}`
- `{{speaker_1_reference_audio}}`
- `{{speaker_2_reference_audio}}`
- `{{tts_default_speaker}}`

说明：

- `reference_context` 会自动追加到图片/视频 prompt 中
- `reference_images`、`reference_assets` 以及按类型拆分的 `*_reference_images` / `*_reference_assets` 适合在工作流 JSON 中以“整个字段就是占位符”的方式直接注入数组或对象
- `edit_image_1` / `edit_image_2` / `edit_image_3` 是给多图图片编辑工作流准备的便捷变量，会优先按场景、角色、物品参考图回填；如果只找到一部分参考图，会自动复用已有输入补齐
- `reference_batch_*` 是给“单次最多吃 3 张参考图”的分镜图片工作流准备的；当资产库参考图超过 3 张时，服务端会自动分批多轮执行工作流，并把上一轮结果作为下一轮的主输入继续融合

### 生图模板

`config/workflows/zimage_text_to_image.template.json` 是当前默认的文生图模板，对应仓库里的 ZImage API 工作流。它默认映射 `{{prompt}}`、`{{output_prefix}}`、`{{image_width}}`、`{{image_height}}` 和 `{{seed}}`；如果你的 ComfyUI 环境里的 CLIP、VAE、UNet、LoRA 或放大模型文件名不同，需要改成实际存在的模型文件名。

`config/workflows/image-workflow.template.json` 仍保留为一个更通用的旧版基础示例，适合常见 `CheckpointLoaderSimple + KSampler + SaveImage` 结构；如果你希望切回更简单的文生图链路，也可以在系统设置里把 `text_to_image` 工作流手动切到这份模板。

### 图片编辑模板

`config/workflows/firered-image-edit-1.1_api.template.json` 提供了一个 FireRed 三图输入模板，默认映射 `{{prompt}}`、`{{negative_prompt}}`、`{{output_prefix}}`、`{{seed}}` 和 `{{edit_image_1}}` ~ `{{edit_image_3}}`。

人物资产默认也可以使用这套模板；仓库内置的姿态参考图路径是 `config/reference-images/character-pose-three-view.png`。当角色资产未单独上传参考图时，系统会把这张三视图作为默认姿态输入；如果角色资产上传了参考图并选择“参考图 + Prompt”，该角色参考图会作为主参考输入，三视图仍会继续作为姿态约束。

### 分镜图片模板

`config/workflows/storyboard-image-edit-3ref.template.json` 是基于 FireRed 三图模板复制出的分镜首帧专用版本，默认同样映射 `{{prompt}}`、`{{negative_prompt}}`、`{{output_prefix}}`、`{{seed}}` 和 `{{edit_image_1}}` ~ `{{edit_image_3}}`。

图片阶段会自动把资产库里的场景、角色、物品参考图按优先级注入这三个输入位；如果参考图超过 3 张，后端会自动把参考图拆成多批次运行，并把上一轮生成结果继续作为下一轮 `edit_image_1` 输入。

### 生视频模板

项目默认的图生视频工作流现在是 `config/workflows/ltx_2.3_ti2v_api.template.json`。这份模板已经接好 `{{input_image}}`、`{{prompt}}`、`{{negative_prompt}}`、`{{fps}}`、`{{frame_count}}`、`{{latent_video_width}}`、`{{latent_video_height}}`、`{{output_prefix}}` 和 `{{seed}}`，可以直接作为 LTX 2.3 的默认视频工作流使用。

`config/workflows/video-workflow.template.json` 仍然保留为通用占位示例；如果你以后切换到别的视频模型，可以继续替换成自己的 API Workflow JSON。

### TTS 模板

项目现在内置了两份默认 TTS 模板：

- `config/workflows/qwen3_tts_no_reference.template.json`
  用于“无参考音频版”默认配音。后台会把镜头里的每句对白拆开，按说话角色分别调用这条模板生成音频，再合并成镜头配音；送入 TTS 的正文只包含对白文本，不包含人物名称或说话人标签
- `config/workflows/qwen3_tts_dialogue.template.json`
  用于“参考音频版”多角色配音，它是根据你提供的 LTX 2.3 全栈工作流里那条 Qwen3 TTS 多角色支线整理出来的 API 模板

系统设置中的默认 `COMFYUI_TTS_WORKFLOW` 现在会指向参考音频版模板；如果镜头里匹配到的角色没有上传可用参考音频，视频片段生成阶段会自动回退到无参考音频版模板继续执行。

后台现在会按对白逐句生成配音：每句对白都会单独调用 TTS，并在需要时为对应角色注入参考音频。即使没有上传参考音频，系统也会为不同角色分配稳定且不同的默认音色；实际送入 TTS 模型的文本只包含对白内容，不包含人物名称。

无参考音频版模板使用 `{{tts_plain_text}}` 作为单句纯朗读文本，不带角色标签；当镜头里的某句对白没有匹配到可用角色参考音频时，会自动回退到这条默认链路。

建议步骤：

1. 在 ComfyUI 中搭好你的目标工作流，并在工作流里直接固定 checkpoint
2. 导出 API Workflow JSON
3. 把其中的输入字段替换成上面的占位符
4. 将文件路径写入对应的 ComfyUI workflow 配置项

如果你需要通过环境变量预填工作流路径，可以分别写入：

- `COMFYUI_CHARACTER_ASSET_WORKFLOW`
- `COMFYUI_STORYBOARD_IMAGE_WORKFLOW`
- `COMFYUI_TEXT_TO_IMAGE_WORKFLOW`
- `COMFYUI_REFERENCE_IMAGE_TO_IMAGE_WORKFLOW`
- `COMFYUI_IMAGE_EDIT_WORKFLOW`
- `COMFYUI_TEXT_TO_VIDEO_WORKFLOW`
- `COMFYUI_IMAGE_TO_VIDEO_WORKFLOW`
- `COMFYUI_TTS_WORKFLOW`

## 生成产物

每个项目都会落盘到 `storage/projects/<project-id>/`：

- `project.json`：项目状态、日志、阶段结果
- `script/`：剧本 Markdown 和 JSON
- `storyboard/`：分镜 JSON（包含每个镜头的累计时间轴）
- `images/`：首帧图片
- `videos/`：视频片段
- `output/final.mp4`：最终拼接成片

## Web 界面能力

- 创建和切换项目
- 通过“系统设置”菜单配置 LLM API、ComfyUI API 和 FFmpeg
- 输入 LLM Base URL 和 API Key 后自动获取可用模型列表
- 编辑剧情、风格、画幅、分辨率、镜头时长等参数
- 将剧本生成、资产生成、分镜生成、图片生成、视频生成、视频剪辑拆成 6 个独立阶段 tab
- 资产阶段会提取角色、场景和物品候选，并批量生成参考图
- 在项目页修改候选 prompt，并单独生成或重新生成角色/场景/物品参考图
- 单独执行任一阶段
- 一键执行完整六阶段流程
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
