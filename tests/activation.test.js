/**
 * Activation tests for the reported failure: with `.volatile()` the framework
 * hands `apply` a live reference instead of plain config, so reading
 * `config.baseUrl` directly yielded `undefined` and activation threw
 * `Invalid URL`. These tests drive the REAL schema the Loader validates with.
 *
 * The framework packages are imported dynamically because a plain checkout of
 * this plugin has no DSH installation beside it: without one these tests must
 * SKIP, not fail to load. Run them against an installation by extracting its
 * modules first (see README) or by installing inside a DSH profile.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

let Context;
let createVolatile;
let isVolatile;
let updateVolatile;
let plugin;
let available = true;
try {
  ({ Context } = await import('@deepseek-ai/cordis'));
  ({ createVolatile, isVolatile, updateVolatile } = await import('@deepseek-ai/cosmokit'));
  plugin = await import('../index.js');
} catch {
  available = false;
}
const requiresDsh = { skip: available ? false : 'no DSH installation beside this checkout; see README for the isolated-runtime runner' };

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOQqC1rAGEGGAMANTwGLVwoFfsAAAAASUVORK5CYII=',
  'base64',
);

/** Resolve raw config exactly the way cordis `resolveConfig` does at mount. */
function resolved(raw) {
  const result = plugin.Config['~standard'].validate(raw);
  assert.equal(result.issues, undefined, JSON.stringify(result.issues));
  return result.value;
}

/** Minimal host services the plugin injects. */
function host() {
  const tools = [];
  const sections = [];
  return {
    tools,
    sections,
    ctx: {
      tools: { register: (tool) => { tools.push(tool); } },
      get: () => undefined,
      fs: { resolve: async (path) => ({ path }), readBytes: async () => png },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4 },
        saveFile: async (input) => ({ attachmentId: 'original', name: input.name, bytes: input.data.length }),
        fileHostPath: (ref) => `/storage/${ref.name}`,
        saveImages: async (inputs) => inputs.map((input) => ({
          attachmentId: 'preview', name: input.name, mediaType: input.mediaType,
          bytes: input.data.length, width: 2, height: 2,
        })),
      },
      inject: (deps, run) => {
        if (deps.includes('systemPrompt')) run({ systemPrompt: { section: (section) => { sections.push(section); } } });
      },
    },
  };
}

test('the object-level volatile schema hands apply a reference, not plain config', requiresDsh, () => {
  const config = resolved({});
  assert.equal(isVolatile(config), true);
  // The exact defect: a direct field read is undefined.
  assert.equal(config.baseUrl, undefined);
});

test('readConfig unwraps both volatile shapes and keeps plain values', requiresDsh, () => {
  assert.deepEqual(plugin.readConfig(resolved({})).baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(plugin.readConfig(resolved({ model: 'gpt-image-1.5' })).model, 'gpt-image-1.5');

  const fieldLevel = { baseUrl: createVolatile('https://x/v1'), maxImages: 2, plain: 'kept' };
  assert.deepEqual(plugin.readConfig(fieldLevel), { baseUrl: 'https://x/v1', maxImages: 2, plain: 'kept' });
  assert.deepEqual(plugin.readConfig(undefined), {});
});

test('activate with an empty user config (the reported failure)', requiresDsh, () => {
  const h = host();
  plugin.apply(h.ctx, resolved({}));
  assert.equal(h.tools.length, 1);
  assert.equal(h.tools[0].name, 'generate_image');
  assert.equal(h.tools[0].timeoutMs, 300000);
  assert.equal(h.sections.length, 1);
});

test('activate with a partial config and with blank saved values', requiresDsh, () => {
  const partial = host();
  plugin.apply(partial.ctx, resolved({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', maxImages: 2 }));
  assert.equal(partial.tools[0].name, 'generate_image');

  const blank = host();
  plugin.apply(blank.ctx, resolved({ baseUrl: '', apiKey: '', apiKeyEnv: '', model: '', size: '', maxImages: 1 }));
  assert.equal(blank.tools.length, 1);
});

test('a malformed URL still fails loudly at activation', requiresDsh, () => {
  const h = host();
  assert.throws(() => plugin.apply(h.ctx, resolved({ baseUrl: 'ftp://example.com' })), /HTTP\(S\)/);
});

test('a settings write is visible to the next call without a remount', requiresDsh, async () => {
  const h = host();
  const config = resolved({});
  plugin.apply(h.ctx, config);
  const tool = h.tools[0];

  // The Loader commits a volatile-only edit by copying the freshly resolved
  // reference into the running one; the plugin reads through the same ref.
  updateVolatile(config, resolved({ baseUrl: '' }));
  assert.equal(plugin.readConfig(config).baseUrl, '');
  // A blank endpoint must refuse with an actionable message, not a URL crash.
  await assert.rejects(
    tool.execute({ prompt: 'test' }, { signal: new AbortController().signal }),
    /baseUrl is not configured/,
  );

  updateVolatile(config, resolved({ baseUrl: 'https://api.example/v1' }));
  assert.equal(plugin.readConfig(config).baseUrl, 'https://api.example/v1');
  // Defaults survive a partial write.
  assert.equal(plugin.readConfig(config).timeoutMs, 300000);
});

test('a real cordis Context applies the schema and keeps the tool registered', requiresDsh, async () => {
  const ctx = new Context();
  const h = host();
  ctx.provide('tools', h.ctx.tools);
  ctx.provide('fs', h.ctx.fs);
  ctx.provide('attachments', h.ctx.attachments);
  await ctx.plugin(plugin, {});
  assert.equal(h.tools.length, 1);
  assert.equal(h.tools[0].name, 'generate_image');
  await ctx.fiber.dispose();
});

test('the Host module imports only packages the manifest declares', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  for (const file of ['index.js', 'image-api.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(/^import[^'"\n]*['"]([^'"]+)['"]/gm)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      assert.ok(declared.has(specifier), `${file} imports undeclared package "${specifier}"; the Host resolves only declared packages`);
    }
  }
});

test('the browser module requires react and nothing else', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(([, name]) => name);
  assert.deepEqual(required, ['react']);
});
