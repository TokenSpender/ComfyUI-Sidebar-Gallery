// AUTO-GENERATED default layout: the project's ComfyUI panel layout, shown on a
// fresh install before any customisation. Sections tied to specific custom nodes
// auto-hide when their data is absent.
export const DEFAULT_IMAGE_LAYOUT = [
  {
    "id": "file_info",
    "title": "File Info",
    "style": "flat",
    "open": true,
    "params": [
      {
        "path": "filename",
        "label": "",
        "style": "kv",
        "color": {
          "bg": "rgba(26, 26, 26, 0)"
        }
      },
      {
        "path": "path",
        "label": "Path",
        "_prevStyle": "kv",
        "style": "hidden",
        "color": {}
      },
      {
        "path": "filesize",
        "label": "Size",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.25)"
        }
      },
      {
        "path": "resolution",
        "label": "Resolution",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.25)"
        }
      },
      {
        "path": "modified",
        "label": "Modified",
        "_prevStyle": "kv",
        "style": "hidden"
      },
      {
        "path": "codec",
        "label": "Codec",
        "style": "hidden",
        "_prevStyle": "kv"
      }
    ],
    "color": {}
  },
  {
    "id": "models",
    "title": "Models",
    "style": "flat",
    "open": true,
    "params": [
      {
        "path": "model",
        "label": "Model",
        "style": "title",
        "color": {
          "bg": "rgba(227, 109, 238, 0)",
          "text": "#fec43e"
        }
      },
      {
        "path": "clip_models",
        "label": "CLIP",
        "style": "detail"
      },
      {
        "path": "vae",
        "label": "VAE",
        "style": "detail"
      },
      {
        "path": "clip_skip",
        "label": "Clip Skip",
        "style": "detail"
      }
    ]
  },
  {
    "id": "sampling",
    "title": "Sampling",
    "style": "cards",
    "open": true,
    "source": "samplers",
    "highlow": true,
    "params": [
      {
        "path": "samplers.sampler_name",
        "label": "Sampler",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.scheduler",
        "label": "Scheduler",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.cfg",
        "label": "CFG",
        "style": "pill",
        "format": "CFG: {v}",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.steps",
        "label": "Steps",
        "style": "pill",
        "format": "Steps: {v}",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.shift",
        "label": "Shift",
        "style": "pill",
        "format": "Shift: {v}",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.start_at_step",
        "label": "Start At Step",
        "style": "detail"
      },
      {
        "path": "samplers.end_at_step",
        "label": "End At Step",
        "style": "detail"
      },
      {
        "path": "samplers.denoise",
        "label": "Denoise",
        "style": "hidden",
        "_prevStyle": "detail"
      },
      {
        "path": "samplers.add_noise",
        "label": "Add Noise",
        "style": "hidden",
        "_prevStyle": "detail"
      },
      {
        "path": "samplers.return_with_leftover_noise",
        "label": "Return With Leftover Noise",
        "style": "hidden",
        "_prevStyle": "detail"
      },
      {
        "path": "samplers.seed",
        "label": "Seed",
        "style": "detail"
      }
    ]
  },
  {
    "id": "loras",
    "title": "LoRAs",
    "style": "cards",
    "open": true,
    "source": "loras",
    "highlow": false,
    "params": [
      {
        "path": "loras.name",
        "label": "LoRA Name",
        "style": "title",
        "color": {
          "text": "#ffffff"
        }
      },
      {
        "path": "workflow_nodes.Efficient Loader.lora_name",
        "label": "LoRA Name",
        "style": "title",
        "color": {}
      },
      {
        "path": "loras.strength_model",
        "label": "Strength",
        "style": "detail",
        "format": "Strength: {v}",
        "color": {
          "text": "#fec43e"
        }
      },
      {
        "path": "workflow_nodes.Efficient Loader.lora_model_strength",
        "label": "Strength",
        "style": "pill",
        "format": "Strength: {v}",
        "color": {}
      },
      {
        "path": "strength_clip",
        "label": "clip",
        "style": "detail",
        "variant": "accent",
        "format": "clip {v}",
        "color": {
          "text": "#fec43e"
        }
      },
      {
        "path": "workflow_nodes.Efficient Loader.lora_clip_strength",
        "label": "Lora Clip Strength",
        "style": "pill",
        "format": "CLIP Strength: {v}"
      }
    ]
  },
  {
    "id": "s_mq7yjaqb_0",
    "title": "Features",
    "style": "flat",
    "open": true,
    "params": [],
    "tabs": [
      {
        "id": "tab_mq7yjq49_1",
        "label": "ControlNet",
        "style": "cards",
        "params": [
          {
            "path": "controlnet.model",
            "label": "Model",
            "style": "title",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "controlnet.preprocessor",
            "label": "Preprocessor",
            "style": "detail"
          },
          {
            "path": "controlnet.weight",
            "label": "Weight",
            "style": "detail"
          },
          {
            "path": "controlnet.start_percent",
            "label": "Start Percent",
            "style": "pill",
            "format": "Start: {v}",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "controlnet.end_percent",
            "label": "End Percent",
            "style": "pill",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            },
            "format": "End: {v}"
          },
          {
            "path": "controlnet.guidance_start",
            "label": "Guidance Start",
            "style": "detail"
          },
          {
            "path": "controlnet.guidance_end",
            "label": "Guidance End",
            "style": "detail"
          },
          {
            "path": "samplers.end_at_step",
            "label": "End At Step",
            "style": "hidden",
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.Primitive integer [Crystools].int",
            "label": "Steps",
            "style": "pill",
            "match": {
              "title": "CN End Step"
            },
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            },
            "format": "{v} Steps"
          },
          {
            "path": "controlnet.strength",
            "label": "Strength",
            "style": "pill",
            "format": "Strength: {v}",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          }
        ]
      },
      {
        "id": "tab_mq7yjwyj_2",
        "label": "ADetailer",
        "style": "flat",
        "params": [
          {
            "path": "adetailer.model",
            "label": "Model",
            "style": "title",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "adetailer.sampler_name",
            "label": "Sampler",
            "style": "pill",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "adetailer.scheduler",
            "label": "Scheduler",
            "style": "pill",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "adetailer.cfg",
            "label": "CFG",
            "style": "pill",
            "format": "CFG: {v}",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "adetailer.steps",
            "label": "Steps",
            "style": "pill",
            "format": "{v} Steps",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "adetailer.denoise",
            "label": "Denoise",
            "style": "pill",
            "format": "Denoise: {v}",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          }
        ]
      },
      {
        "id": "tab_mq941cgi_1",
        "label": "Upscaling",
        "style": "cards",
        "params": [
          {
            "path": "upscaling.model",
            "label": "Model",
            "style": "title",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "workflow_nodes.LatentUpscaleModelLoader.model_name",
            "label": "Model",
            "style": "title",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "workflow_nodes.SeedVR2LoadDiTModel.model",
            "label": "Model",
            "style": "hidden",
            "color": {
              "text": "#fec43e",
              "bg": "rgba(0, 0, 0, 0.12)"
            },
            "_prevStyle": "title"
          },
          {
            "path": "workflow_nodes.SeedVR2LoadVAEModel.model",
            "label": "VAE",
            "style": "detail",
            "color": {
              "text": "#ffaeff"
            }
          },
          {
            "path": "upscaling.upscale_method",
            "label": "Method",
            "style": "detail",
            "color": {
              "bg": "rgba(0, 0, 0, 0.12)"
            }
          },
          {
            "path": "upscaling.type",
            "label": "Type",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.ImageResizeKJv2.upscale_method",
            "label": "Method",
            "style": "hidden",
            "match": {
              "title": "Resize Image v2"
            },
            "_prevStyle": "detail",
            "color": {}
          },
          {
            "path": "workflow_nodes.ImageResizeKJv2.upscale_method",
            "label": "Upscale Method",
            "style": "hidden",
            "match": {
              "title": "Resize Image"
            },
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.ImageScaleToTotalPixels.upscale_method",
            "label": "Method",
            "style": "hidden",
            "match": {
              "title": "Scale Image to Total Pixels"
            },
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.ImageScaleToTotalPixels.upscale_method",
            "label": "Upscale Method",
            "style": "hidden",
            "match": {
              "index": 0
            },
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.ImageScaleToTotalPixels.upscale_method",
            "label": "Upscale Method",
            "style": "hidden",
            "match": {
              "index": 1
            },
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.ResizeImageMaskNode.scale_method",
            "label": "Scale Method",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.CR Aspect Ratio Social Media.upscale_factor",
            "label": "Factor",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.SeedVR2LoadVAEModel.decode_tile_size",
            "label": "Decode Tile Size",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.SeedVR2LoadVAEModel.decode_tile_overlap",
            "label": "Decode Tile Overlap",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.SeedVR2LoadVAEModel.encode_tile_size",
            "label": "Encode Tile Size",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.SeedVR2LoadVAEModel.encode_tile_overlap",
            "label": "Encode Tile Overlap",
            "style": "detail"
          },
          {
            "path": "extra.hires_cfg_scale",
            "label": "Hires Cfg Scale",
            "style": "detail"
          },
          {
            "path": "extra.hires_upscale",
            "label": "Factor",
            "style": "detail"
          },
          {
            "path": "extra.hires_upscaler",
            "label": "Hires Upscaler",
            "style": "hidden",
            "_prevStyle": "detail"
          },
          {
            "path": "upscaling.width",
            "label": "Width",
            "style": "detail"
          },
          {
            "path": "upscaling.height",
            "label": "Height",
            "style": "detail"
          },
          {
            "path": "generation_resolution",
            "label": "Initial Resolution",
            "style": "detail"
          },
          {
            "path": "upscaling.scale_by",
            "label": "Scale By",
            "style": "detail"
          }
        ],
        "showWhen": "upscaling.model"
      }
    ],
    "hidden": false
  },
  {
    "id": "s_mpusgpqo_0",
    "title": "LLM",
    "style": "flat",
    "open": true,
    "params": [],
    "highlow": false,
    "hidden": false,
    "tabs": [
      {
        "id": "tab_mpxw5c4m_1",
        "label": "LLava",
        "style": "flat",
        "params": [
          {
            "path": "workflow_nodes.LLava Loader Simple.ckpt_name",
            "label": "Model",
            "style": "title",
            "format": "{v}",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.ckpt_name",
            "label": "Ckpt Name",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerSimple.max_tokens",
            "label": "Max Tokens",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.max_tokens",
            "label": "Max Tokens",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.max_tokens",
            "label": "Max Tokens",
            "style": "pill",
            "format": "Tokens: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.temperature",
            "label": "Temperature",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerSimple.temperature",
            "label": "Temperature",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.temperature",
            "label": "Temperature",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Temp: {v}"
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.top_p",
            "label": "Top P",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.top_p",
            "label": "Top P",
            "style": "pill",
            "format": "Top P: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.top_k",
            "label": "Top K",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.top_k",
            "label": "Top K",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Top K: {v}"
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.frequency_penalty",
            "label": "Frequency Penalty",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.frequency_penalty",
            "label": "Frequency Penalty",
            "style": "pill",
            "format": "Frequency: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.presence_penalty",
            "label": "Presence Penalty",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.presence_penalty",
            "label": "Presence Penalty",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Presence: {v}"
          },
          {
            "path": "workflow_nodes.LLavaOptionalMemoryFreeAdvanced.repeat_penalty",
            "label": "Repeat Penalty",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.repeat_penalty",
            "label": "Repeat Penalty",
            "style": "pill",
            "format": "Repeat: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.system_msg",
            "label": "System Msg",
            "style": "text",
            "color": {
              "bg": "rgba(255, 255, 255, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.LLavaSamplerAdvanced.prompt",
            "label": "Prompt",
            "style": "text",
            "color": {
              "bg": "rgba(24, 52, 37, 0.75)"
            }
          },
          {
            "path": "workflow_nodes.easy showAnything.text",
            "label": "Output",
            "style": "text",
            "match": {
              "title": "Show Any"
            },
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.ShowText|pysssss.text",
            "label": "Output",
            "style": "text",
            "match": {
              "title": "Output"
            },
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          }
        ],
        "pillColor": {
          "bg": "#242424"
        },
        "showWhen": "workflow_nodes.LLava Loader Simple.ckpt_name"
      },
      {
        "id": "tab_mpwr9up6_0",
        "label": "QwenVL",
        "style": "flat",
        "params": [
          {
            "path": "workflow_nodes.AILab_QwenVL_GGUF_PromptEnhancer.model_name",
            "label": "Model",
            "style": "title",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "workflow_nodes.AILab_QwenVL_GGUF_PromptEnhancer.max_tokens",
            "label": "Max Tokens",
            "style": "pill",
            "format": "Tokens: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)",
              "border": "rgba(125, 107, 239, 0)"
            }
          },
          {
            "path": "workflow_nodes.AILab_QwenVL_GGUF_PromptEnhancer.temperature",
            "label": "Temperature",
            "style": "pill",
            "format": "Temp: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)",
              "border": "rgba(125, 107, 239, 0)"
            }
          },
          {
            "path": "workflow_nodes.AILab_QwenVL_GGUF_PromptEnhancer.top_p",
            "label": "Top P",
            "style": "pill",
            "format": "Top P: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)",
              "border": "rgba(125, 107, 239, 0)"
            }
          },
          {
            "path": "workflow_nodes.AILab_QwenVL_GGUF_PromptEnhancer.repetition_penalty",
            "label": "Repetition Penalty",
            "style": "pill",
            "format": "Repetition: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)",
              "border": "rgba(125, 107, 239, 0)"
            }
          },
          {
            "path": "workflow_nodes.AILab_QwenVL_GGUF_PromptEnhancer.custom_system_prompt",
            "label": "System Prompt",
            "style": "text",
            "color": {
              "bg": "rgba(255, 255, 255, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.AILab_QwenVL_GGUF_PromptEnhancer.prompt_text",
            "label": "User Prompt",
            "style": "hidden",
            "_prevStyle": "text"
          },
          {
            "path": "workflow_nodes.ShowText|pysssss.text",
            "label": "Text",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "workflow_nodes.ShowText|pysssss.text_0",
            "label": "Text 0",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "workflow_nodes.ShowText|pysssss.text_undefined",
            "label": "Text Undefined",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "workflow_nodes.easy showAnything.text",
            "label": "Output",
            "style": "hidden",
            "_prevStyle": "text"
          }
        ],
        "color": {},
        "pillColor": {}
      },
      {
        "id": "tab_mpwrfbaa_1",
        "label": "JoyCaption",
        "style": "flat",
        "params": [
          {
            "path": "workflow_nodes.JC_GGUF_adv.model",
            "label": "Model",
            "style": "title",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "workflow_nodes.JC_GGUF_adv.max_new_tokens",
            "label": "Max Tokens",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Tokens: {v}"
          },
          {
            "path": "workflow_nodes.JC_GGUF_adv.temperature",
            "label": "Temperature",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Temp: {v}"
          },
          {
            "path": "workflow_nodes.JC_GGUF_adv.top_p",
            "label": "Top P",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Top P: {v}"
          },
          {
            "path": "workflow_nodes.JC_GGUF_adv.top_k",
            "label": "Top K",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Top K: {v}"
          },
          {
            "path": "workflow_nodes.JC_GGUF_adv.custom_prompt",
            "label": "System Prompt",
            "style": "text",
            "color": {
              "bg": "rgba(255, 255, 255, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.easy showAnything.anything",
            "label": "Output",
            "style": "text",
            "color": {}
          },
          {
            "path": "workflow_nodes.easy showAnything.text",
            "label": "Output",
            "style": "text",
            "match": {
              "title": "JoyCaption Output"
            },
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          }
        ],
        "showWhen": "workflow_nodes.JC_GGUF_adv.model"
      },
      {
        "id": "tab_mq93pdk6_0",
        "label": "VLM",
        "style": "flat",
        "params": [
          {
            "path": "workflow_nodes.LLMPromptGenerator.max_tokens",
            "label": "Max Tokens",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLMPromptGenerator.temperature",
            "label": "Temperature",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLMPromptGenerator.top_p",
            "label": "Top P",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLMPromptGenerator.top_k",
            "label": "Top K",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLMPromptGenerator.frequency_penalty",
            "label": "Frequency Penalty",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLMPromptGenerator.presence_penalty",
            "label": "Presence Penalty",
            "style": "detail"
          },
          {
            "path": "workflow_nodes.LLMPromptGenerator.repeat_penalty",
            "label": "Repeat Penalty",
            "style": "detail"
          }
        ]
      },
      {
        "id": "tab_mqm0aaft_0",
        "label": "TextGenerate",
        "style": "flat",
        "params": [
          {
            "path": "clip_models",
            "label": "Clip Models",
            "style": "title",
            "color": {
              "text": "#fec43e"
            }
          },
          {
            "path": "workflow_nodes.TextGenerate.max_length",
            "label": "Max Length",
            "style": "pill",
            "color": {
              "text": "#ffffff",
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Max: {v}"
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode.temperature",
            "label": "Temperature",
            "style": "pill",
            "format": "Temp: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode.top_k",
            "label": "Top K",
            "style": "pill",
            "format": "Top K: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode.top_p",
            "label": "Top P",
            "style": "pill",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Top P: {v}"
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode.min_p",
            "label": "Min P",
            "style": "pill",
            "format": "Min P: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode.repetition_penalty",
            "label": "Repetition Penalty",
            "style": "pill",
            "format": "Rep: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode.presence_penalty",
            "label": "Presence Penalty",
            "style": "hidden",
            "format": "Presence: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "_prevStyle": "pill"
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode",
            "label": "Sampling Mode",
            "style": "hidden",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "format": "Sampling: {v}",
            "_prevStyle": "pill"
          },
          {
            "path": "workflow_nodes.TextGenerate.thinking",
            "label": "Thinking",
            "style": "hidden",
            "format": "Thinking: {v}",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            },
            "_prevStyle": "pill"
          },
          {
            "path": "workflow_nodes.TextGenerate.use_default_template",
            "label": "Use Default Template",
            "style": "hidden",
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.TextGenerate.sampling_mode.seed",
            "label": "Seed",
            "style": "hidden",
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.TextGenerate.prompt",
            "label": "Prompt",
            "style": "text",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "workflow_nodes.easy showAnything.text",
            "label": "Output",
            "style": "text",
            "color": {
              "bg": "rgba(254, 196, 62, 0.25)"
            }
          }
        ],
        "showWhen": "workflow_nodes.TextGenerate"
      }
    ]
  },
  {
    "id": "positive",
    "title": "Positive Prompt",
    "style": "text",
    "open": true,
    "params": [],
    "color": {
      "bg": "#162a1f",
      "border": "rgba(33, 196, 93, 0.25)",
      "text": "#e0e0ff"
    },
    "tabs": [
      {
        "id": "tab_mpwso1um_0",
        "label": "Initial",
        "style": "text",
        "params": [
          {
            "path": "initial_prompt",
            "label": "Initial Prompt",
            "style": "text",
            "color": {
              "bg": "rgba(24, 52, 37, 0)"
            }
          }
        ],
        "pillColor": {
          "border": "rgba(255, 255, 255, 0)",
          "bg": "rgba(255, 255, 255, 0.1)",
          "text": "#999999"
        }
      },
      {
        "id": "tab_mpwsoi7k_1",
        "label": "Enhanced",
        "style": "text",
        "params": [
          {
            "path": "positive_prompt",
            "label": "Positive Prompt",
            "style": "text",
            "color": {
              "bg": "rgba(24, 52, 37, 0)"
            }
          }
        ],
        "pillColor": {
          "border": "rgba(255, 255, 255, 0)",
          "bg": "rgba(255, 255, 255, 0.1)"
        }
      }
    ]
  },
  {
    "id": "negative",
    "title": "Negative Prompt",
    "style": "text",
    "open": true,
    "params": [
      {
        "path": "negative_prompt",
        "label": "Negative Prompt",
        "style": "text",
        "color": {
          "bg": "rgba(59, 28, 33, 0)"
        }
      }
    ],
    "color": {
      "bg": "#2a181b",
      "border": "rgba(239, 68, 68, 0.25)"
    }
  },
  {
    "id": "workflow_nodes",
    "title": "Workflow Nodes",
    "style": "nodes",
    "open": false,
    "params": [],
    "hidden": false
  },
  {
    "id": "extra",
    "title": "Extra Metadata",
    "style": "flat",
    "open": false,
    "params": [
      {
        "path": "extra.*"
      }
    ],
    "hidden": true
  },
  {
    "id": "raw",
    "title": "Raw Metadata",
    "style": "raw",
    "open": false,
    "params": [],
    "hidden": true
  }
];

