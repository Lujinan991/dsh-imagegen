import { basename } from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-image-2';

/** Terminal task statuses, in the spellings the supported providers use. */
const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'DONE']);
const FAILURE_STATUSES = new Set(['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED']);

export function validateConfig(config) {
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  if (baseUrl !== '') {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('baseUrl must be an HTTP(S) API URL without credentials, query, or fragment.');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Remote APIs must use HTTPS. HTTP is supported only for localhost.');
    }
  }
  for (const key of ['timeoutMs', 'maxImageBytes', 'maxResponseBytes', 'maxImages', 'taskPollMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer.`);
  }
  if (config.maxImages > 10) throw new Error('maxImages cannot exceed 10.');
  if (!['sync', 'async'].includes(config.submitMode)) throw new Error('submitMode must be sync or async.');
  for (const host of config.downloadHosts ?? []) {
    const parsed = new URL(`https://${host}`);
    if (parsed.host !== host || parsed.pathname !== '/' || parsed.username || parsed.password) {
      throw new Error('downloadHosts must contain exact HTTPS hostnames, optionally with a port.');
    }
  }
  return config;
}

export function sniffImage(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('The API or input file is not a PNG, JPEG, or WebP image.');
}

export function resolveRequest(args, config) {
  if (!args.prompt?.trim()) throw new Error('prompt must not be empty.');
  const images = args.image_paths ?? [];
  const mode = args.mode ?? (images.length ? 'edit' : 'generate');
  if (!['generate', 'edit'].includes(mode)) throw new Error('mode must be generate or edit.');
  if (mode === 'generate' && images.length) throw new Error('Use edit mode for reference images.');
  if (mode === 'edit' && (!images.length || images.length > 16)) throw new Error('edit requires 1 to 16 input images.');
  if (args.mask_path && mode !== 'edit') throw new Error('mask_path is available only in edit mode.');
  const n = args.n ?? 1;
  if (!Number.isSafeInteger(n) || n < 1 || n > config.maxImages) throw new Error(`n must be between 1 and ${config.maxImages}.`);
  const model = args.model ?? config.model;
  // `size` is WIDTHxHEIGHT for OpenAI models and an aspect ratio such as 9:16
  // for providers that take a ratio, so only the shapes this plugin knows are
  // policed; anything else is passed through for the API to accept or refuse.
  const size = args.size ?? config.size;
  const quality = args.quality ?? config.quality;
  const output_format = args.output_format ?? config.outputFormat;
  const background = args.background ?? config.background;
  const resolution = config.resolution ?? '';
  if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) throw new Error('Invalid quality.');
  if (!['auto', 'png', 'jpeg', 'webp'].includes(output_format)) throw new Error('Invalid output_format.');
  if (!['auto', 'opaque', 'transparent'].includes(background)) throw new Error('Invalid background.');
  if (background === 'transparent' && output_format === 'jpeg') throw new Error('JPEG cannot preserve transparency.');
  // A model id alone does not prove the pixel contract: third-party providers
  // reuse OpenAI names while defining `size` as an aspect ratio, so the strict
  // pixel rules apply only to a WIDTHxHEIGHT value. Anything else is a ratio
  // the provider itself must accept or refuse.
  const pixels = /^(\d+)x(\d+)$/.exec(size);
  if (model === 'gpt-image-2') {
    if (background === 'transparent') throw new Error('gpt-image-2 does not support native transparency. Choose a transparency-capable model explicitly.');
    if (args.input_fidelity) throw new Error('gpt-image-2 does not accept input_fidelity.');
    if (pixels !== null) {
      const [w, h] = pixels.slice(1).map(Number);
      if (w <= 0 || h <= 0 || w % 16 || h % 16 || Math.max(w, h) > 3840 || Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400) {
        throw new Error('gpt-image-2 size must use 16px increments, at most 3840px per edge, a 3:1 ratio, and 655360-8294400 pixels; use auto or an aspect ratio for a provider that takes one.');
      }
    }
  } else if (['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini'].includes(model) && pixels !== null && !['1024x1024', '1536x1024', '1024x1536'].includes(size)) {
    throw new Error('This GPT Image model accepts auto, 1024x1024, 1536x1024, or 1024x1536; use an aspect ratio only on a provider that takes one.');
  }
  if (args.input_fidelity && mode !== 'edit') throw new Error('input_fidelity requires edit mode.');
  if (args.output_compression !== undefined && (!Number.isSafeInteger(args.output_compression) || args.output_compression < 0 || args.output_compression > 100 || !['jpeg', 'webp'].includes(output_format))) {
    throw new Error('output_compression must be 0-100 and requires an explicit jpeg or webp output_format.');
  }
  return {
    mode, images, mask: args.mask_path,
    body: {
      model, prompt: args.prompt, n, size, quality,
      // `auto` means "let the API choose", so the field is omitted rather than
      // sent: several providers reject parameters outside their own surface.
      ...(output_format === 'auto' ? {} : { output_format }),
      ...(background !== 'auto' ? { background } : {}),
      ...(resolution === '' ? {} : { resolution }),
      ...(args.input_fidelity ? { input_fidelity: args.input_fidelity } : {}),
      ...(args.output_compression !== undefined ? { output_compression: args.output_compression } : {}),
    },
  };
}

