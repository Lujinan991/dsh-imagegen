/**
 * Client module tests: the configuration page must register under the
 * package-name key the Plugins page reads, must render every field, and a save
 * must produce the settings operations the Host accepts. The module body runs
 * in a VM (as the ModuleLoader runs it) against a minimal React harness, so no
 * browser or DSH client package is needed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });

/**
 * A minimal React harness: hooks keep state across re-renders, an effect runs
 * when its dependency array changed, and a render settles once no effect
 * changed state. This is enough to drive the real component bodies.
 */
function harness() {
  let states = [];
  let effectDeps = [];
  let cursor = 0;
  let effectCursor = 0;
  let effects = [];
  let dirty = false;
  const React = {
    createElement: h,
    useState(initial) {
      const index = cursor++;
      if (states.length <= index) states[index] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        const value = typeof next === 'function' ? next(states[index]) : next;
        if (Object.is(value, states[index])) return;
        states[index] = value;
        dirty = true;
      };
      return [states[index], set];
    },
    useEffect(fn, deps) {
      const index = effectCursor++;
      const previous = effectDeps[index];
      const changed = deps === undefined || previous === undefined
        || deps.length !== previous.length || deps.some((value, at) => !Object.is(value, previous[at]));
      if (!changed) return;
      effectDeps[index] = deps === undefined ? undefined : [...deps];
      effects.push(fn);
    },
    useCallback(fn) { return fn; },
    useSyncExternalStore(_subscribe, read) { return read(); },
  };
  const render = (component, props) => {
    for (let pass = 0; pass < 20; pass += 1) {
      cursor = 0;
      effectCursor = 0;
      effects = [];
      dirty = false;
      const tree = component(props);
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw new Error('the component did not settle');
  };
  return { React, render };
}

/** Load the client module body the way the ModuleLoader does. */
function loadClient(React) {
  let plugin;
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(module) {
          assert.equal(module.id, '@local/dsh-imagegen');
          plugin = module.factory((name) => {
            assert.equal(name, 'react', 'the module may require react only');
            return React;
          });
        },
      },
    },
  });
  return plugin;
}

/** Render function components while flattening an element tree to text. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node.type === 'function') return textOf(node.type(node.props));
  return textOf(node.children ?? []);
}

/** Every element whose id starts with the plugin's field prefix. */
function inputsOf(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const child of node) inputsOf(child, found); return found; }
  if (typeof node.type === 'function') return inputsOf(node.type(node.props), found);
  const id = node.props?.id;
  if (typeof id === 'string' && id.startsWith('imagegen-')) found.push(node);
  for (const child of node.children ?? []) inputsOf(child, found);
  return found;
}

/** The first button element found in a rendered tree. */
function buttonOf(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const child of node) { const hit = buttonOf(child); if (hit) return hit; } return undefined; }
  if (typeof node.type === 'function') return buttonOf(node.type(node.props));
  if (node.type === 'button') return node;
  for (const child of node.children ?? []) { const hit = buttonOf(child); if (hit) return hit; }
  return undefined;
}

/** A settings scope double with a mutable snapshot. */
function scopeDouble(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    mutateCalls: [],
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    mutate: async (ops, revision) => { scopeDoubleCalls.push({ ops, revision }); return true; },
    publish(next) { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener(); },
  };
}
const scopeDoubleCalls = [];

/** Mount the plugin against a stub client context. */
function mount({ scope, withConfigForms = true, brokenConfigForms = false } = {}) {
  const plugin = loadClient(harness().React);
  const slots = [];
  const namespaces = [];
  const scoped = [];
  const warnings = [];
  const configForms = {
    get: (ns) => {
      if (brokenConfigForms) throw new Error('settings service exploded');
      assert.equal(ns, 'dsh-imagegen', 'the form namespace is the Host entry id');
      return scope;
    },
    whileServed: (names, run) => { namespaces.push(names); return run(); },
  };
  const ctx = {
    effect: (fn) => { fn(); },
    locale: { bind: () => (key) => key, register: () => () => {} },
    logger: { warn: (message) => warnings.push(String(message)) },
    slots: {
      inject: (_name, run) => run(),
      register: (options, component) => { slots.push({ options, component }); return () => {}; },
    },
    inject: (dependencies, run) => {
      scoped.push(dependencies);
      if (dependencies.includes('configForms') && withConfigForms) run({ configForms });
    },
  };
  plugin.apply(ctx);
  return { plugin, slots, namespaces, scoped, warnings };
}

