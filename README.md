# Cooper Code

Cooper Code 是 AI 编码助手，提供终端界面和 Windows 桌面预览。用自然语言交代任务，它会阅读代码、修改文件、运行测试，再把结果带回同一个对话。

## 它能做什么

- **先看方案，再动手。** `plan` 模式可以只读地梳理代码。`ask` 模式由你批准文件改动、命令和网络请求。Windows 和 Linux 可显式启用 `auto`，在工作区校验普通文件改动，对 shell 命令进行独立审核。 [权限模式](USAGE.md#权限模式)
- **从对话到脚本。** 在交互界面跟进多步任务；用 `-p` 发起单次请求，stdout 只有模型的回答，工具进度和诊断走 stderr，可以直接重定向给脚本。
- **接着上次做。** 会话按工作区保存，重开终端后用 `--resume` 继续；`--sessions` 列出当前工作区的会话。
- **接自己的模型。** 支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三种协议，模型 ID、服务地址和 API 密钥由你配置；实验性的模型档位（`sera`、`cher`、`thr`）可在多个模型之间随时切换。
- **按需扩展。** Skills 让模型按需加载你写的工作流；MCP 接入外部工具服务器；内置网页抓取与搜索。

## 快速开始

### Windows x64 安装

| 入口 | 安装包 | 启动方式 |
| --- | --- | --- |
| CLI | `CooperSetup-<版本>-windows-x64.exe` | 在新终端运行 `cooper` |
| Desktop | `CooperDesktopSetup-<版本>-windows-x64.exe` | 从开始菜单打开 **Cooper Desktop** |

两个安装包都内置 PowerShell 7 和 MXC 沙箱助手。首次启动时选择 API 协议，填写模型 ID、服务地址和 API 密钥。Desktop 随后会让你选择工作区。CLI 的安装、修复与卸载说明见 [使用参考](USAGE.md#windows-x64-原生试装)。

### npm CLI

```bash
npm install -g @cooper-intelligence/cooper-code
cooper
```

npm 版需要 Node.js 22.12.0 或更高版本。Windows 上需要由 Cooper 运行命令时，请使用原生安装包。 [各平台的命令支持](USAGE.md#权限模式)

### 从源码运行

需要 Node.js 22.12.0 或更高版本。在仓库根目录运行：

```bash
npm install
npm run dev
```

首次交互启动时，按引导选择 API 协议，填写模型 ID、服务地址和 API 密钥。

试着输入「找出处理登录请求的代码，解释调用链，并给出需要补测的场景」。在输入框键入 `/help` 查看交互命令。

```bash
npm run dev -- --mode plan                          # 只读梳理代码
npm run --silent dev -- -p "解释这个项目的入口"      # 单次请求，回答可重定向
npm run dev -- --sessions                           # 列出当前工作区的会话
npm run dev -- --resume <id>                        # 继续已有会话
```

### Desktop 开发预览

在仓库根目录运行 `npm run dev:desktop`。首次启动会下载 Electron 运行时。Desktop 与 CLI 共用 `~/.cooper/config.json`，缺少模型配置时会在打开工作区前提供引导。之后可从侧栏的 **Model settings** 修改连接。

在窗口中选择工作区即可发送消息，也可从侧栏恢复相同工作区的既有会话。Windows 中，`Ask` 和 `Auto` 都在 MXC 内运行随包 PowerShell 7。沙箱内的项目目录和单次调用临时目录可写。`Ask` 由用户批准，`Auto` 单独审核 shell 命令。恢复会话时需要重新开启 Auto。 [权限模式](USAGE.md#权限模式)

在 Windows 上调试沙箱时，准备一份包含助手和 `powershell/pwsh.exe` 的独立运行时目录，再通过 `COOPER_WINDOWS_RUNTIME_DIR` 指向该目录。运行时目录应放在本次打开的工作区外。 [开发运行时布局](docs/cli.md#windows-原生安装包构建)

```powershell
$env:COOPER_WINDOWS_RUNTIME_DIR = (./scripts/build-windows-runtime.ps1).FullName
npm run dev:desktop
```

输入框默认用 Enter 发送，Shift+Enter 换行。可在 **Send with** 中改为 Ctrl/⌘+Enter 或 Shift+Enter 发送，单按 Enter 即换行。此偏好会在重启后保留。

Desktop 会按工作区和会话保存草稿，用户消息写入会话后才清空输入框。重开时如有发送状态待确认的草稿，先检查会话记录，再选择继续编辑。

Desktop 新建的 v2 会话会记录回合终态。重开时，Cooper 会核对未确认的提交，并在找到原记录后打开对应会话。被停止或中断的回合可点 **Continue**。如果有副作用的工具结果未知，先点 **Review interrupted tools** 做只读核对，再确认继续。TUI 和 headless 可以恢复已完成的 v2 会话，待恢复的回合在 Desktop 处理。已有 v1 会话继续使用原格式。

模型端点提供的推理文本或摘要可以在当次对话里展开查看。开启配置中的 `showReasoning` 会默认展开。推理展示不会随会话保存。

## 文档

- [使用参考](USAGE.md) — 命令行参数、交互命令、配置文件、权限模式、扩展接入。
- [源码与设计](docs/README.md) — 架构、模块边界与实现约束，面向改动代码的开发者。
- [MIT 许可证](LICENSE) · [仓库约束 AGENTS.md](AGENTS.md)
