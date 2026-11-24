# 使用参考

面向使用者的完整参考：命令行参数、交互命令、配置文件、权限模式与扩展接入。实现方式与设计约束见 [源码与设计](docs/README.md)，产品介绍见 [README](README.md)。

## 运行

### Windows x64 原生试装

运行对应版本的 `CooperSetup-<版本>-windows-x64.exe`。安装使用当前 Windows 账户。完成后打开新的终端，用 `cooper --version` 检查版本，再运行 `cooper`。

重跑安装包可以修复安装文件和用户 `PATH`。如果 Cooper CLI 正在运行，先退出相应实例。卸载入口在 Windows「已安装的应用」里的 **Cooper CLI**，重装后仍可使用 `~/.cooper` 下的配置和会话。

### npm 与源码运行

需要 Node.js 22.12.0 或更高版本。

```bash
npm install
npm run dev                # 从源码启动 TUI
npm run dev -- <参数>       # 带参数运行
npm run build              # 打包到 apps/cli/dist/cooper.mjs（bin 名 cooper）
```

### Linux 沙箱

Linux 的 Ask 和 Auto 通过 MXC Bubblewrap 执行命令。源码构建需要 Rust、OpenSSL 开发库和发行版的 `bubblewrap`。运行 `npm run build:linux-sandbox` 后，CLI 和 Desktop 开发入口会使用构建出的助手。
助手必须位于可写的工作区之外。从 Cooper 源码启动时，可选择另一个项目作为工作区，例如 `npm run dev -- --cwd /home/alice/projects/example`。

默认 shell 禁止出站。可以在用户配置中为一个工作区的真实绝对路径开启出站。条目只匹配该工作区，子工作区需各自配置。

```json
{ "linuxNetworkWorkspaces": ["/home/alice/projects/example"] }
```