test('apply registers the tool view and the bundle configuration page', () => {
  scopeDoubleCalls.length = 0;
  const scope = scopeDouble({ status: 'ready', value: {}, base: {}, revision: 0, writable: true });
  const { plugin, slots, namespaces, scoped } = mount({ scope });

  const toolview = slots.find((entry) => entry.options.name === 'tool.call.toolview');
  assert.equal(toolview.options.key, 'generate_image');
  assert.equal(toolview.options.locale, 'dsh-imagegen');

  const page = slots.find((entry) => entry.options.name === 'plugins.bundle.config');
  assert.ok(page, 'the configuration page must register on plugins.bundle.config');
  assert.equal(page.options.key, '@local/dsh-imagegen', 'the key is the package name the Plugins page matches');
  same(namespaces, [['dsh-imagegen']]);
  // Settings is optional, so the card keeps working without it.
  same(scoped, [['configForms']]);
  assert.equal(plugin.inject.includes('configForms'), false, 'the card must not depend on the settings service');
});

test('the image card still registers when no settings service is mounted', () => {
  const { slots, namespaces } = mount({ scope: undefined, withConfigForms: false });
  assert.ok(slots.find((entry) => entry.options.name === 'tool.call.toolview'), 'the tool view still registers');
  assert.equal(slots.find((entry) => entry.options.name === 'plugins.bundle.config'), undefined);
  same(namespaces, []);
});

test('a failing configuration page never takes the image card down with it', () => {
  const { slots, warnings } = mount({ brokenConfigForms: true });
  assert.ok(slots.find((entry) => entry.options.name === 'tool.call.toolview'), 'the tool view survives');
  assert.equal(slots.find((entry) => entry.options.name === 'plugins.bundle.config'), undefined);
  assert.ok(warnings.some((message) => message.includes('configuration page')), 'the failure is reported, not swallowed');
});

