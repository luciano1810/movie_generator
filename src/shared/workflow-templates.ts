import type { ComfyWorkflowType } from './types.js';

export interface WorkflowTemplateOption {
  path: string;
  label: string;
  description: string;
}

export const DEFAULT_COMFY_WORKFLOW_TEMPLATE_PATHS: Record<ComfyWorkflowType, string> = {
  character_asset: 'config/workflows/firered-image-edit-1.1_api.template.json',
  storyboard_image: 'config/workflows/storyboard-image-edit-3ref.template.json',
  text_to_image: 'config/workflows/zimage_text_to_image.template.json',
  reference_image_to_image: 'config/workflows/image-workflow.template.json',
  image_edit: 'config/workflows/firered-image-edit-1.1_api.template.json',
  text_to_video: 'config/workflows/video-workflow.template.json',
  image_to_video_first_last: 'config/workflows/ltx_2.3_i2v_first_last_api.template.json',
  image_to_video_first_frame: 'config/workflows/ltx_2.3_i2v_modular_api.template.json',
  tts: 'config/workflows/qwen3_tts_dialogue.template.json'
};

export const WORKFLOW_TEMPLATE_OPTIONS: Record<ComfyWorkflowType, WorkflowTemplateOption[]> = {
  character_asset: [
    {
      path: 'config/workflows/firered-image-edit-1.1_api.template.json',
      label: 'FireRed Image Edit 1.1 API',
      description: '当前人物资产默认模板，适合角色参考图与人物设定图生成。'
    }
  ],
  storyboard_image: [
    {
      path: 'config/workflows/storyboard-image-edit-3ref.template.json',
      label: 'Storyboard Image Edit 3 Ref',
      description: '当前参考帧推荐模板，可自动注入最多 3 张参考图。'
    },
    {
      path: 'config/workflows/firered-image-edit-1.1_api.template.json',
      label: 'FireRed Image Edit 1.1 API',
      description: '参考帧阶段的兼容回退模板，适合简单图像编辑或重绘。'
    }
  ],
  text_to_image: [
    {
      path: 'config/workflows/zimage_text_to_image.template.json',
      label: 'ZImage Text-to-Image API',
      description: '无参考图资产的默认模板，用于场景图、物品图等纯文本生图。'
    }
  ],
  reference_image_to_image: [
    {
      path: 'config/workflows/image-workflow.template.json',
      label: 'Legacy Reference Image Workflow',
      description: '旧版参考图生图模板，适合兼容已有项目。'
    },
    {
      path: 'config/workflows/storyboard-image-edit-3ref.template.json',
      label: 'Storyboard Image Edit 3 Ref',
      description: '可作为多参考图约束的替代模板。'
    },
    {
      path: 'config/workflows/firered-image-edit-1.1_api.template.json',
      label: 'FireRed Image Edit 1.1 API',
      description: '适合单张参考图驱动的编辑和重绘。'
    }
  ],
  image_edit: [
    {
      path: 'config/workflows/qwen-rapid-aio-image-edit.template.json',
      label: 'Qwen Rapid GGUF Image Edit',
      description: '基于 Qwen-Rapid-NSFW-v23_Q4_K.gguf 的三参考图图片编辑模板，使用 GGUF UNet 加载节点。'
    },
    {
      path: 'config/workflows/firered-image-edit-1.1_api.template.json',
      label: 'FireRed Image Edit 1.1 API',
      description: '当前图片编辑默认模板，适合局部重绘、修图与二次加工。'
    },
    {
      path: 'config/workflows/storyboard-image-edit-3ref.template.json',
      label: 'Storyboard Image Edit 3 Ref',
      description: '需要多参考图约束时可作为替代模板。'
    }
  ],
  text_to_video: [
    {
      path: 'config/workflows/ltx_2.3_ti2v_api.template.json',
      label: 'LTX 2.3 TI2V API',
      description: 'LTX 2.3 纯文本生视频模板，适合无参考帧的视频生成。'
    },
    {
      path: 'config/workflows/video-workflow.template.json',
      label: 'Legacy Text-to-Video Workflow',
      description: '旧版文生视频模板，保留用于兼容已有链路。'
    }
  ],
  image_to_video_first_last: [
    {
      path: 'config/workflows/ltx_2.3_i2v_first_last_api.template.json',
      label: 'LTX 2.3 I2V First+Last API',
      description: '首尾帧视频默认模板，支持起始帧 + 结束参考帧收束。依赖 Reimgsize 节点。'
    },
    {
      path: 'config/workflows/video-workflow.template.json',
      label: 'Legacy Image-to-Video Workflow',
      description: '旧版图生视频模板，保留用于兼容历史配置。'
    }
  ],
  image_to_video_first_frame: [
    {
      path: 'config/workflows/ltx_2.3_i2v_modular_api.template.json',
      label: 'LTX 2.3 I2V Modular API',
      description: '首帧视频默认模板，用于只提供起始帧、不生成结束参考帧的镜头。依赖 Reimgsize 节点。'
    },
    {
      path: 'config/workflows/video-workflow.template.json',
      label: 'Legacy Image-to-Video Workflow',
      description: '旧版图生视频模板，保留用于兼容历史配置。'
    }
  ],
  tts: [
    {
      path: 'config/workflows/qwen3_tts_dialogue.template.json',
      label: 'Qwen3 TTS Dialogue',
      description: '参考音频驱动的 TTS 模板，适合多角色对白。'
    },
    {
      path: 'config/workflows/qwen3_tts_no_reference.template.json',
      label: 'Qwen3 TTS No Reference',
      description: '无参考音频的 TTS 模板，适合快速旁白或临时配音。'
    }
  ]
};
