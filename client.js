/**
 * Browser half of the AI Image Generation plugin: the tool result card that
 * renders generated images, and the configuration page DSH shows on this
 * bundle's detail view.
 *
 * Everything lives in one module table entry on purpose: the ModuleLoader
 * resolves `require` against registered module ids, so a plugin cannot require
 * its own package subpath. Only `react` is requested, keeping the component
 * independent of client packages whose shape may change between releases.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-imagegen',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-imagegen';

    const dictionaries = {
      en: {
        generate: 'Generate image', edit: 'Edit image', running: 'Generating', done: 'Completed',
        error: 'Failed', loading: 'Loading image', retry: 'Retry preview', open: 'Open preview',
        original: 'Open original', prompt: 'Prompt', result: 'Result',
        configTitle: 'Image API', configIntro: 'Used by the generate_image tool. Values save into this profile and apply to the next call.',
        baseUrl: 'API Endpoint', baseUrlHint: 'OpenAI-compatible root, e.g. https://api.openai.com/v1',
        apiKey: 'API Key', apiKeyHint: 'Stored as a secret and never shown again. Leave blank to keep the current key.',
        apiKeySet: 'A key is configured.', apiKeyUnset: 'No key configured; the environment variable below is used instead.',
        apiKeyEnv: 'Key Environment Variable', model: 'Default Model', size: 'Default Size',
        sizeHint: 'WIDTHxHEIGHT for OpenAI models, or an aspect ratio such as 9:16 for providers that take a ratio.',
        resolution: 'Resolution Tier', resolutionHint: 'Provider-specific tier such as 1k, 2k or 4k. Leave blank to omit the field.',
        quality: 'Quality', background: 'Background', outputFormat: 'Output Format',
        submitMode: 'Submit Mode', submitModeHint: 'async posts to ?async=true and polls the task endpoint — required by providers whose image API returns a task id.',
        taskPollMs: 'Task Poll Interval (ms)',
        timeoutMs: 'Timeout (ms)', timeoutHint: 'Covers the whole paid operation: submit, polling and downloads.',
        maxImages: 'Max Images per Call', maxImageBytes: 'Max Image Bytes',
        downloadHosts: 'Trusted Download Hosts', downloadHostsHint: 'Comma-separated exact HTTPS hosts allowed for URL image results. The API host itself is always allowed.',
        save: 'Save', saving: 'Saving…', saved: 'Saved', saveFailed: 'The deployment rejected these values.',
        reset: 'Reset', loading_: 'Loading configuration…', unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        readOnly: 'This deployment stores settings read-only.',
      },
      zh: {
        generate: '生成图片', edit: '编辑图片', running: '生成中', done: '已完成',
        error: '失败', loading: '加载图片', retry: '重试预览', open: '打开预览',
        original: '打开原图', prompt: '提示词', result: '结果',
        configTitle: '生图接口', configIntro: '供 generate_image 工具使用。保存后写入当前 profile，并在下次调用时生效。',
        baseUrl: 'API 接口地址', baseUrlHint: 'OpenAI 兼容的根地址，例如 https://api.openai.com/v1',
        apiKey: 'API 密钥', apiKeyHint: '作为密钥保存，不会回显。留空表示保持当前密钥。',
        apiKeySet: '已配置密钥。', apiKeyUnset: '未配置密钥；将使用下方环境变量。',
        apiKeyEnv: '密钥环境变量', model: '默认模型', size: '默认尺寸',
        sizeHint: 'OpenAI 模型填 WIDTHxHEIGHT；按比例取值的服务填 9:16 这类比例。',
        resolution: '分辨率档位', resolutionHint: '服务商特有的档位，如 1k、2k、4k。留空表示不发送该字段。',
        quality: '质量', background: '背景', outputFormat: '输出格式',
        submitMode: '提交模式', submitModeHint: 'async 会带 ?async=true 提交并轮询任务接口 —— 图片接口返回 task_id 的服务必须选它。',
        taskPollMs: '任务轮询间隔（毫秒）',
        timeoutMs: '超时（毫秒）', timeoutHint: '覆盖整次付费操作：提交、轮询与下载。',
        maxImages: '单次最多图片数', maxImageBytes: '单张图片字节上限',
        downloadHosts: '可信下载域名', downloadHostsHint: '逗号分隔的精确 HTTPS 域名。API 接口地址本身的域名始终允许。',
        save: '保存', saving: '保存中…', saved: '已保存', saveFailed: '本部署拒绝了这些值。',
        reset: '恢复默认', loading_: '正在读取配置…', unavailable: '该插件当前未加载，暂时无法配置。',
        readOnly: '本部署的设置为只读。',
      },
    };

    /** Editable fields in display order: key, label, hint, input kind, options. */
    const TEXT_FIELDS = [
      ['baseUrl', 'baseUrl', 'baseUrlHint', 'text'],
      ['apiKeyEnv', 'apiKeyEnv', null, 'text'],
      ['model', 'model', null, 'text'],
      ['size', 'size', 'sizeHint', 'text'],
      ['resolution', 'resolution', 'resolutionHint', 'text'],
      ['quality', 'quality', null, 'select', ['auto', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['background', 'background', null, 'select', ['auto', 'opaque', 'transparent']],
      ['outputFormat', 'outputFormat', null, 'select', ['auto', 'png', 'jpeg', 'webp']],
      ['submitMode', 'submitMode', 'submitModeHint', 'select', ['sync', 'async']],
      ['taskPollMs', 'taskPollMs', null, 'number'],
      ['timeoutMs', 'timeoutMs', 'timeoutHint', 'number'],
      ['maxImages', 'maxImages', null, 'number'],
      ['maxImageBytes', 'maxImageBytes', null, 'number'],
    ];

    const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 };
    const hintStyle = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', margin: '2px 0 6px' };
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13,
      color: 'var(--dsw-alias-label-primary, #242424)',
      background: 'var(--dsw-alias-bg-base, transparent)',
      border: '0.5px solid var(--dsw-alias-border-l2, #d0d0d0)', borderRadius: 6,
    };
    const linkStyle = { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 12, textDecoration: 'underline' };

    function isPreview(ref) {
      return ref && typeof ref.attachmentId === 'string' && ref.attachmentId.length > 0
        && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
        && ['bytes', 'width', 'height'].every(key => Number.isSafeInteger(ref[key]) && ref[key] > 0);
    }

    function Preview({ image, loadImage, openFile, t }) {
      const [url, setUrl] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        let live = true;
        setUrl(null);
        setFailed(false);
        Promise.resolve().then(() => loadImage(image.preview)).then(value => {
          if (!live) return;
          if (typeof value !== 'string' || !/^(blob:|https?:)/.test(value)) throw new Error('Invalid image URL');
          setUrl(value);
        }).catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
      }, [image.preview, loadImage, attempt]);
      return h('figure', { style: { margin: 0, minWidth: 0 } },
        h('div', { style: { width: '100%', aspectRatio: `${image.preview.width}/${image.preview.height}`, maxHeight: 320, minHeight: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: t('open'), style: { width: '100%', height: '100%', display: 'flex', justifyContent: 'center' } },
            h('img', { src: url, alt: image.name, style: { display: 'block', maxWidth: '100%', maxHeight: 320, objectFit: 'contain', borderRadius: 4 } }))
            : failed ? h('button', { type: 'button', onClick: () => setAttempt(value => value + 1), style: { ...linkStyle, background: 'transparent', border: 0, cursor: 'pointer' } }, t('retry'))
              : h('span', { role: 'status', style: { fontSize: 12 } }, t('loading'))),
        h('figcaption', { style: { fontSize: 12, overflowWrap: 'anywhere', marginTop: 6 } },
          h('div', null, image.name),
          image.path ? h('button', { type: 'button', onClick: () => openFile(image.path), style: { ...linkStyle, padding: '4px 0', border: 0, background: 'transparent', cursor: 'pointer' } }, t('original')) : null));
    }

    function ImageResult(props) {
      const { block, phase, t } = props;
      let args = {};
      try {
        const call = phase === 'result' ? block.call : block;
        const parsed = JSON.parse(call?.argsRaw ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      } catch { /* Preparing tool arguments can be incomplete JSON. */ }
      const title = args.mode === 'edit' || args.image_paths?.length ? t('edit') : t('generate');
      const settled = phase === 'result';
      const state = !settled ? t('running') : block.isError ? t('error') : t('done');
      const meta = block.meta;
      const referenced = new Map();
      if (settled && Array.isArray(block.content)) {
        for (const part of block.content) if (part.type === 'image' && isPreview(part.attachment)) referenced.set(part.attachment.attachmentId, part.attachment);
      }
      const images = settled && !block.isError && meta?.version === 1 && Array.isArray(meta.images)
        && meta.images.every(image => typeof image?.name === 'string' && typeof image.path === 'string' && isPreview(image.preview))
        ? meta.images.filter(image => referenced.has(image.preview.attachmentId)).map(image => ({ ...image, preview: referenced.get(image.preview.attachmentId) })) : [];
      const text = settled && Array.isArray(block.content) ? block.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
      return h('section', { style: { padding: '8px 0', minWidth: 0, fontSize: 13, color: 'var(--dsw-alias-label-primary, inherit)' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 10 } }, h('strong', null, title), h('span', { role: 'status', style: { fontSize: 12, opacity: 0.65 } }, state), meta?.model ? h('span', { style: { fontSize: 12, opacity: 0.65, overflowWrap: 'anywhere' } }, meta.model) : null),
        images.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 16, maxWidth: 760 } }, images.map(image => h(Preview, { key: image.preview.attachmentId + image.name, image, loadImage: props.loadImage, openFile: props.openFile, t }))) : null,
        text ? h('details', { open: block.isError === true || images.length === 0, style: { marginTop: 10 } }, h('summary', { style: { cursor: 'pointer' } }, t('result')), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', fontSize: 12, margin: '8px 0' } }, text)) : null,
        typeof args.prompt === 'string' ? h('details', { style: { marginTop: 8 } }, h('summary', { style: { cursor: 'pointer' } }, t('prompt')), h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 } }, args.prompt)) : null);
    }

    /** Subscribe a component to one `ConfigForms` entry scope. */
    function useScope(scope) {
      const subscribe = React.useCallback((notify) => scope.subscribe(notify), [scope]);
      const read = React.useCallback(() => scope.getSnapshot(), [scope]);
      return React.useSyncExternalStore(subscribe, read);
    }

    /** One form value as the text an input shows. */
    function asText(value, kind) {
      if (value === undefined || value === null) return '';
      if (kind === 'number') return String(value);
      if (kind === 'list') return Array.isArray(value) ? value.join(', ') : '';
      return String(value);
    }

    /** One input's text as the JSON value the settings form expects. */
    function asValue(text, kind) {
      if (kind === 'number') {
        const trimmed = String(text ?? '').trim();
        if (trimmed === '') return undefined;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      if (kind === 'list') {
        return String(text ?? '').split(',').map(part => part.trim()).filter(part => part !== '');
      }
      return String(text ?? '');
    }

    /** The editable draft of every field, seeded from a live snapshot. */
    function draftOf(state) {
      const value = state.value ?? {};
      const base = state.base ?? {};
      const draft = {};
      for (const [key, , , kind] of TEXT_FIELDS) {
        draft[key] = asText(value[key] ?? base[key], kind === 'select' ? 'text' : kind);
      }
      draft.downloadHosts = asText(value.downloadHosts ?? base.downloadHosts, 'list');
      draft.apiKey = '';
      return draft;
    }

    /** The field operations a draft implies, measured against the live values. */
    function operationsOf(draft, state) {
      const value = state.value ?? {};
      const base = state.base ?? {};
      const ops = [];
      for (const [key, , , kind] of TEXT_FIELDS) {
        const parsedKind = kind === 'select' ? 'text' : kind;
        const next = asValue(draft[key], parsedKind);
        if (parsedKind === 'number' && next === undefined) continue;
        if (asText(value[key] ?? base[key], parsedKind) !== asText(next, parsedKind)) {
          ops.push({ op: 'set', path: [key], value: next });
        }
      }
      const hosts = asValue(draft.downloadHosts, 'list');
      if (asText(value.downloadHosts ?? base.downloadHosts, 'list') !== asText(hosts, 'list')) {
        ops.push({ op: 'set', path: ['downloadHosts'], value: hosts });
      }
      // The secret is write-only: only an actually typed value is saved.
      if (draft.apiKey !== '') ops.push({ op: 'set', path: ['apiKey'], value: draft.apiKey });
      return ops;
    }

    /**
     * The bundle configuration page: one draft per field, saved through the
     * shared settings transport so the Host validates and persists it.
     */
    function ConfigPanel(props) {
      const { t, scope } = props;
      const snapshot = useScope(scope);
      const [draft, setDraft] = React.useState(null);
      const [saveState, setSaveState] = React.useState('idle');
      const scopeStatus = snapshot.status;
      const revision = snapshot.revision;

      // Seed the draft from the live snapshot, and again after every save.
      React.useEffect(() => {
        if (scopeStatus !== 'ready') return;
        setDraft(draftOf(snapshot));
        setSaveState('idle');
        // Re-seeding is keyed on the snapshot identity the Host published.
      }, [scopeStatus, revision]);

      if (scopeStatus === 'loading') return h('p', { style: hintStyle }, t('loading_'));
      if (scopeStatus === 'unavailable') return h('p', { style: hintStyle }, t('unavailable'));
      if (draft === null) return h('p', { style: hintStyle }, t('loading_'));

      const editable = snapshot.writable !== false;
      const ops = operationsOf(draft, snapshot);
      const keyConfigured = Array.isArray(snapshot.secrets)
        ? snapshot.secrets.some(secret => Array.isArray(secret.path) && secret.path.length === 1 && secret.path[0] === 'apiKey' && secret.set === true)
        : snapshot.value?.apiKey !== undefined;

      const save = async () => {
        if (ops.length === 0) return;
        setSaveState('saving');
        let accepted = false;
        try {
          accepted = await scope.mutate(ops, snapshot.revision);
        } catch {
          accepted = false;
        }
        setSaveState(accepted ? 'saved' : 'failed');
      };

      const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });

      const field = ([key, labelKey, hintKey, kind, options]) => h('div', { key, style: { marginBottom: 14 } },
        h('label', { style: labelStyle, htmlFor: `imagegen-${key}` }, t(labelKey)),
        hintKey ? h('p', { style: hintStyle }, t(hintKey)) : null,
        kind === 'select'
          ? h('select', { id: `imagegen-${key}`, style: inputStyle, disabled: !editable, value: draft[key], onChange: set(key) },
            options.map(option => h('option', { key: option, value: option }, option)))
          : h('input', {
            id: `imagegen-${key}`, style: inputStyle, disabled: !editable,
            type: kind === 'number' ? 'number' : 'text',
            value: draft[key], onChange: set(key),
          }));

      return h('section', { style: { maxWidth: 640, font: 'inherit' }, 'data-imagegen-config': true },
        h('h4', { style: { margin: '0 0 4px', fontSize: 15, fontWeight: 600 } }, t('configTitle')),
        h('p', { style: hintStyle }, t('configIntro')),
        field(TEXT_FIELDS[0]),
        h('div', { style: { marginBottom: 14 } },
          h('label', { style: labelStyle, htmlFor: 'imagegen-apiKey' }, t('apiKey')),
          h('p', { style: hintStyle }, t('apiKeyHint')),
          h('input', {
            id: 'imagegen-apiKey', style: inputStyle, type: 'password', autoComplete: 'off',
            disabled: !editable, value: draft.apiKey, placeholder: keyConfigured ? '••••••••' : '',
            onChange: set('apiKey'),
          }),
          h('p', { style: { ...hintStyle, marginTop: 4 } }, keyConfigured ? t('apiKeySet') : t('apiKeyUnset'))),
        ...TEXT_FIELDS.slice(1).map(field),
        h('div', { style: { marginBottom: 14 } },
          h('label', { style: labelStyle, htmlFor: 'imagegen-downloadHosts' }, t('downloadHosts')),
          h('p', { style: hintStyle }, t('downloadHostsHint')),
          h('input', {
            id: 'imagegen-downloadHosts', style: inputStyle, disabled: !editable,
            value: draft.downloadHosts, onChange: set('downloadHosts'),
          })),
        !editable ? h('p', { style: hintStyle }, t('readOnly')) : null,
        saveState === 'failed' ? h('p', { role: 'alert', style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary, #c33)' } }, t('saveFailed')) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 } },
          h('button', {
            type: 'button', disabled: !editable || saveState === 'saving' || ops.length === 0, onClick: save,
            style: { padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer', border: '0.5px solid var(--dsw-alias-border-l2, #d0d0d0)', background: 'var(--dsw-alias-bg-base, transparent)', color: 'var(--dsw-alias-label-primary, inherit)' },
          }, saveState === 'saving' ? t('saving') : t('save')),
          saveState === 'saved' ? h('span', { role: 'status', style: hintStyle }, t('saved')) : null));
    }

    return {
      // The settings service is deliberately NOT a hard dependency: the image
      // card must keep working in a composition without it, so the page is
      // contributed from a scoped inject below instead.
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-imagegen: dictionaries');
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'generate_image', locale: NS }, ImageResult));

        // The Plugins page renders a bundle's configuration section only while
        // a `plugins.bundle.config` entry owns the package name, so registering
        // this page is what makes the settings form appear. A failure here is
        // contained: the image card is the primary capability and stays usable.
        try {
          ctx.inject(['configForms'], (forms) => {
            const scope = forms.configForms.get('dsh-imagegen');
            ctx.effect(() => forms.configForms.whileServed(['dsh-imagegen'], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config',
              key: '@local/dsh-imagegen',
              locale: NS,
              inject: () => ({ t, scope }),
            }, ConfigPanel))), 'dsh-imagegen: configuration page');
          });
        } catch (error) {
          ctx.logger?.warn?.('dsh-imagegen: the configuration page could not be registered', error);
        }
      },
      ConfigPanel,
      dictionaries,
      draftOf,
      operationsOf,
    };
  },
});
