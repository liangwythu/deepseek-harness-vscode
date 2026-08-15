# DeepSeek Harness for VS Code (v0.0.1)

[English](./README.md) | [简体中文](./README.zh-CN.md)

> DeepSeek Harness 的原生 VS Code 客户端。
>
> 连接你已在本地运行的 Harness 实例，直接在 VS Code 中继续相同的工作区和会话。

**同一个 Harness。同一个工作区。同一个会话。VS Code 客户端。**

这**不是** Cursor 的替代品，不是 Claude Code 的替代品，也不是完整的编码 Agent。v0.0.1 只证明一件事：

```
浏览器 ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘
```

VS Code 连接到你已在运行的本地 `dsh web` 实例，读取浏览器中已有的工作区和会话，并继续**同一个**会话——所以浏览器刷新该会话时能看到 VS Code 发送的内容。

## v0.0.1 做什么

- 连接到**本地** `dsh web`（仅限回环地址——`127.0.0.1` / `localhost`）。
- 将当前 VS Code 文件夹匹配到 Harness 工作区（若不存在则提示创建）。
- 列出该工作区已有的会话。
- 打开会话并渲染其历史记录。
- 向该会话发送纯文本提示。
- 实时流式传输助手回复（文本增量 + 工具活动）。
- 停止当前回合。
- 断线时重新打开流并重新获取历史记录。
- "在 Harness Web UI 中打开"命令。

## v0.0.1 刻意不做的事

为安全起见，v0.0.1 拒绝触碰读取 + 提示 + 取消之外的任何操作：

- 不调用 `/api/respond`，不批准/拒绝审批，不修改权限。
- 不调用 `commands/execute`，不访问 `credentials` 或 `settings` API。
- 不切换模型。
- 不做差异审查、文件编辑、内联补全、终端/LSP 集成。
- 不建立第二份会话数据库——Harness Session 是**唯一**的真相源。
- 不自动安装/启动/升级 `dsh`。
- 不 fork 或修改 Harness 源码。

如果某个操作需要审批，VS Code 只显示：

> 该操作需要在 DeepSeek Harness Web UI 中审批

绝不代你响应。

## 环境要求

- VS Code ≥ 1.85
- 正在运行的本地 `dsh web`（默认端口 `3080`）。本扩展**不会**为你启动它。

## 快速开始

1. 在本地启动 Harness：

   ```bash
   dsh web
   # → http://127.0.0.1:3080
   ```

2. 安装 VSIX（见 [Releases](#) 或从源码构建）：

   ```bash
   code --install-extension deepseek-harness-vscode-0.0.1.vsix
   ```

3. 在 VS Code 中打开一个你想绑定到 Harness 工作区的文件夹。

4. DeepSeek Harness 活动栏图标出现；扩展自动连接。如果你的文件夹匹配到一个已有的 Harness 工作区，其会话会出现在下拉列表中。选择一个，继续对话。

5. 在浏览器中打开 `http://127.0.0.1:3080/` 的同一会话——两端看到的是同一轮对话。

## 配置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | **v0.0.1 仅允许 `127.0.0.1` 或 `localhost`。** 其他值会被拒绝。 |
| `deepseekHarness.port` | `3080` | 默认 `dsh web` 端口。如果你用 `dsh web --port <n>` 启动则需修改。 |
| `deepseekHarness.showSystemMessages` | `false` | 显示插件注入的系统消息（运行时上下文、审批通知）。默认隐藏；可通过 webview 头部的 `SYS` 按钮实时切换。 |

## 命令

- `DeepSeek Harness: Connect` / `Disconnect`（连接 / 断开）
- `DeepSeek Harness: New Session`（在当前工作区新建会话）
- `DeepSeek Harness: Refresh Sessions`（刷新会话列表）
- `DeepSeek Harness: Move to Right Side Bar`（移至右侧边栏）——将视图停靠在辅助侧边栏（像聊天面板一样），不再与文件浏览器争抢左侧空间。也可通过 webview 头部的 ⇲ 按钮触发。
- `DeepSeek Harness: Open Web UI`（打开 Web UI）
- `DeepSeek Harness: Show Logs`（显示日志，即 `DeepSeek Harness` 输出通道）

## 架构

见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) 了解一页式设计和协议契约。

## 协议固件

`test/fixtures/` 存放了线缆格式的脱敏快照，用于检测上游 Harness 协议漂移：

- `host-describe.json`、`workspace-list.json`、`session-list.json`、`session-history.json`、`session-prompt.json`、`session-event.json`

不存储任何凭据、API 密钥或真实提示内容——仅保留 JSON 结构（文本字段已脱敏）。

## 协议探测

一个独立的 Node 脚本可在你运行的 `dsh web` 上验证完整闭环：

```bash
npm run spike            # 只读验证（连接 / 列表 / 历史 / 打开 mux）
npm run spike -- --prompt  # 同时测试提示 + 实时事件 + 取消
```

## 开发

```bash
npm install
npm run build        # esbuild → dist/extension.js
npm run watch        # 变更时自动重建
npm run typecheck
npm run package      # → deepseek-harness-vscode-0.0.1.vsix
```

在 VS Code 中按 `F5` 启动带有该扩展的扩展开发宿主。

## 已验证版本

- DeepSeek Harness host `v0.0.1`（`@deepseek-ai/dsh-root`），默认 `dsh web` 端口 `3080`。
- 线缆契约：`packages/host/apiproxy/src/api/`（权威来源）。

## 限制

- 仅限回环——不支持远程 / 局域网 / WSL 桥接的主机。
- 仅支持文本提示（不支持图片附件）。
- 历史记录加载最近约 50 条消息；"加载更早"是 v0.0.2 的计划。
- "Open Web UI" 中的会话深链接不做猜测——只打开 Harness 首页。
- 未知的 harness 事件类型会被忽略（协议是可合并扩展的）；它们不会导致客户端崩溃，但也不会渲染。

## v0.0.2 TODO（已记录，未实现）

- 差异审查（Diff Review）
- 审批集成（Approval integration）
- 内联补全（Inline Completion）
- VS Code 文件系统提供器

## 许可证

MIT