export async function readBounded(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error(`API response exceeds ${limit} bytes.`);
  }
  if (!response.body) throw new Error('Empty API response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`API response exceeds ${limit} bytes.`);
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function safeError(message, key) {
  return String(message).split(key).join('[REDACTED]').slice(0, 1500);
}

/** One image entry, normalized across the response shapes providers return. */
function imageEntry(item) {
  if (item === null || typeof item !== 'object') return undefined;
  if (typeof item.b64_json === 'string') {
    return { b64_json: item.b64_json, revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '' };
  }
  if (typeof item.url === 'string') {
    return { url: item.url, revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '' };
  }
  return undefined;
}

/**
 * Collect every image entry a response carries.
 *
 * Handles the OpenAI shape (`data: [{ b64_json | url }]`), a bare object under
 * `data`, and the shapes async providers use once a task completes
 * (`data.result_url`, `data.result.data[]`, `data.result.images[]`,
 * `data.images[]`, `result.data[]`).
 * @param payload - parsed JSON response body.
 * @returns the image entries in response order.
 */
export function imageEntriesOf(payload) {
  const found = [];
  const collect = (value) => {
    const entry = imageEntry(value);
    if (entry !== undefined) found.push(entry);
  };
  if (Array.isArray(payload?.data)) for (const item of payload.data) collect(item);
  if (Array.isArray(payload?.images)) for (const item of payload.images) collect(item);
  if (Array.isArray(payload?.result?.data)) for (const item of payload.result.data) collect(item);

  const data = payload?.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    collect(data);
    if (typeof data.result_url === 'string') found.push({ url: data.result_url, revised_prompt: '' });
    if (Array.isArray(data.images)) for (const item of data.images) collect(item);
    if (Array.isArray(data.result?.data)) for (const item of data.result.data) collect(item);
    if (Array.isArray(data.result?.images)) for (const item of data.result.images) collect(item);
    if (typeof data.result?.url === 'string') found.push({ url: data.result.url, revised_prompt: '' });
  }
  return found;
}

/**
 * The task id an async submission returned, across the shapes providers use.
 *
 * Only consulted when a response carries no image entry, so a synchronous
 * response that happens to have an `id` field is never mistaken for a task.
 * @param payload - parsed JSON response body.
 * @returns the task id, or undefined when the response is not a submission.
 */
export function taskIdOf(payload) {
  const candidates = [payload?.task_id, payload?.data?.task_id];
  if (Array.isArray(payload?.data)) for (const item of payload.data) candidates.push(item?.task_id);
  return candidates.find((value) => typeof value === 'string' && value !== '');
}

/** A bounded, abortable delay between task polls. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll one asynchronous image task until it reaches a terminal state.
 * @param options - API root, request headers, task id, config, and signal.
 * @returns the terminal task payload, which carries the result.
 */
export async function pollImageTask({ baseUrl, headers, taskId, config, signal, fetchImpl = fetch, key }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/images/tasks/${encodeURIComponent(taskId)}`;
  for (;;) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { method: 'GET', headers, signal, redirect: 'error' });
    const text = (await readBounded(response, 65536)).toString('utf8');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Image task ${taskId}: the poll endpoint returned a non-JSON response (HTTP ${response.status}). Response began with: ${safeError(text.slice(0, 120), key)}`);
    }
    const data = payload?.data ?? {};
    const status = String(data.status ?? payload?.status ?? '').toUpperCase();
    if (SUCCESS_STATUSES.has(status)) return payload;
    if (FAILURE_STATUSES.has(status)) {
      const reason = data.fail_reason ?? data.error ?? payload?.error?.message ?? 'no reason given';
      throw new Error(`Image task ${taskId} failed: ${safeError(typeof reason === 'string' ? reason : JSON.stringify(reason), key)}`);
    }
    if (response.status >= 400) {
      throw new Error(`Image task poll HTTP ${response.status}: ${safeError(text.slice(0, 200), key)}`);
    }
    if (status === '' && imageEntriesOf(payload).length > 0) return payload;
    await sleep(config.taskPollMs, signal);
  }
}

/**
 * Decide whether one result URL may be fetched, and whether it may carry the key.
 *
 * The host of the configured API endpoint is always allowed, because that host
 * already receives the credential. Any other host must be listed in
 * `downloadHosts` and is fetched without the key.
 * @param raw - the result URL.
 * @param config - plugin configuration.
 * @returns the URL and whether the credential may accompany it, or undefined.
 */
function allowedDownload(raw, config) {
  let download;
  try {
    download = new URL(raw);
  } catch {
    return undefined;
  }
  if (!['https:', 'http:'].includes(download.protocol) || download.username || download.password) return undefined;
  const provider = new URL(config.baseUrl);
  if (download.host === provider.host) return { url: download, withKey: true };
  if (download.protocol === 'https:' && (config.downloadHosts ?? []).includes(download.host)) return { url: download, withKey: false };
  return undefined;
}

