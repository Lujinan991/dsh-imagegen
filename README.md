# DSH AI 生图插件

这是 DSH 原生 Cordis 插件，不是 MCP 包装，也不需要单独启动服务。

让智能体用 `generate_image` 生成或编辑位图：文生图、参考图改图、PNG 蒙版局部编辑；图片保存为 DSH 持久附件并在对话里直接预览。

## 安装

在 DSH 左侧「插件」页面的安装入口填入本仓库地址：

```text
git+https://github.com/Lujinan991/dsh-imagegen.git
```

也可在启用了官方 `plugin_manager` 工具的会话中请求：

```json
{
  "action": "install_bundle",
  "target": "git+https://github.com/Lujinan991/dsh-imagegen.git"
}
```

本地开发时改为填入插件目录（或以 `link:` 依赖安装），这样源码改动会在下次启动生效：

```text
/absolute/path/to/dsh-imagegen
```

安装后确认插件行 `dsh-imagegen` 已启用。读取安装结果的 `application`：`applied` 表示已应用，`restart-required` 表示需重启。

**改动插件代码后必须完全退出应用再重新打开（⌘Q 后重启），只在「插件」页面切换开关是无效的。** 客户端代码在应用启动时被物化进浏览器模块表，切换开关不会重建它，所以旧代码会继续生效并报同样的错。从 git 安装时，更新同样需要重新安装 + 重启。

## 配置

**打开「插件」页面，进入本插件（`@local/dsh-imagegen`）的详情页，页面下半部分就是「生图接口」表单。** 填好后点「保存」，配置写入当前 profile 的 `cordis.patch.yml`，并在下一次调用生图工具时生效，无需重启。

插件注册了自己的 `plugins.bundle.config` 页面；DSH 不会按 Schema 自动生成表单，所以这个注册就是配置入口存在的原因。配置字段用 Schemastery `.volatile()` 声明，插件在每次调用时重新读取，因此保存后立即可用。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `https://api.openai.com/v1` | API 根地址，必须包含 `/v1` 这类根路径。缺失时会返回网页而不是 JSON，插件会直接指出这一点。 |
| `apiKey` | 空 | 生图服务密钥，标记为 secret，不回显、不暴露为工具参数。只在填写了内容时才写入。 |
| `apiKeyEnv` | `OPENAI_API_KEY` | `apiKey` 留空时，从 DSH 启动进程的环境变量读取。桌面版推荐直接使用配置字段。 |
| `model` | `gpt-image-2` | 默认图片模型；需要你的服务支持该模型。不会自动降级。 |
| `size` | `auto` | OpenAI 模型填 `WIDTHxHEIGHT`；按比例取值的服务填 `9:16` 这类比例。 |
| `resolution` | 空 | 服务商特有的分辨率档位（如 `1k`、`2k`、`4k`）。留空表示不发送该字段。 |
| `quality` | `auto` | `auto`、`low`、`medium`、`high`，另接受 `xhigh`、`max`。 |
| `background` | `auto` | `auto`、`opaque`、`transparent`。 |
| `outputFormat` | `auto` | `auto`（不发送该字段）、`png`、`jpeg`、`webp`。 |
| `submitMode` | `sync` | `async` 会以 `?async=true` 提交并轮询任务接口 —— **图片接口返回 `task_id` 的服务必须选它**。 |
| `taskPollMs` | `4000` | 任务状态轮询间隔，单位毫秒。 |
| `timeoutMs` | `300000` | 覆盖整次付费操作的超时（提交 + 轮询 + 下载），单位毫秒。 |
| `maxImages` | `4` | 单次最多生成数量，最大 10，同时受 DSH 附件限制。 |
| `maxImageBytes` | `52428800` | 单张输入/生成图片的字节限制。 |
| `maxResponseBytes` | `150000000` | 图片 API JSON 响应字节限制。 |
| `downloadHosts` | `[]` | 其它可信 HTTPS 域名精确列表。**API 接口地址本身的域名始终允许**；密钥不会发给其它域名。 |

远程 API 必须使用 HTTPS；本机 `localhost`/`127.0.0.1` 可以使用 HTTP。密钥不要写进提示词、工具调用或提交到仓库。

配置为空时插件仍然正常加载；只有真正调用 `generate_image` 且缺少接口地址或密钥时，才会返回一条可执行的提示，而不是让插件启动失败。

### 异步（任务制）服务商

部分服务商（例如 MigeAPI）的图片接口**不直接返回图片**，而是返回 `task_id`，需要再查询任务。对这类服务：

1. 把 `submitMode` 设为 **`async`**（提交时带 `?async=true`，这是拿到可查询任务的关键）；
2. `size` 填**比例**（如 `9:16`），`resolution` 填档位（如 `4k`）；
3. 插件会自动轮询 `GET {baseUrl}/images/tasks/{task_id}`，直到 `SUCCESS`/`FAILURE`，然后下载 `result_url`。

插件同时兼容两种提交响应结构：顶层 `task_id`（MigeAPI 图像接口）和 `data[].task_id`（其视频接口风格的结构），并且**只要响应里已经有图片就直接使用、绝不轮询**。任务失败会把服务商给出的原因原样报告；整次操作受 `timeoutMs` 约束，不会无限等待。