export const DEFAULT_VIDEO_LAYOUT = [
  {
    "id": "file_info",
    "title": "File Info",
    "style": "flat",
    "open": true,
    "params": [
      {
        "path": "filename",
        "label": "",
        "style": "kv"
      },
      {
        "path": "path",
        "label": "Path",
        "_prevStyle": "kv",
        "style": "hidden"
      },
      {
        "path": "filesize",
        "label": "Size",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "resolution",
        "label": "Resolution",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "duration",
        "label": "Duration",
        "style": "pill",
        "format": "{v}s",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "codec",
        "label": "Codec",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "fps",
        "label": "FPS",
        "style": "pill",
        "format": "{v}FPS",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "total_frames",
        "label": "Frames",
        "style": "hidden",
        "format": "{v}Frames",
        "_prevStyle": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "modified",
        "label": "Modified",
        "_prevStyle": "kv",
        "style": "hidden"
      }
    ]
  },
  {
    "id": "models",
    "title": "Models",
    "style": "cards",
    "open": true,
    "params": [
      {
        "path": "model",
        "label": "Model",
        "style": "title",
        "color": {
          "bg": "rgba(0, 0, 0, 0)",
          "text": "#fec43e"
        }
      },
      {
        "path": "clip_models",
        "label": "",
        "style": "detail",
        "color": {
          "bg": "rgba(36, 36, 36, 0)"
        }
      },
      {
        "path": "vae",
        "label": "",
        "style": "detail",
        "color": {
          "bg": "rgba(36, 36, 36, 0)"
        }
      }
    ],
    "highlow": true
  },
  {
    "id": "sampling",
    "title": "Sampling",
    "style": "cards",
    "open": true,
    "source": "samplers",
    "highlow": true,
    "params": [
      {
        "path": "label",
        "style": "hidden",
        "_prevStyle": "title"
      },
      {
        "path": "samplers.sampler_name",
        "label": "Sampler",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.scheduler",
        "label": "Scheduler",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.cfg",
        "label": "CFG",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        },
        "format": "CFG: {v}"
      },
      {
        "path": "samplers.steps",
        "label": "Steps",
        "style": "pill",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        },
        "format": "Steps: {v}"
      },
      {
        "path": "samplers.shift",
        "label": "Shift",
        "style": "pill",
        "format": "Shift: {v}",
        "color": {
          "bg": "rgba(255, 255, 255, 0.2)"
        }
      },
      {
        "path": "samplers.start_at_step",
        "label": "Start At Step",
        "style": "detail"
      },
      {
        "path": "samplers.end_at_step",
        "label": "End At Step",
        "style": "detail"
      },
      {
        "path": "samplers.denoise",
        "label": "Denoise",
        "style": "pill",
        "format": "Denoise: {v}",
        "color": {}
      },
      {
        "path": "samplers.add_noise",
        "label": "Add Noise",
        "style": "hidden",
        "format": "Add Noise: {v}",
        "_prevStyle": "detail"
      },
      {
        "path": "samplers.return_with_leftover_noise",
        "label": "Return With Leftover Noise",
        "style": "hidden",
        "_prevStyle": "detail"
      },
      {
        "path": "samplers.seed",
        "label": "Seed",
        "style": "detail"
      }
    ]
  },
  {
    "id": "loras",
    "title": "LoRAs",
    "style": "cards",
    "open": true,
    "source": "loras",
    "highlow": true,
    "params": [
      {
        "path": "loras.name",
        "label": "Name",
        "style": "title"
      },
      {
        "path": "loras.strength_model",
        "label": "Strength",
        "style": "pill",
        "format": "Strength: {v}",
        "color": {}
      }
    ],
    "hidden": false
  },
  {
    "id": "s_mpxnozz4_0",
    "title": "Features",
    "style": "flat",
    "open": true,
    "params": [],
    "tabs": [
      {
        "id": "tab_mpxnpbof_1",
        "label": "MMAudio",
        "style": "cards",
        "params": [
          {
            "path": "mmaudio.prompt",
            "label": "Prompt",
            "style": "text",
            "color": {
              "bg": "#183425"
            }
          },
          {
            "path": "mmaudio.negative_prompt",
            "label": "Negative Prompt",
            "style": "text",
            "color": {
              "bg": "#3b1c21"
            }
          },
          {
            "path": "mmaudio.cfg",
            "label": "Cfg",
            "style": "pill",
            "format": "CFG: {v}",
            "color": {
              "bg": "rgba(37, 213, 248, 0.3)",
              "text": "#ffffff"
            }
          },
          {
            "path": "mmaudio.steps",
            "label": "Steps",
            "style": "pill",
            "color": {
              "text": "#ffffff",
              "bg": "rgba(37, 213, 248, 0.3)"
            },
            "format": "Steps: {v}"
          },
          {
            "path": "mmaudio.seed",
            "label": "Seed",
            "style": "detail"
          }
        ],
        "source": "mmaudio",
        "pillColor": {
          "bg": "rgba(255, 255, 255, 0.05)",
          "border": "rgba(255, 255, 255, 0)",
          "text": "#999999"
        }
      },
      {
        "id": "tab_mpxnszr6_2",
        "label": "Interpolation",
        "style": "cards",
        "params": [
          {
            "path": "interpolation.type",
            "label": "Type",
            "style": "title",
            "color": {
              "bg": "rgba(0, 0, 0, 0)",
              "text": "#fec43e"
            }
          },
          {
            "path": "interpolation.model_name",
            "label": "Model",
            "style": "title",
            "color": {
              "bg": "rgba(0, 0, 0, 0)",
              "text": "#fec43e"
            }
          },
          {
            "path": "interpolation.ckpt_name",
            "label": "Model",
            "style": "title",
            "color": {
              "text": "#fec43e",
              "bg": "rgba(0, 0, 0, 0)"
            }
          },
          {
            "path": "interpolation.multiplier",
            "label": "Multiplier",
            "style": "detail"
          },
          {
            "path": "interpolation.scale",
            "label": "Scale",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "interpolation.source_fps",
            "label": "Source FPS",
            "style": "pill",
            "format": "Source FPS: {v}",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "interpolation.target_fps",
            "label": "Target FPS",
            "style": "pill",
            "format": "Final FPS: {v}",
            "color": {
              "bg": "rgba(255, 255, 255, 0.2)"
            }
          },
          {
            "path": "total_frames",
            "label": "Total Frames",
            "style": "hidden",
            "_prevStyle": "detail"
          }
        ],
        "pillColor": {
          "bg": "rgba(255, 255, 255, 0.05)",
          "border": "rgba(255, 255, 255, 0)"
        }
      },
      {
        "id": "tab_mpxny7vj_3",
        "label": "Upscaling",
        "style": "cards",
        "params": [
          {
            "path": "upscaling.model",
            "label": "Model",
            "style": "title",
            "color": {
              "bg": "rgba(0, 0, 0, 0)",
              "text": "#fec43e"
            }
          },
          {
            "path": "upscaling.type",
            "label": "Type",
            "style": "kv",
            "color": {}
          },
          {
            "path": "upscaling.upscale_method",
            "label": "Upscale Method",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.ImageResizeKJv2.upscale_method",
            "label": "Upscale Method",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.ImageScaleToTotalPixels.upscale_method",
            "label": "Upscale Method",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.ResizeImageMaskNode.scale_method",
            "label": "Scale Method",
            "style": "kv"
          },
          {
            "path": "controlnet.resize_mode",
            "label": "Resize Mode",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.ImageCompositeMasked.resize_source",
            "label": "Resize Source",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.JWFloatToInteger.mode",
            "label": "Mode",
            "style": "kv"
          },
          {
            "path": "generation_resolution",
            "label": "Initial Resolution",
            "style": "detail"
          },
          {
            "path": "resolution",
            "label": "Final Resolution",
            "style": "detail"
          },
          {
            "path": "upscaling.width",
            "label": "Width",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "upscaling.height",
            "label": "Height",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "width",
            "label": "Width",
            "style": "hidden",
            "_prevStyle": "detail"
          },
          {
            "path": "height",
            "label": "Height",
            "style": "hidden",
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.ImageResizeKJv2.width",
            "label": "Width",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "workflow_nodes.ImageResizeKJv2.height",
            "label": "Height",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "workflow_nodes.WanVideoImageResizeToClosest.generation_width",
            "label": "Generation Width",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "workflow_nodes.WanVideoImageResizeToClosest.generation_height",
            "label": "Generation Height",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "workflow_nodes.WanImageToVideo.width",
            "label": "Width",
            "style": "pill"
          },
          {
            "path": "workflow_nodes.WanImageToVideo.height",
            "label": "Height",
            "style": "pill"
          },
          {
            "path": "workflow_nodes.ResizeImagesByLongerEdge.longer_edge",
            "label": "Longer Edge",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.WanVaceToVideo.width",
            "label": "Width",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.WanVaceToVideo.height",
            "label": "Height",
            "style": "kv"
          },
          {
            "path": "interpolation.scale",
            "label": "Scale",
            "style": "hidden",
            "_prevStyle": "detail"
          },
          {
            "path": "workflow_nodes.CR Aspect Ratio Social Media.upscale_factor",
            "label": "Upscale Factor",
            "style": "kv"
          },
          {
            "path": "workflow_nodes.mxSlider.Xi",
            "label": "Xi",
            "style": "hidden",
            "_prevStyle": "kv"
          },
          {
            "path": "upscaling.resolution",
            "label": "Resolution",
            "style": "kv"
          },
          {
            "path": "upscaling.scale_by",
            "label": "Scale By",
            "style": "kv"
          }
        ],
        "pillColor": {
          "bg": "rgba(255, 255, 255, 0.05)",
          "border": "rgba(255, 255, 255, 0)"
        },
        "showWhen": "upscaling"
      }
    ],
    "hidden": false
  },
  {
    "id": "positive",
    "title": "Positive Prompt",
    "style": "text",
    "open": true,
    "params": [
      {
        "path": "positive_prompt",
        "label": "Positive",
        "style": "text",
        "color": {
          "text": "#e0e0ff",
          "bg": "#183425"
        }
      }
    ],
    "color": {
      "bg": "#162a1f",
      "border": "rgba(34, 197, 94, 0.25)"
    }
  },
  {
    "id": "negative",
    "title": "Negative Prompt",
    "style": "text",
    "open": false,
    "params": [
      {
        "path": "negative_prompt",
        "label": "Negative",
        "style": "text",
        "variant": "neg",
        "color": {
          "bg": "#3b1c21"
        }
      }
    ],
    "color": {
      "bg": "#2a181b",
      "border": "rgba(239, 68, 68, 0.25)"
    }
  },
  {
    "id": "controlnet",
    "title": "ControlNet",
    "style": "cards",
    "open": false,
    "source": "controlnet",
    "params": [
      {
        "path": "model",
        "style": "title"
      },
      {
        "path": "preprocessor",
        "label": "prep",
        "style": "pill",
        "format": "prep: {v}"
      },
      {
        "path": "strength",
        "label": "strength",
        "style": "pill",
        "format": "str {v}"
      },
      {
        "path": "weight",
        "label": "weight",
        "style": "pill",
        "format": "w {v}"
      },
      {
        "path": "start_percent",
        "label": "start",
        "style": "pill",
        "format": "start {v}"
      },
      {
        "path": "end_percent",
        "label": "end",
        "style": "pill",
        "format": "end {v}"
      },
      {
        "path": "guidance_start",
        "label": "start",
        "style": "pill",
        "format": "start {v}"
      },
      {
        "path": "guidance_end",
        "label": "end",
        "style": "pill",
        "format": "end {v}"
      }
    ],
    "hidden": true
  },
  {
    "id": "adetailer",
    "title": "ADetailer",
    "style": "cards",
    "open": false,
    "source": "adetailer",
    "params": [
      {
        "path": "model",
        "style": "title"
      },
      {
        "path": "steps",
        "label": "steps",
        "style": "pill",
        "format": "{v} steps"
      },
      {
        "path": "cfg",
        "label": "cfg",
        "style": "pill",
        "format": "CFG {v}"
      },
      {
        "path": "denoise",
        "label": "denoise",
        "style": "pill",
        "format": "denoise {v}"
      }
    ],
    "hidden": true
  },
  {
    "id": "workflow_nodes",
    "title": "Workflow Nodes",
    "style": "nodes",
    "open": false,
    "params": [],
    "hidden": false
  },
  {
    "id": "extra",
    "title": "Extra Metadata",
    "style": "flat",
    "open": false,
    "params": [
      {
        "path": "extra.*"
      }
    ],
    "hidden": false
  },
  {
    "id": "raw",
    "title": "Raw Metadata",
    "style": "raw",
    "open": false,
    "params": [],
    "hidden": true
  }
];
