# @mostkia/dsh-htmlui

[English](README.md) | 中文

**把 HTML 变成会话 UI，给 DeepSeek Harness 用。** 模型写 HTML/CSS/JS，插件把它放进沙箱 iframe 挂到对话上，界面里的交互再通过 POST + SSE 回到模型。

dsh-genui 渲染的是白名单 JSON 组件；本插件渲染的是真东西：任意 HTML、任意 CSS、任意脚本，放在会话需要的位置。

## 效果

| 你说 | 你得到 |
|---|---|
| "给我做这个月订单的看板" | 一个真 HTML 看板，就地长在回答里，自己的表格和图 |
| "做个表单帮我把报告提交上去" | 表单提交才跨到模型，其余校验全在本地 |
| "干活的时候把它挂在旁边" | 同一份文档停靠在输入框上方，或变成可拖动浮窗 |
| "干脆让它当主界面" | 全覆盖模式：文档接管会话，并自带「切回聊天」按钮 |

## 七种形态

| `placement` | 位置 |
|---|---|
| `inline` | 聊天流内，跟着创建它的那次工具调用 |
| `dock-top` / `dock-bottom` | 输入框上方 / 下方的整宽区域 |
| `panel` | 同一个停靠区，原地更新 |
| `float` | 可拖动、可缩放的窗口（`size: "520x360+80+60"`） |
| `background` | 覆盖整帧的指针穿透层 |
| `fullscreen` | 覆盖整个会话，内置切回聊天的按钮 |
| `dock-right` | 会话右侧栏，作为承载该会话右侧界面的一个标签页（该列没有 tab 服务时回落为输入框上方停靠） |

文档可以自己声明它该待在哪，而不必由调用方指定——模板因此能把"家在哪儿"一起带走：

```html
<meta name="dsh-htmlui" content="placement=dock-top; size=520x360; title=订单看板">
```

优先级：工具参数 > 文档声明 > 默认 `inline`；不可用的值会被忽略而不是报错。

## 安装

```sh
dsh plugin --profile web add @mostkia/dsh-htmlui
```

没有 npm 也能装，直接从仓库：

```sh
dsh plugin --profile web add github:mostkia/dsh-htmlui
```

要求 DSH `>=0.1.7-0`（故意包含预发布线，`0.1.7-rc.*` 也能装）。装完硬刷新页面；客户端半部生效时浏览器控制台会打印 `[dsh-htmlui] client active (0.1.1)`。

两条最省事的"确认运行中的宿主装的是哪一代"：

```sh
curl -s http://127.0.0.1:3080/plugins/@mostkia/dsh-htmlui/health
# {"ok":true,"plugin":"@mostkia/dsh-htmlui","version":"0.1.1",...}
```

改宿主半部（`index.js`）**不会**在运行中的宿主里热生效：加载器仍用它已激活的模块代际。改完宿主半部要冷启动 `dsh`；浏览器半部只需刷新页面。

[docs/VERIFY.md](docs/VERIFY.md) 是真机验收清单：当前跑的是哪一代、每种形态该长什么样、回传模型时在对话里怎么体现、以及看到某个症状该查什么。

## 工作原理

- **宿主半部**（`index.js`，纯 ESM，零依赖）：`html_ui` / `html_ui_template` 两个工具、`$DSH_HOME/htmlui` 下的存储、以及挂在 `/plugins/@mostkia/dsh-htmlui` 的 HTTP 载体（文档票据、拼装后的文档、POST 动作通道、SSE 事件流）。
- **浏览器半部**（`client.js`，手写模块，无需构建）：注册工具卡片、输入框停靠区、整帧浮层，并把每份文档放进 iframe。
- **桥**（`assets/bridge.js`，服务时注入）：暴露 `window.dshHTML`，提供 `send`、`state`、`resize`、`close`、`on(...)`。

**模型永远拿不到文档正文**：它读到的是工具结果的紧凑摘要（`ui_id`/`placement`/`bytes`/revision），文档本身由浏览器从载体的票据路由加载。大文档写进文件、用 `path` 引用，所以不会常驻模型上下文。

## 安全

文档运行在 `sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"` 的 iframe 里，**不含** `allow-same-origin`：不透明源，没有 cookie、没有本地存储、碰不到宿主页面。每份文档带一个按文档派生的能力令牌（插件本地 secret 的 HMAC），文档、动作、状态、SSE 四条路由都由它把关。该令牌只出现在一个地方——票据路由交出的 iframe URL——所以工具结果、会话日志、列表响应、事件流帧里都不会有它，而且不带令牌的地址根本加载不了。

载体自身的策略：只信回环 Host/Origin 配对；不透明源的 frame 必须有合法令牌；跨站票据请求直接拒绝；写操作只收 POST；每份文档一个小令牌桶，防止脚本刷爆模型。文档里不该出现任何秘密，插件也从不索取。

如果 DSH 被故意暴露到回环之外（`webServer.host: 0.0.0.0`、局域网地址、反向代理），浏览器来源就会是默认策略拒绝的那个，整个插件会一律 403。把那个来源写进 `allowedOrigins` 即被信任——仅限那一个来源，别的一概不放：

```yaml
      config:
        allowedOrigins:
          - http://dsh.lan:3080
```

`/health` 会报出 `trust.loopbackOnly` 与已列来源数量，当前姿态不用猜。

## 配置

行配置全部可选，且不需要任何本机路径：

```yaml
- insert:
    - id: dsh-htmlui
      name: '@mostkia/dsh-htmlui'
      config:
        root: ''              # 存储根目录，默认 $DSH_HOME/htmlui
        maxInlineBytes: 16384 # 单段内联 html/css/js 的上限
        actionPrompt: ''      # 追加在 [html-ui:action] 消息末尾的指令句
        allowedOrigins: []    # 额外信任的浏览器来源（见「安全」）
```

运行期数据都在 `$DSH_HOME/htmlui`：`ui/<id>/index.html`（作者写的文档，磁盘上保持干净可移植，不做任何注入）、`templates/<name>/`（托管模板）或 `templates/<name>.html`（手写模板）、`state/<session>.json`，以及用于能力令牌的 `secret`。

## 模板

```
html_ui_template { "op": "save", "name": "orders-dashboard", "ui_id": "ui-1a2b3c4d" }
html_ui { "op": "render", "template": "orders-dashboard", "variables": { "title": "本周订单" } }
```

`{{token}}` 占位符由 `variables` 替换。模板跨会话存活；包内自带 `templates/starter` 作为可直接读的示例。

**手写的文档也是模板**：把 `my-panel.html` 直接丢进 `<root>/templates/`，就能用 `template: "my-panel"` 调用，不用写任何清单文件。同名托管模板存在时优先，删掉它又会露出那个手写文件。

## 开发

```sh
npm test        # 97 项断言：包完整性 12 + 文档契约 9 + 宿主 27 + 浏览器 21 + 桥 9 + 浅渲染 9 + 对抗输入 10
npm run check   # 先语法检查三个出厂脚本，再跑测试
```

两边都没有构建步骤：宿主半部是纯 ESM，浏览器半部就是加载器直接物化的那个模块。两者都是纯 JavaScript，运行时不依赖 harness 的模块图，插件本身零依赖。CI 在 Ubuntu 与 Windows 上、Node 22 与 24 四个组合跑同一套测试（`.github/workflows/ci.yml`）。发布步骤与已备好的 awesome-dsh-plugin 条目见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 许可

MIT
