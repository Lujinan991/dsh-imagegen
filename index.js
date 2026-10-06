import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { randomUUID } from 'node:crypto';
import { requestImages, resolveRequest, validateConfig } from './image-api.js';

export const name = 'dsh-imagegen';
export const inject = ['tools', 'fs', 'attachments'];

/**
 * Whether a value is a live config reference rather than plain data.
 *
 * A schema marked `.volatile()` replaces config values with reference objects
 * that expose `get()`, so `config.baseUrl` is `undefined`. The framework's
 * `isVolatile` helper comes from a package this plugin does not declare, and
 * the Host only resolves declared packages for a bundle, so the reference is
 * recognized structurally instead. Every field of this Config is a scalar or an
 * array of scalars, so no plain value can be mistaken for a reference.
 * @param value - one config value or the whole config object.
 * @returns true when the value is a volatile reference.
 */
function isConfigRef(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.get === 'function';
}

/**
 * Read the current plain values out of a volatile Config tree.
 *
 * Both shapes the framework can produce are handled: an object-level reference
 * (the whole config is one reference, and `.get()` yields schema defaults merged
 * with the saved values) and field-level references (a plain object whose fields
 * are references). Reading per use lets a saved settings edit apply to the next
 * call without a remount.
 * @param config - the Config object handed to `apply`.
 * @returns a plain object with the current field values.
 */
export function readConfig(config) {
  const source = isConfigRef(config) ? config.get() : config;
  const values = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    values[key] = isConfigRef(value) ? value.get() : value;
  }
  return values;
}

export const Config = z.object({
  baseUrl: z.string().default('https://api.openai.com/v1').description('OpenAI-compatible API root, including /v1 when required.'),
  apiKey: z.string().role('secret').default('').description('Image API key. Never supplied by the model.'),
  apiKeyEnv: z.string().default('OPENAI_API_KEY').description('Environment variable used when apiKey is empty.'),
  model: z.string().default('gpt-image-2').description('Default image model. No silent model fallback.'),
  size: z.string().default('auto').description('WIDTHxHEIGHT for OpenAI models, or an aspect ratio such as 9:16 for providers that take a ratio.'),
  resolution: z.string().default('').description('Provider-specific resolution tier (for example 1k, 2k, 4k). Sent only when set.'),
  quality: z.union(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).default('auto'),
  background: z.union(['auto', 'opaque', 'transparent']).default('auto'),
  outputFormat: z.union(['auto', 'png', 'jpeg', 'webp']).default('auto').description('Omitted entirely when auto, because some providers reject unknown fields.'),
  submitMode: z.union(['sync', 'async']).default('sync').description('async posts to ?async=true and polls the task endpoint, for providers whose image API returns a task id.'),
  taskPollMs: z.number().min(1).default(4000).description('Delay between task status polls, in milliseconds.'),
  timeoutMs: z.number().min(1).default(300000).description('Maximum time for one paid API call, including polling and downloads.'),
  maxImages: z.number().min(1).max(10).default(4),
  maxImageBytes: z.number().min(1).default(52428800),
  maxResponseBytes: z.number().min(1).default(150000000),
  downloadHosts: z.array(z.string()).default([]).description('Exact trusted HTTPS hosts for URL-based image results. The API host itself is always allowed; API keys are never sent to other hosts.'),
}).volatile();

const attachmentSchema = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: {
      width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
    } },
  },
};

export function resultContent(value) {
  const text = [
    `${value.mode === 'edit' ? 'Edited' : 'Generated'} ${value.images.length} image(s) using ${value.model}.`,
    `Prompt: ${value.prompt}`,
    ...value.images.map((image, i) => `${i + 1}. ${image.name}${image.path ? `: ${image.path}` : ''}${image.revisedPrompt ? `\nRevised prompt: ${image.revisedPrompt}` : ''}`),
    'Original bytes are durably saved. Copy the returned original path into the workspace with the normal authorized filesystem/shell tools when used as a project asset; never overwrite existing assets without permission.',
    ...(value.modelCanView ? [] : ['The current chat model does not declare image input; previews remain available in the image result card. Do not claim to have inspected the pixels.']),
  ].join('\n');
  return [{ type: 'text', text }, ...value.images.map(image => ({
    type: 'image', attachment: { ...image.preview, attachmentId: AttachmentId(image.preview.attachmentId) },
  }))];
}