联网执行仍受同一文件边界约束。联网后端需要 TUN、slirp4netns、iproute2、util-linux 和 iptables 等主机依赖。助手或运行条件缺失时，shell 返回启动错误。 [MXC Bubblewrap 要求](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/bwrap/bubblewrap-backend.md#prerequisites)

## 命令行参数

| 参数 | 行为 |
| --- | --- |
| `-p` / `--print [文本]` | 显式启动无头单次请求，省略文本或写 `-` 时从 stdin 读取 |
| `update [--check]` | 更新命令，当前构建会提示在线更新尚未接入 |
| `rollback` | 通过原生 launcher 激活上一个本地安装版本 |
| `-m` / `--mode <模式>` | 启动模式：`plan`、`ask`、`auto` |
| `-C` / `--cwd <目录>` | 工作区目录，默认启动目录 |
| `-r` / `--resume <id>` | 继续已保存的会话；接受完整 id 或唯一前缀 |
| `--sessions` | 列出当前工作区的会话后退出 |
| `--no-session` | 本次不写会话文件 |
| `--tier <档位>` | 选择 `sera`、`cher`、`thr`（覆盖会话保存的档位） |
| `--mcp-project` | 允许加载 `<工作区>/.cooper/mcp.json` |
| `--mcp-config <文件>` | 追加一份 MCP 配置，可重复传入 |
| `--show-reasoning` | 显示端点支持的推理文本或摘要 |
| `--version` | 显示实际启动的 CLI 版本并退出 |
| `-h` / `--help` | 查看帮助 |

规则与优先级：

- 长参数支持 `--flag=value`；未知参数直接报错。
- 只能有一个提示；`--resume` 不能与 `--no-session` 同用；`--sessions` 不能与提示或 `--resume` 同用。
- 工作区由 `--cwd` 决定，文件工具、命令启动目录、项目指令、项目级 MCP 配置和会话都归属它。
- 启动模式取值顺序：`--mode` > 会话保存的 `plan`/`ask` > `config.json` 的 `mode` > `ask`。配置里的 `mode` 只接受 `plan` 和 `ask`，环境变量不参与选择；要在一个新进程里启用自动批准，必须显式传 `--mode auto`。

## 无头模式（`-p`）

旧脚本中的 `cooper "解释这个项目"` 改用 `cooper -p "解释这个项目"`。裸文本按命令解析，未知命令直接报错。

```bash
npm run --silent dev -- -p "解释这个项目的入口" > answer.md   # --silent 避免 npm 输出命令标题
npm run dev -- -p - < prompt.txt                             # 从 stdin 读提示
echo "列出行数最多的文件" | npm run dev -- -p
```

- stdout 只写模型的回答，可直接重定向；工具进度、会话状态、模式提示、MCP 状态、诊断和推理输出走 stderr。
- 退出码：成功 `0`，错误或达到轮次上限 `1`，被中断 `130`。
- 无头模式下，`ask` 和 `plan` 都会拒绝写文件、执行命令和网络请求。Windows 和 Linux `--mode auto` 会校验普通文件改动并单独审核 `shell`，其他需要人工审批的调用会被拒绝。
- 配置缺少必填字段时无头启动直接报错，不进入首次引导。
- 提示里写 `/skill <name> [请求]` 可以在本次请求中启用一个 Skill。

## 交互界面

- 输入 `/` 浏览命令，方向键选择，Tab 补全，Enter 执行，Esc 关闭候选。
- 审批面板：`←` / `→` 翻页查看差异或命令，`y` 批准本次，`n` 或 Esc 拒绝，`a` 查看并授予该工具的进程内授权范围（再按 `y` 确认），Enter 不触发批准。
- 推理默认只显示进度；用 `--show-reasoning` 或配置 `showReasoning` 打开后，推理按完整行追加显示。

## 斜杠命令

| 命令 | 用途 |
| --- | --- |
| `/help`、`/exit` | 显示帮助或退出 |
| `/plan`、`/ask`、`/auto` | 空闲时切换权限模式 |
| `/clear`（`/new`、`/reset`） | 开启新对话，保留原会话文件与当前模式 |
| `/sessions`、`/resume <id>` | 列出会话，或切换到已有会话（id 可用唯一前缀） |
| `/compact` | 在达到摘要阈值时手动压缩上下文 |
| `/sera`、`/cher`、`/thr` | 切换模型档位 |
| `/status` | 查看生效配置、来源与上下文占用 |
| `/config [设置项]` | 打开配置编辑器：Enter 编辑，Ctrl+S 保存并应用，Esc 先退出编辑态、再按一次关闭编辑器 |
| `/reload` | 重新读取外部修改过的 `config.json` |
| `/tools`、`/mcp`、`/skills` | 查看工具与能力、MCP 状态、已发现的 Skill |
| `/skill <name> [请求]` | 为本轮选择一个 Skill |

命令只在空闲时执行：任务进行中输入命令会提示等待（`/skill` 例外，忙碌时被静默忽略，不发送也不提示）；以 `/` 开头但不匹配的输入会报 `Unknown command`，不会发给模型。模式切换只在空闲时生效，且不会改写已发送的系统提示。

## 权限模式

| 模式 | 读取类工具 | 写文件 / 执行命令 / 网络请求 |
| --- | --- | --- |
| `plan` | 允许 | 直接拒绝 |
| `ask`（交互） | 允许 | 每次询问。CLI 可以在确认时授权整个工具到进程退出 |
| `ask`（无头 `-p`） | 允许 | 直接拒绝 |
| `auto`（Windows / Linux） | 允许 | 普通工作区编辑通过校验后执行。`shell` 单独审核。敏感编辑和其他受管控工具在交互界面转人工，无头运行拒绝 |

- 网络工具在 `ask` 下逐次确认，不能被进程内授权覆盖。
- CLI 对其他受管控工具提供按工具名授权到进程退出的选项。授权只保存在内存，切换到 `plan` 后仍执行只读限制。Desktop 当前只支持批准本次调用。
- 恢复会话只会带回 `plan` 或 `ask`；保存过 `auto` 的会话在新进程里不会自动恢复为 `auto`，需要 `--mode auto` 或 TUI 里 `/auto`。
- Windows 下 `Ask` 与 `Auto` 共用 MXC。项目目录和单次调用的临时目录可写，shell 网络访问被拒绝。系统盘根、用户目录及其上级不能用作可写工作区。助手缺失、系统不支持或沙箱启动失败时，Cooper 会返回错误。
- Windows Auto 的审核复用会话的模型端点，发起一次独立请求。审核看实际命令、用户授权和执行边界。审核无法给出有效结论时转人工，无头运行拒绝。
- Linux 的 Ask 和 Auto 共用 MXC Bubblewrap。macOS 的交互 Ask 经用户批准使用宿主 shell，CLI Auto 下内置 shell 因缺少沙箱而停止。Desktop 检测到沙箱助手后才开放 `auto`。

## 配置文件

配置位于 `~/.cooper/config.json`。四个连接字段必填：

```json
{
  "protocol": "openai-responses",
  "model": "<服务支持的模型 ID>",
  "baseURL": "https://api.openai.com/v1",
  "apiKey": "<API 密钥>"
}
```

协议可选 `openai-chat`、`openai-responses`、`anthropic-messages`。`baseURL` 必须是绝对的 http(s) 地址。

| 字段 | 默认 |
| --- | --- |
| `maxOutputTokens` | 64,000 |
| `showReasoning` | `false`；`--show-reasoning` 优先 |
| `mode` | `plan` 或 `ask`，默认 `ask` |
| `context.window` | 按模型窗口表推断，未知模型按 200,000 tokens |
| `context.reserveOutputTokens` | 16,384 |
| `context.compact` | `true` |
| `context.summaryModel` | 使用主模型 |
| `shell` | Windows 固定使用安装包自带的 PowerShell 7，Linux 默认 Bash，macOS 默认 zsh |
| `webSearch` | 默认使用 Tavily 免费免 Key 搜索，设为 `false` 可关闭 |

- 首次在交互界面启动且缺少必填字段时进入引导：选择协议、模型 ID（必填）、可选的上下文窗口、服务地址与密钥，再用该配置请求一次模型列表（10 秒超时）验证连接；验证失败可重试、修改或跳过，放弃则退出并提示手工写入。无头或重定向启动不会进入引导，直接报错。
- 编辑器可改四个连接字段、`maxOutputTokens`、`showReasoning`、`mode` 和四个 `context.*`。在 Linux 和 macOS 上也可编辑 `shell`。`webSearch`、`defaultTier`、`modelTiers` 只能手改文件后用 `/reload` 应用。
- 未知字段、疑似密钥的其他字段、旧的 `env` 对象、`mode: "auto"` 都只是警告并忽略；JSON 语法错误或类型不匹配是硬错误，不会静默改变行为。
- `/config` 保存时先写同目录临时文件（POSIX 上权限 `0600`）再替换，并检查保存期间是否被外部修改；`/reload` 应用外部编辑，校验失败时继续使用已生效的配置。
- 旧配置可以把 `env` 中的 `COOPER_BASE_URL`、`COOPER_API_KEY` 移到顶层 `baseURL`、`apiKey`，然后删除 `env`。

在 Linux 和 macOS 上，命令解释器可以通过 `shell` 设置覆盖。

```json
{ "shell": { "kind": "pwsh" } }
```

可选解释器为 `pwsh`、`sh`、`bash` 或 `zsh`。`shell.executable` 接受绝对路径。Windows 会提示并忽略旧的 `shell` 配置。Windows npm 包使用同样的权限策略，内置 shell 需要原生安装包提供的运行时。

## 模型档位（实验性）

三个档位共用顶层 `protocol`、`baseURL`、`apiKey`：

```json
{
  "model": "fallback-model-id",
  "context": { "window": 256000 },
  "defaultTier": "cher",
  "modelTiers": {
    "sera": { "model": "large-model-id", "reasoningEffort": "high" },
    "cher": { "model": "balanced-model-id", "displayName": "Balanced", "maxOutputTokens": 16384 },
    "thr": { "model": "fast-model-id", "contextWindow": 256000 }
  }
}
```

- 每档字段：`model`（必填）、`displayName`、`reasoningEffort`、`contextWindow`、`maxOutputTokens`。
- 配置了档位时，每档与兜底模型的有效窗口至少 256,000 tokens，`maxOutputTokens` 必须小于窗口。传入 `--tier` 即使没有配置任何档位也会启用同一套校验（此时用顶层模型充当该档位），窗口不足会直接启动失败。
- 启动按 `--tier`、会话保存的档位、`defaultTier` 选择；配置了档位而未指定时默认 `cher`。
- TUI 切换时先按目标模型估算输入，预算不足会显示估算与上限，确认并压缩成功后才提交；无头恢复遇到预算不足会报告原因并退出。

## 会话

- 会话保存在 `~/.cooper/projects/<工作区标识>/sessions/<id>.jsonl`，默认对 TUI 和无头运行都生效。
- `--sessions` 或 `/sessions` 列出当前工作区的会话；`--resume <id>` / `/resume <id>` 继续；`--no-session` 关闭本次持久化。
- `/clear` 开启新对话，原会话文件保留。
- 展示用推理和进程内授权不写入会话文件。

## 工具

| 工具 | 能力 |
| --- | --- |
| `list_dir`、`read`、`grep` | `read` |
| `load_skill`、`mcp_list_resources`、`mcp_list_resource_templates`、`mcp_read_resource` | `read` |
| `write`、`edit` | `write` |
| `shell` | `execute` |
| MCP 服务器暴露的工具（`mcp__<server>__<tool>`） | `execute` |
| `web_fetch`、`web_search` | `network` |

`/tools` 可以随时查看当前生效的工具与能力。文件工具校验工作区边界。命令从工作区内启动，Windows 原生版还通过 MXC 限制 shell 的访问范围。受信任的 MCP 服务器使用其自身的进程或远端环境执行。

`shell` 的每次调用都需要 `description`。模型用一句话说明命令的目的和主要影响，复合命令应概括重要步骤。审批面板同时显示这句说明和实际命令。

## Skills

- 目录：`<工作区>/.cooper/skills/`、`<工作区>/.agents/skills/`、`~/.cooper/skills/`、`~/.agents/skills/`，同名时前者优先。
- 每个 Skill 是一个目录，内含 `SKILL.md`：YAML frontmatter 必须有 `name`（与目录同名）和 `description`。
- 正文和引用文件各限 64 KiB，引用路径只能在该 Skill 目录内；`allowed-tools` 之类字段不改变权限，脚本仍通过 `shell` 按常规权限执行。
- 新增或修改 Skill 后重启进程刷新目录。TUI 用 `/skills` 查看、`/skill <name> [请求]` 启用，无头模式把 `/skill <name> [请求]` 作为提示传入。

## MCP

```json
{
  "mcpServers": {
    "local": { "command": "node", "args": ["/path/to/trusted-mcp-server.mjs"] },
    "remote": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

- 加载顺序：`~/.cooper/mcp.json` → 显式 `--mcp-project` 后的 `<工作区>/.cooper/mcp.json` → 可重复的 `--mcp-config <文件>`，同名服务器后者覆盖前者。
- 工作区配置默认不加载，存在时给出警告，需 `--mcp-project` 显式启用。
- 支持 `stdio`（默认）、`http`、`sse`；配置值按字面量解析，不做环境变量展开。
- 服务器工具统一视为 `execute`，输出最多 30,000 字符。连接失败会报告并继续，退出时关闭客户端与子进程。
- `/mcp` 查看连接状态与工具数量。

## 网页工具

- `web_fetch` 抓取公网 HTTP(S) 页面并提取正文。`web_search` 默认直连 Tavily 的免费免 Key 接口，返回标题、URL 和摘要。免费接口受 Tavily 的请求额度限制。
- 使用自己的 Tavily 额度时，按以下方式配置并在环境中提供密钥。

```json
{ "webSearch": { "provider": "tavily" } }
```

```bash
export TAVILY_API_KEY=...        # 可用 webSearch.apiKeyEnv 改用其他变量名
```

- 显式配置密钥模式后，密钥缺失或格式不合法会禁用搜索并给出警告。设置 `"webSearch": false` 可关闭搜索。编辑配置后在 TUI 用 `/reload` 应用。
- 两个工具都声明 `network`。交互 `ask` 和 Windows / Linux 交互 `auto` 每次确认出站请求参数，`plan`、无头 `ask` 和 Windows / Linux 无头 `auto` 拒绝。 [权限模式](#权限模式)

## 相关文档

- [架构总览](docs/architecture.md) · [CLI 与配置](docs/cli.md) · [工具与权限](docs/tools-and-permissions.md)
- [模型协议与档位](docs/providers.md) · [上下文与会话](docs/context-and-sessions.md) · [扩展与联网](docs/integrations.md)