export async function requestImages(request, config, { signal, readImage, fetchImpl = fetch }) {
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  if (baseUrl === '') {
    throw new Error('baseUrl is not configured. Open the Plugins page, then AI Image Generation, and set the API endpoint.');
  }
  const key = config.apiKey || process.env[config.apiKeyEnv];
  if (!key) throw new Error(`Configure apiKey in AI Image Generation or set ${config.apiKeyEnv} before starting DSH.`);
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let body;
  const headers = { Authorization: `Bearer ${key}` };
  if (request.mode === 'edit') {
    body = new FormData();
    for (const [field, value] of Object.entries(request.body)) body.set(field, String(value));
    for (const path of request.images) {
      combined.throwIfAborted();
      const data = Buffer.from(await readImage(path, combined, config.maxImageBytes));
      if (data.length > config.maxImageBytes) throw new Error('Input image exceeds maxImageBytes.');
      body.append('image[]', new Blob([data], { type: sniffImage(data) }), basename(path));
    }
    if (request.mask) {
      const data = Buffer.from(await readImage(request.mask, combined, config.maxImageBytes));
      if (sniffImage(data) !== 'image/png') throw new Error('Masks must be PNG with an alpha channel.');
      body.set('mask', new Blob([data], { type: 'image/png' }), basename(request.mask));
    }
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(request.body);
  }
  const path = `/images/${request.mode === 'edit' ? 'edits' : 'generations'}`;
  const url = `${baseUrl.replace(/\/+$/, '')}${path}${config.submitMode === 'async' ? '?async=true' : ''}`;
  // Never redirect a request carrying an API credential.
  const response = await fetchImpl(url, { method: 'POST', headers, body, signal: combined, redirect: 'error' });
  const text = (await readBounded(response, response.ok ? config.maxResponseBytes : 65536)).toString('utf8');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    combined.throwIfAborted();
    const contentType = response.headers.get('content-type') ?? 'no content type';
    // An HTML body served with HTTP 200 is the signature of a baseUrl that
    // points at a site root rather than the API root, so name that cause
    // instead of leaving the caller with an opaque parse failure.
    const hint = /^\s*</.test(text)
      ? ' The endpoint answered with a web page, so baseUrl is probably missing its API root path (for example a trailing /v1).'
      : '';
    throw new Error(`Image API HTTP ${response.status} (${contentType}): the response was not JSON.${hint} Response began with: ${safeError(text.slice(0, 200), key)}`, { cause: error });
  }
  if (!response.ok || payload?.error) {
    throw new Error(`Image API HTTP ${response.status}: ${safeError(payload?.error?.message ?? payload?.message ?? 'request failed', key)}`);
  }

  // Prefer a direct image; fall back to polling a task the API accepted.
  let entries = imageEntriesOf(payload);
  if (entries.length === 0) {
    const taskId = taskIdOf(payload);
    if (taskId === undefined) {
      throw new Error(`Image API returned neither an image nor a task id. Response: ${safeError(JSON.stringify(payload).slice(0, 300), key)}`);
    }
    const settled = await pollImageTask({ baseUrl, headers, taskId, config, signal: combined, fetchImpl, key });
    entries = imageEntriesOf(settled);
    if (entries.length === 0) {
      throw new Error(`Image task ${taskId} finished without an image: ${safeError(JSON.stringify(settled).slice(0, 300), key)}`);
    }
  }

  if (entries.length !== request.body.n) {
    throw new Error(`Image API returned ${entries.length} image(s) but ${request.body.n} were requested; no automatic paid retry was made.`);
  }

  const images = [];
  for (const item of entries) {
    combined.throwIfAborted();
    let data;
    if (typeof item.b64_json === 'string') {
      const value = item.b64_json;
      if (!value || value.length > Math.ceil(config.maxImageBytes / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new Error('Image API returned invalid or oversized base64.');
      }
      data = Buffer.from(value, 'base64');
      if (data.toString('base64') !== value) throw new Error('Image API returned non-canonical base64.');
    } else if (typeof item.url === 'string') {
      const allowed = allowedDownload(item.url, config);
      if (allowed === undefined) {
        throw new Error(`Image URL host is not allowed. List its exact hostname in downloadHosts, or use an API returning b64_json or a result on the API host. Host: ${new URL(item.url).host}`);
      }
      // A third-party CDN never receives the API key; redirects cannot escape.
      const downloadHeaders = allowed.withKey ? { Authorization: `Bearer ${key}` } : undefined;
      const imageResponse = await fetchImpl(allowed.url, { headers: downloadHeaders, signal: combined, redirect: 'error' });
      if (!imageResponse.ok) throw new Error(`Image download HTTP ${imageResponse.status}.`);
      data = await readBounded(imageResponse, config.maxImageBytes);
    } else continue;
    if (data.length > config.maxImageBytes) throw new Error('Generated image exceeds maxImageBytes.');
    images.push({ data, mediaType: sniffImage(data), revisedPrompt: item.revised_prompt });
  }
  return images;
}