export function apply(ctx, config) {
  const initial = readConfig(config);
  validateConfig(initial);
  ctx.tools.register(defineTool({
    name: 'generate_image',
    timeoutMs: initial.timeoutMs,
    description: 'Generate or edit raster images using the configured image API. Use edit with image_paths for reference images or edits, and optionally a PNG mask. One call produces variants of one prompt; call separately for distinct assets. Saves original images durably and returns paths plus previews. Does not silently switch models or retry paid requests.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete visual specification. Preserve exact text and list edit invariants.' },
      mode: { type: 'string', enum: ['generate', 'edit'], description: 'Defaults to edit when image_paths is supplied, otherwise generate.' },
      image_paths: { type: 'array', items: { type: 'string' }, description: '1-16 local images resolved by the DSH filesystem relative to the session workspace.' },
      mask_path: { type: 'string', description: 'PNG alpha mask for the first edit image; transparent pixels indicate the area to change.' },
      n: { type: 'integer', description: 'Variants of this prompt, limited by plugin maxImages.' },
      model: { type: 'string', description: 'Override only when the user explicitly chooses a model.' },
      size: { type: 'string', description: 'auto, WIDTHxHEIGHT, or an aspect ratio such as 9:16 when the configured provider takes a ratio.' },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
      background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
      output_format: { type: 'string', enum: ['auto', 'png', 'jpeg', 'webp'], description: 'auto omits the field so the provider default applies.' },
      output_compression: { type: 'integer', description: 'JPEG/WebP only, 0-100.' },
      input_fidelity: { type: 'string', enum: ['low', 'high'], description: 'Edit-only on supported older models; never use with gpt-image-2.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        mode: { type: 'string', required: true },
        model: { type: 'string', required: true },
        prompt: { type: 'string', required: true },
        modelCanView: { type: 'boolean', required: true },
        images: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          revisedPrompt: { type: 'string', required: true },
          original: { type: 'object', required: true, additionalProperties: false, properties: {
            attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
          } },
          preview: attachmentSchema,
        } } },
      } },
      render: (_args, value) => resultContent(value),
      presentationMeta: (_args, value) => ({ version: 1, mode: value.mode, model: value.model, images: value.images }),
    },
    isConcurrencySafe: () => true,
    presentCall(args) { return { card: 'generic', title: args.mode === 'edit' || args.image_paths?.length ? 'Edit image' : 'Generate image', rawInput: args.prompt }; },
    async execute(args, exec) {
      // Read live values so a saved settings edit applies to the next call.
      const live = readConfig(config);
      validateConfig(live);
      const request = resolveRequest(args, live);
      if (request.body.n > ctx.attachments.imageLimits.maxImagesPerMessage) {
        throw new Error('Requested variants exceed the DSH attachment image-count limit.');
      }
      let modelCanView = false;
      const route = exec.agent?.session.requestHeader()?.config;
      const provider = route?.provider ?? exec.agent?.options.provider;
      const model = route?.model ?? exec.agent?.options.model;
      const llm = ctx.get('llm');
      if (llm && provider && model) {
        const info = await llm.resolveModelInfo(provider, model, exec.signal);
        modelCanView = info.inputModalities?.includes('image') === true;
      }
      const images = await requestImages(request, live, {
        signal: exec.signal,
        async readImage(path, signal, limit) {
          const target = await ctx.fs.resolve(path, { cwd: exec.agent?.session.header.cwd, signal });
          return ctx.fs.readBytes(target, signal, limit);
        },
      });
      exec.signal.throwIfAborted();
      const prefix = `image-${randomUUID()}`;
      const inputs = images.map((image, index) => ({
        data: image.data, mediaType: image.mediaType,
        name: `${prefix}-${index + 1}.${image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.split('/')[1]}`,
      }));
      // Preserve originals before preview normalization can resize or recompress them.
      const originals = [];
      for (const input of inputs) {
        exec.signal.throwIfAborted();
        originals.push(await ctx.attachments.saveFile({ data: input.data, name: input.name }));
      }
      const previews = await ctx.attachments.saveImages(inputs);
      return {
        mode: request.mode, model: request.body.model, prompt: request.body.prompt, modelCanView,
        images: previews.map((preview, index) => ({
          name: inputs[index].name,
          path: ctx.attachments.fileHostPath(originals[index]) ?? '',
          revisedPrompt: images[index].revisedPrompt,
          original: originals[index], preview,
        })),
      };
    },
  }));
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.systemPrompt.section({
      name: 'dsh-imagegen:workflow', order: 75,
      text: 'For bitmap generation and edits use generate_image, not SVG placeholders. Structure prompts around the user request, scene, subject, style, composition, lighting, verbatim text, and constraints. Do not invent brands, extra objects, or unrelated creative requirements. For edits state what changes and what must stay unchanged. Reference images use edit mode with a role for each image in the prompt. Distinct assets require separate calls; n creates variants of one prompt. Inspect results only when image input is supported; otherwise report that visual verification was not performed. Keep originals and alpha. Never silently switch models or automatically retry paid calls. Report saved paths and the final prompt. Copy project assets into the workspace using authorized file tools and use versioned names instead of overwriting existing files.',
    });
  });
}