test('the configuration panel renders every field and reports the secret state', () => {
  const scope = scopeDouble({
    status: 'ready',
    value: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', timeoutMs: 300000 },
    base: { size: 'auto', maxImages: 4 },
    revision: 3,
    writable: true,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  const { React, render } = harness();
  const plugin = loadClient(React);
  const tree = render(plugin.ConfigPanel, { t: (key) => plugin.dictionaries.zh[key] ?? key, scope });

  const ids = inputsOf(tree).map((element) => element.props.id);
  for (const field of ['baseUrl', 'apiKey', 'apiKeyEnv', 'model', 'size', 'resolution', 'quality', 'background', 'outputFormat', 'submitMode', 'taskPollMs', 'timeoutMs', 'maxImages', 'maxImageBytes', 'downloadHosts']) {
    assert.ok(ids.includes(`imagegen-${field}`), `missing field ${field}`);
  }
  const rendered = textOf(tree);
  assert.ok(rendered.includes('已配置密钥。'), 'a configured secret is reported');
  const apiKey = inputsOf(tree).find((element) => element.props.id === 'imagegen-apiKey');
  assert.equal(apiKey.props.type, 'password');
  assert.equal(apiKey.props.value, '', 'the secret is never seeded from the snapshot');
  // Defaults from `base` back the fields the user has not overridden.
  assert.equal(inputsOf(tree).find((element) => element.props.id === 'imagegen-size').props.value, 'auto');
  assert.equal(inputsOf(tree).find((element) => element.props.id === 'imagegen-baseUrl').props.value, 'https://api.openai.com/v1');
  assert.equal(inputsOf(tree).find((element) => element.props.id === 'imagegen-timeoutMs').props.value, '300000');
});

test('an unconfigured secret is reported as unset', () => {
  const scope = scopeDouble({ status: 'ready', value: {}, base: {}, revision: 1, writable: true, secrets: [{ path: ['apiKey'], set: false }] });
  const { React, render } = harness();
  const panel = loadClient(React).ConfigPanel;
  const tree = render(panel, { t: (key) => loadClient(React).dictionaries.zh[key] ?? key, scope });
  assert.ok(textOf(tree).includes('未配置密钥'));
});

test('an unavailable namespace explains itself instead of rendering a blank form', () => {
  const scope = scopeDouble({ status: 'unavailable', value: undefined, base: undefined, revision: 0, writable: false });
  const { React, render } = harness();
  const panel = loadClient(React).ConfigPanel;
  const tree = render(panel, { t: (key) => loadClient(React).dictionaries.zh[key] ?? key, scope });
  assert.ok(textOf(tree).includes('暂时无法配置'));
});

test('saving sends one operation per real change, including a typed secret', async () => {
  scopeDoubleCalls.length = 0;
  const scope = scopeDouble({
    status: 'ready',
    value: { baseUrl: 'https://api.openai.com/v1', maxImages: 4, downloadHosts: [] },
    base: {}, revision: 7, writable: true, secrets: [{ path: ['apiKey'], set: false }],
  });
  const { React, render } = harness();
  const panel = loadClient(React).ConfigPanel;
  const t = (key) => loadClient(React).dictionaries.zh[key] ?? key;

  // Save is disabled while nothing changed.
  let tree = render(panel, { t, scope });
  assert.equal(buttonOf(tree).props.disabled, true, 'an untouched form has nothing to save');

  // Change three fields and the secret through the rendered controls.
  for (const [id, value] of [['imagegen-baseUrl', 'http://127.0.0.1:8080/v1'], ['imagegen-maxImages', '2'], ['imagegen-apiKey', 'sk-test']]) {
    const input = inputsOf(tree).find((element) => element.props.id === id);
    input.props.onChange({ target: { value } });
    tree = render(panel, { t, scope });
  }
  const save = buttonOf(tree);
  assert.equal(save.props.disabled, false);
  await save.props.onClick();
  same(scopeDoubleCalls, [{
    ops: [
      { op: 'set', path: ['baseUrl'], value: 'http://127.0.0.1:8080/v1' },
      { op: 'set', path: ['maxImages'], value: 2 },
      { op: 'set', path: ['apiKey'], value: 'sk-test' },
    ],
    revision: 7,
  }]);
});

test('operationsOf ignores an unchanged draft and parses lists and numbers', () => {
  const plugin = loadClient(harness().React);
  const state = { value: { baseUrl: 'https://api.openai.com/v1', maxImages: 4, downloadHosts: [] }, base: {} };
  same(plugin.operationsOf(plugin.draftOf(state), state), []);

  const draft = { ...plugin.draftOf(state), downloadHosts: 'cdn.example, img.example', timeoutMs: '60000' };
  same(plugin.operationsOf(draft, state), [
    { op: 'set', path: ['timeoutMs'], value: 60000 },
    { op: 'set', path: ['downloadHosts'], value: ['cdn.example', 'img.example'] },
  ]);
});

test('the tool card renders a settled error and only images the result carries', () => {
  const scope = scopeDouble({ status: 'ready', value: {}, base: {}, revision: 0, writable: true });
  const { slots } = mount({ scope });
  const ImageResult = slots.find((entry) => entry.options.name === 'tool.call.toolview').component;
  const t = (key) => loadClient(harness().React).dictionaries.zh[key] ?? key;

  const preview = { attachmentId: 'preview-id', mediaType: 'image/png', bytes: 100, width: 2, height: 2 };
  const meta = { version: 1, model: 'gpt-image-2', images: [{ name: 'a.png', path: '/tmp/a.png', preview }] };
  const argsRaw = JSON.stringify({ prompt: '提示词' });

  const errored = ImageResult({ phase: 'result', t, block: { call: { argsRaw }, isError: true, content: [{ type: 'text', text: '接口返回 401' }] } });
  assert.ok(textOf(errored).includes('接口返回 401'));

  const settled = ImageResult({ phase: 'result', t, block: { call: { argsRaw }, isError: false, content: [{ type: 'text', text: 'done' }, { type: 'image', attachment: preview }], meta } });
  assert.ok(textOf(settled).includes('a.png'), 'a referenced image renders its caption');

  const stale = ImageResult({ phase: 'result', t, block: { call: { argsRaw }, isError: false, content: [{ type: 'text', text: 'done' }], meta } });
  assert.equal(JSON.stringify(stale).includes('a.png'), false, 'an image the result no longer carries is not shown');

  const running = ImageResult({ phase: 'start', t, block: { argsRaw } });
  assert.ok(textOf(running).includes('生成中'));
});
