/**
 * Request-shaping and response-diagnostic tests for the image API client.
 * `image-api.js` has no DSH dependency, so this file runs anywhere.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { imageEntriesOf, pollImageTask, requestImages, resolveRequest, sniffImage, taskIdOf, validateConfig, readBounded } from '../image-api.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOQqC1rAGEGGAMANTwGLVwoFfsAAAAASUVORK5CYII=',
  'base64',
);

const config = {
  baseUrl: 'https://images.example/v1', apiKey: 'test-secret', apiKeyEnv: 'DSH_IMAGEGEN_TEST_MISSING_KEY',
  model: 'gpt-image-2', size: 'auto', quality: 'auto', outputFormat: 'auto', background: 'auto',
  submitMode: 'sync', resolution: '', taskPollMs: 5,
  timeoutMs: 4000, maxImages: 4, maxImageBytes: 1048576, maxResponseBytes: 1048576, downloadHosts: [],
};
const request = (args) => resolveRequest({ prompt: 'test prompt', ...args }, config);
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('a site page served with HTTP 200 is reported as a wrong baseUrl, with the cause named', async () => {
  const html = '<!doctype html>\n<html lang="zh"><head><title>API</title></head></html>';
  await assert.rejects(
    requestImages(request({}), config, {
      fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    }),
    (error) => {
      assert.match(error.message, /was not JSON/);
      assert.match(error.message, /missing its API root path/);
      assert.match(error.message, /text\/html/);
      assert.ok(!error.message.includes('test-secret'), 'the key must not leak into the message');
      return true;
    },
  );
});

test('a plain generation request posts to the API root with the credential and the declared body', async () => {
  const images = await requestImages(request({ size: '2160x3840', quality: 'high' }), config, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://images.example/v1/images/generations');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-image-2');
      assert.equal(body.size, '2160x3840');
      assert.equal(body.quality, 'high');
      assert.equal(body.n, 1);
      return json({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'revised' }] });
    },
  });
  assert.equal(images[0].mediaType, 'image/png');
  assert.equal(images[0].revisedPrompt, 'revised');
  assert.deepEqual(images[0].data, png);
});

test('the base URL keeps an explicit API root and never doubles a slash', async () => {
  for (const [baseUrl, expected] of [
    ['https://images.example/v1', 'https://images.example/v1/images/generations'],
    ['https://images.example/v1/', 'https://images.example/v1/images/generations'],
  ]) {
    await requestImages(request({}), { ...config, baseUrl }, {
      fetchImpl: async (url) => {
        assert.equal(url, expected);
        return json({ data: [{ b64_json: png.toString('base64') }] });
      },
    });
  }
});

test('a blank endpoint and a missing key fail with actionable messages before any HTTP work', async () => {
  await assert.rejects(
    requestImages(request({}), { ...config, baseUrl: '' }, { fetchImpl: () => assert.fail('must not fetch') }),
    /baseUrl is not configured/,
  );
  await assert.rejects(
    requestImages(request({}), { ...config, apiKey: '' }, { fetchImpl: () => assert.fail('must not fetch') }),
    /Configure apiKey/,
  );
});

test('edit mode submits ordered reference images plus a PNG mask as multipart', async () => {
  const resolved = request({ image_paths: ['one.png', 'two.png'], mask_path: 'mask.png' });
  const reads = [];
  await requestImages(resolved, config, {
    readImage: async (path) => { reads.push(path); return png; },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://images.example/v1/images/edits');
      assert.ok(options.body instanceof FormData);
      assert.deepEqual(options.body.getAll('image[]').map((file) => file.name), ['one.png', 'two.png']);
      assert.equal(options.body.get('mask').name, 'mask.png');
      assert.equal(options.headers['Content-Type'], undefined, 'multipart must set its own boundary');
      return json({ data: [{ b64_json: png.toString('base64') }] });
    },
  });
  assert.deepEqual(reads, ['one.png', 'two.png', 'mask.png']);
});

test('a provider error body is surfaced and the key is redacted', async () => {
  await assert.rejects(
    requestImages(request({}), config, {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'test-secret rejected' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.ok(!error.message.includes('test-secret'));
      return true;
    },
  );
});

test('an oversized body is refused by the bounded reader', async () => {
  await assert.rejects(readBounded(new Response('x'.repeat(64)), 8), /exceeds/);
  await assert.rejects(
    requestImages(request({}), { ...config, maxResponseBytes: 8 }, { fetchImpl: async () => json({ data: [] }) }),
    /exceeds/,
  );
});

test('request constraints still refuse impossible input before HTTP work', () => {
  for (const args of [
    { prompt: ' ' }, { n: 0 }, { n: 5 }, { mode: 'edit' },
    { mode: 'generate', image_paths: ['a'] }, { mask_path: 'x' },
    { image_paths: Array(17).fill('a') }, { output_compression: 90 },
    { input_fidelity: 'high' }, { size: '1025x1024' }, { size: '16x16' },
  ]) {
    assert.throws(() => request(args), undefined, `expected ${JSON.stringify(args)} to be refused`);
  }
});

test('signature sniffing recognizes the accepted formats only', () => {
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(sniffImage(Buffer.from([255, 216, 255, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
  assert.throws(() => sniffImage(Buffer.from('text')));
});

test('configuration refuses malformed roots and hosts', () => {
  assert.equal(validateConfig(config), config);
  validateConfig({ ...config, baseUrl: 'http://127.0.0.1:3000/v1' });
  for (const patch of [
    { baseUrl: 'http://remote.example/v1' }, { baseUrl: 'https://user:pass@api.example' },
    { timeoutMs: 0 }, { maxImages: 11 }, { downloadHosts: ['cdn.example/path'] },
    { submitMode: 'sometimes' }, { taskPollMs: 0 },
  ]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
});

test('an async submission is polled to completion and its result URL is downloaded', async () => {
  const seen = [];
  const polls = [
    { code: 'success', data: { status: 'QUEUED', progress: '20%' } },
    { code: 'success', data: { status: 'IN_PROGRESS', progress: '60%' } },
    { code: 'success', data: { status: 'SUCCESS', progress: '100%', result_url: 'https://images.example/v1/videos/task_a/content?sign=abc' } },
  ];
  const images = await requestImages(request({ size: '9:16' }), { ...config, submitMode: 'async' }, {
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), method: options?.method ?? 'GET' });
      if (seen.length === 1) {
        // The documented submission shape: task fields at the top level.
        return json({ id: 'task_a', task_id: 'task_a', status: 'pending', model: 'gpt-image-2' });
      }
      if (String(url).includes('/images/tasks/')) return json(polls.shift());
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });

  assert.equal(seen[0].url, 'https://images.example/v1/images/generations?async=true');
  assert.equal(seen[1].method, 'GET');
  assert.match(seen[1].url, /\/v1\/images\/tasks\/task_a$/);
  assert.match(seen.at(-1).url, /result|videos\/task_a\/content/);
  assert.deepEqual(images[0].data, png);
  assert.equal(images[0].mediaType, 'image/png');
});

test('a submission wrapped in data[] is also treated as a task, and a listed host is fetched without the key', async () => {
  const seen = [];
  const headers = [];
  const images = await requestImages(request({}), { ...config, downloadHosts: ['cdn.example'] }, {
    fetchImpl: async (url, options) => {
      seen.push(String(url));
      headers.push(options?.headers);
      if (seen.length === 1) return json({ code: 200, data: [{ status: 'submitted', task_id: 'task_b' }] });
      if (seen.length === 2) return json({ code: 'success', data: { task_id: 'task_b', status: 'SUCCESS', result_url: 'https://cdn.example/x.png' } });
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  assert.match(seen[1], /tasks\/task_b$/);
  assert.equal(headers.at(-1), undefined, 'a third-party host never receives the key');
  assert.deepEqual(images[0].data, png);
});

test('a result hosted on the API host is downloaded with the key', async () => {
  let lastHeaders;
  await requestImages(request({}), config, {
    fetchImpl: async (url, options) => {
      if (String(url).includes('/tasks/')) {
        return json({ code: 'success', data: { status: 'SUCCESS', result_url: 'https://images.example/v1/videos/t/content?sign=x' } });
      }
      if (String(url).includes('/images/generations')) return json({ task_id: 'task_key' });
      lastHeaders = options?.headers;
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  assert.equal(lastHeaders.Authorization, 'Bearer test-secret', 'the API host already holds the credential');
});

test('a failed task reports its reason instead of hanging', async () => {
  let calls = 0;
  await assert.rejects(
    requestImages(request({}), config, {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json({ task_id: 'task_c', status: 'pending' });
        return json({ code: 'success', data: { status: 'FAILURE', fail_reason: 'quota exhausted for test-secret' } });
      },
    }),
    (error) => {
      assert.match(error.message, /task_c failed/);
      assert.match(error.message, /quota exhausted/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.ok(!error.message.includes('test-secret'));
      return true;
    },
  );
});

test('a non-JSON poll response and an unknown task state both fail loudly', async () => {
  await assert.rejects(
    pollImageTask({ baseUrl: config.baseUrl, headers: {}, taskId: 'task_d', config, signal: AbortSignal.timeout(1000), fetchImpl: async () => new Response('<html/>') }),
    /non-JSON response/,
  );
  await assert.rejects(
    requestImages(request({}), { ...config, taskPollMs: 1, timeoutMs: 60 }, {
      fetchImpl: async (url) => (String(url).includes('/tasks/') ? json({ data: { status: 'QUEUED' } }) : json({ task_id: 'task_e' })),
    }),
    /abort|timeout/i,
  );
});

test('a result the API never delivers is reported with the payload, and task polling can be bounded', async () => {
  await assert.rejects(
    requestImages(request({}), config, {
      fetchImpl: async (url) => (String(url).includes('/tasks/') ? json({ data: { status: 'SUCCESS' } }) : json({ task_id: 'task_f' })),
    }),
    /finished without an image/,
  );
});

test('imageEntriesOf reads every supported result shape and taskIdOf only real submissions', () => {
  assert.equal(imageEntriesOf({ data: [{ url: 'u' }] }).length, 1);
  assert.equal(imageEntriesOf({ data: { result_url: 'u' } }).length, 1);
  assert.equal(imageEntriesOf({ data: { result: { data: [{ b64_json: 'x' }] } } }).length, 1);
  assert.equal(imageEntriesOf({ data: { images: [{ url: 'u' }] } }).length, 1);
  assert.equal(imageEntriesOf({ result: { data: [{ url: 'u' }] } }).length, 1);
  assert.equal(imageEntriesOf({ data: { status: 'SUCCESS' } }).length, 0);

  assert.equal(taskIdOf({ task_id: 't1' }), 't1');
  assert.equal(taskIdOf({ data: [{ task_id: 't2' }] }), 't2');
  assert.equal(taskIdOf({ data: { task_id: 't3' } }), 't3');
  // A plain synchronous response is never mistaken for a submission.
  assert.equal(taskIdOf({ data: [{ b64_json: 'x' }] }), undefined);
  assert.equal(taskIdOf({ data: [{ url: 'u' }] }), undefined);
});

test('a sync response that already carries an image never polls', async () => {
  let calls = 0;
  await requestImages(request({}), { ...config, submitMode: 'async' }, {
    fetchImpl: async () => {
      calls += 1;
      return json({ created: 1, data: [{ b64_json: png.toString('base64') }] });
    },
  });
  assert.equal(calls, 1);
});

test('resolution and output_format are sent only when configured', () => {
  const bare = resolveRequest({ prompt: 'p' }, { ...config, resolution: '' });
  assert.equal('resolution' in bare.body, false);
  assert.equal('output_format' in bare.body, false, 'auto must omit the field for providers that reject it');

  const explicit = resolveRequest({ prompt: 'p', output_format: 'webp' }, { ...config, resolution: '4k' });
  assert.equal(explicit.body.resolution, '4k');
  assert.equal(explicit.body.output_format, 'webp');

  assert.equal(resolveRequest({ prompt: 'p', size: '9:16' }, config).body.size, '9:16', 'a ratio passes through for non-OpenAI models');
});