## 使用

直接在 DSH 对话里描述要生成的图片，智能体调用 `generate_image`。参考 Codex 的提示词规则已通过独立 system prompt section 注册：保持用户要求、逐字保留图片文字、编辑时明确不变项、不同素材使用不同请求。

工具示例：

```json
{
  "prompt": "产品摄影：白色陶瓷杯放在灰色桌面，柔和侧光，保留自然材质细节，无文字、无标志。",
  "size": "1536x1024",
  "n": 1
}
```

参考图/改图：

```json
{
  "mode": "edit",
  "prompt": "仅将背景替换为海边日落；保持第一张图中的产品、外形、颜色、标志与边缘不变。第二张图仅作色调参考。",
  "image_paths": ["product.png", "style-reference.png"]
}
```

局部编辑可额外提供 `mask_path`：PNG 蒙版须与首张输入图尺寸一致，透明区域表示修改区域。输入文件经 DSH `ctx.fs` 读取，不绕过文件权限。蒙版的 alpha 和尺寸由生图服务进一步验证。

同一提示词生成多个版本用 `n`；不同素材分别调用工具。透明背景需要兼容的模型和 PNG/WebP。参考资料中 `gpt-image-2` 不支持原生透明参数，因此插件拒绝该组合，不会擅自换成 `gpt-image-1.5`。

## 图片交付

- 原始图片通过 `ctx.attachments.saveFile` 逐字节保存，保留原始分辨率及 alpha。
- 预览通过 `ctx.attachments.saveImages` 保存为 DSH 原生持久图片引用。
- 对话中的图片工具视图显示预览、加载/失败状态、预览重试以及「打开原图」。
- 工具结果始终包含 DSH 原生 image content，使附件出现在持久 Session log 中并可由 Web 会话授权预览。当前聊天模型声明支持图片输入时，模型会收到图片供其检查；纯文本模型由 DSH 官方 LLM 投影逻辑将图片替换为可追踪的文字句柄，不会被图片块破坏后续请求；用户仍可看预览。
- 返回值含原图宿主路径。需要作为项目资产时，由智能体使用普通授权文件/命令工具复制到工作区；插件本身不直接向工作区写入二进制，不绕过沙箱，不覆盖已有素材。
- 本地 DSH 附件后端可返回宿主路径；非文件型后端可能返回空路径，仍有持久 original/preview 引用。

URL 结果仅从 `downloadHosts` 精确允许的 HTTPS 主机下载，下载不携带 API 密钥，不跟随重定向。API POST 也不跟随重定向。不自动重试收费请求，不静默换模型。服务调用失败、输出数量不符或附件验证失败会明确报错；若响应已成功生成但后续存储失败，服务可能仍已收费。

## 验证

在当前安装版 DSH `0.2.0-rc.2` 的隔离运行时运行 **37 项测试，全部通过**，不产生生图费用：

```sh
node --test plugin/tests/activation.test.js plugin/tests/client.test.js plugin/tests/image-api.test.js
```

覆盖内容包括：

- `.volatile()` 配置在空配置、部分配置和空字符串值下都能激活；接口地址为空或写成 `ftp://` 时的行为。
- 保存配置后，下一次调用立即读到新值，无需重新挂载。
- 客户端同时注册图片结果卡片和 `plugins.bundle.config` 配置页；没有 settings 服务、或配置页注册抛错时，图片卡片都仍然可用。
- 配置页渲染全部字段、密钥只写不回显、保存只提交真正改动的字段。
- 工具卡片只显示结果里真实存在的图片（避免展示已被策略移除的引用）。
- 异步任务全流程：`?async=true` 提交、两种提交响应结构、轮询到 `SUCCESS`、下载结果、`FAILURE` 带原因报错、非 JSON 轮询响应、超时收敛、已完成响应绝不触发轮询。
- 响应不是 JSON 时指出「baseUrl 可能少了 API 根路径」并附脱敏后的响应开头。
- 密钥永不进入报错文本；下载到第三方域名时不携带密钥，而 API 主机（已持有凭证）可以携带。

两条结构性约束由测试强制，防止再次出现「插件无法加载」：

- Host 模块的每个裸导入都必须在 `package.json` 的 dependencies/peerDependencies 中声明——Host 只解析清单里声明过的包。
- 浏览器模块只能 `require('react')`——客户端模块表只提供平台种子模块和已注册的包工厂，`require` 自己包的子路径会直接抛 `missed the module table`。

隔离运行时的准备方式：macOS 安装版可运行 `node tests/extract-runtime.mjs`，它把当前安装版模块复制到独立临时目录并打印目录路径，然后在那个目录里执行上面的测试命令。它不更改 DSH 安装目录、profile 或凭证。

实测范围及安装状态以交付说明为准；`image-api.test.js` 全部使用本地 mock，**不调用真实生图接口**。

## 参考

- [DSH 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方工具开发协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)
- [官方外部 Host 插件协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md)
- 本机 Codex `imagegen` skill 的提示词原则及 Images API 参数说明。未复制其内置工具、脚本或受 Codex 执行环境限制的指令。
