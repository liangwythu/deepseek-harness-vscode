# DeepSeek Harness Connector for VS Code (v0.0.3)

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue.svg)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![Version](https://img.shields.io/badge/version-0.0.3-blue.svg)](https://github.com/liangwythu/deepseek-harness-vscode/releases/tag/v0.0.3)

> DeepSeek Harness 的原生 VS Code 客户端。
>
> 连接你已在本地运行的 Harness 实例，直接在 VS Code 中继续相同的工作区和会话。

**同一个 Harness。同一个工作区。同一个会话。VS Code 客户端。**

这**不是** Cursor 的替代品，不是 Claude Code 的替代品，也不是完整的编码 Agent。它将 VS Code 连接到你已在运行的本地 `dsh web` 实例：

```
浏览器 ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘
```

VS Code 读取浏览器中已有的工作区和会话，并继续**同一个**会话——所以浏览器刷新该会话时能看到 VS Code 发送的内容。

## v0.0.3 新特性

**Diff 审查、审批工作流 & 文件内容内联** —— 补齐与 Cursor/Cline 最大的体验差距：代码变更可以在 VS Code 内完成审查和审批，无需切换到 Web UI。

- **Diff 审查与内联代码应用** —— Agent 写入或编辑文件时，侧边栏自动出现审查卡片，展示每个变更文件的 `+新增`/`-删除` 行数。点击 **Diff** 打开 VS Code 原生 diff 编辑器。支持逐文件 Accept（保留）/ Reject（通过 `git checkout` 安全回退），也可批量操作。
- **审批工作流集成** —— `approval/requested` 事件现在以内联卡片形式展示，带 **Allow once** / **Deny** 按钮。不再需要切浏览器审批。安全允许列表限制哪些工具可以在 VS Code 内审批，高风险操作仍需 Web UI。
- **@file 内容内联** —— 文件引用（`@file:path` 或 `@file:path:L10-L20`）的内容现在被直接读取并内联到用户消息中，确保 agent 始终能看到文件内容。`context` 元数据（活动文件、选区）仅在会话首次发送时附带。
- **右键菜单集成** —— 在资源管理器中右键文件 → **Add to Harness Chat**。在编辑器中选中文本 → 右键 → **Send Selection to Harness**。均使用工作区相对路径。

详见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

### 历史版本

- **v0.0.2** —— 对话 UX & 架构基线版：Assistant Markdown 渲染、Tool 卡片合并、System 消息折叠、惰性创建 workspace/session、流式渲染修复、架构加固。
- **v0.0.1** —— 首个公开版本：验证 VS Code 与浏览器共享同一个 Harness 会话。

## v0.0.3 做什么

- 连接到**本地** `dsh web`（仅限回环地址——`127.0.0.1` / `localhost`）。
- 将当前 VS Code 文件夹匹配到 Harness 工作区。若无匹配，工作区在**首次发送时惰性创建**——无弹窗。
- 列出该工作区已有的会话。
- 打开会话并渲染其历史记录。
- 向该会话发送纯文本提示。若无会话，自动创建。
- 实时流式传输助手回复，支持 **Markdown 渲染**（代码块、列表、表格、链接）。
- 将工具调用显示为**折叠卡片**，带语义化标题（`Read src/foo.ts`、`Search "pattern"`、`Run npm test`）。
- **审查 Agent 代码变更** —— diff 卡片支持逐文件 Accept/Reject，原生 VS Code diff 编辑器，批量 Accept All / Reject All。
- **审批或拒绝 Agent 操作** —— 内联审批卡片，Allow once / Deny 按钮（安全允许列表强制执行）。
- **附加文件上下文** —— 在提示中使用 `@file:path` 或 `@file:path:L10-L20`，文件内容自动读取并内联。右键资源管理器或编辑器可快速插入。
- 默认隐藏插件注入的系统消息；通过 `SYS` 按钮切换。
- 停止当前回合。
- 断线时重新打开流并重新获取历史记录。
- "在 Harness Web UI 中打开"命令。
- 通过 ⇲ 按钮将视图停靠在右侧边栏（像聊天面板一样）。

## v0.0.3 刻意不做的事

为安全起见，以下仍不在范围内：

- 不调用 `commands/execute`，不访问 `credentials` 或 `settings` API。
- 不切换模型。
- 不做内联补全、终端/LSP 集成。
- 高风险审批（如带不可信输入的 `bash`）不能在 VS Code 内批准——卡片显示"Review in Web UI"。
- 不建立第二份会话数据库——Harness Session 是**唯一**的真相源。
- 不自动安装/启动/升级 `dsh`。
- 不 fork 或修改 Harness 源码。

## 环境要求

- VS Code ≥ 1.85
- 正在运行的本地 `dsh web`（默认端口 `3080`）。本扩展**不会**为你启动它。

## 快速开始

1. 在本地启动 Harness：

   ```bash
   dsh web
   # → http://127.0.0.1:3080
   ```

2. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek) 安装，或通过命令行：

   ```bash
   code --install-extension lucasliang.harness-connector-deepseek
   ```

   或从 [GitHub Releases](https://github.com/liangwythu/deepseek-harness-vscode/releases) 安装 VSIX：

   ```bash
   code --install-extension harness-connector-deepseek-0.0.3.vsix
   ```

3. 在 VS Code 中打开一个你想绑定到 Harness 工作区的文件夹。

4. DeepSeek Harness 活动栏图标出现；扩展自动连接。如果你的文件夹匹配到一个已有的 Harness 工作区，其会话会出现在下拉列表中。选择一个，继续对话。

5. **没有匹配的工作区？** 直接输入提示按 Send——工作区和会话会自动创建。

6. **附加文件上下文** —— 输入 `@file:src/main.ts`，或在资源管理器中右键文件选择 **Add to Harness Chat**。在编辑器中选中文本，右键选择 **Send Selection to Harness** 可插入带行范围的引用。

7. 在浏览器中打开 `http://127.0.0.1:3080/` 的同一会话——两端看到的是同一轮对话。

## 配置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | **v0.0.x 仅允许 `127.0.0.1` 或 `localhost`。** 其他值会被拒绝。 |
| `deepseekHarness.port` | `3080` | 默认 `dsh web` 端口。如果你用 `dsh web --port <n>` 启动则需修改。 |
| `deepseekHarness.showSystemMessages` | `false` | 显示插件注入的系统消息（运行时上下文、审批通知）。默认隐藏；可通过 webview 头部的 `SYS` 按钮实时切换。 |

## 命令

- `DeepSeek Harness: Connect` / `Disconnect`（连接 / 断开）
- `DeepSeek Harness: New Session`（在当前工作区新建会话）
- `DeepSeek Harness: Refresh Sessions`（刷新会话列表）
- `DeepSeek Harness: Move to Right Side Bar`（移至右侧边栏）——将视图停靠在辅助侧边栏（像聊天面板一样），不再与文件浏览器争抢左侧空间。也可通过 webview 头部的 ⇲ 按钮触发。
- `DeepSeek Harness: Open Web UI`（打开 Web UI）
- `DeepSeek Harness: Show Logs`（显示日志，即 `DeepSeek Harness` 输出通道）

### 右键菜单操作

- **Add to Harness Chat**（资源管理器右键）—— 将 `@file:<相对路径>` 插入聊天输入框。
- **Send Selection to Harness**（编辑器右键，需选中文本）—— 将 `@file:<相对路径>:L<起始行>-L<结束行>` 插入聊天输入框。

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
npm run package      # → harness-connector-deepseek-0.0.3.vsix
```

在 VS Code 中按 `F5` 启动带有该扩展的扩展开发宿主。

## 已验证版本

- DeepSeek Harness host `v0.0.1`（`@deepseek-ai/dsh-root`），默认 `dsh web` 端口 `3080`。
- 线缆契约：`packages/host/apiproxy/src/api/`（权威来源）。

## 限制

- 仅限回环——不支持远程 / 局域网 / WSL 桥接的主机。
- 仅支持文本提示（不支持图片附件）。
- 历史记录加载最近约 50 条消息；"加载更早"是未来版本的计划。
- "Open Web UI" 中的会话深链接不做猜测——只打开 Harness 首页。
- 未知的 harness 事件类型会被忽略（协议是可合并扩展的）；它们不会导致客户端崩溃，但也不会渲染。
- Diff 审查的 Reject 使用 `git checkout` 回退——目标文件上未提交的本地修改会在 Reject 时丢失。

## 路线图（v0.0.4+）

- 内联补全（Inline Completion）
- VS Code 文件系统提供器
- 终端集成
- LSP / ACP 集成
- 图片附件

## 许可证

MIT
