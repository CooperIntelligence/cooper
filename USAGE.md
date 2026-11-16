# 使用参考

面向使用者的完整参考：命令行参数、交互命令、配置文件、权限模式与扩展接入。实现方式与设计约束见 [源码与设计](docs/README.md)，产品介绍见 [README](README.md)。

## 运行

需要 Node.js 22.12.0 或更高版本。

```bash
npm install
npm run dev                # 从源码启动 TUI
npm run dev -- <参数>       # 带参数运行
npm run build              # 打包到 apps/cli/dist/cooper.mjs（bin 名 cooper）
```

## 命令行参数

| 参数 | 行为 |
| --- | --- |
| 位置参数 | 单次请求的提示，等价于 `-p <文本>` |
| `-p` / `--print [文本]` | 无头单次请求；省略文本或写 `-` 时从 stdin 读取 |
| `-m` / `--mode <模式>` | 启动模式：`plan`、`ask`、`auto` |
| `-C` / `--cwd <目录>` | 工作区目录，默认启动目录 |
| `-r` / `--resume <id>` | 继续已保存的会话；接受完整 id 或唯一前缀 |
| `--sessions` | 列出当前工作区的会话后退出 |
| `--no-session` | 本次不写会话文件 |
| `--tier <档位>` | 选择 `sera`、`cher`、`thr`（覆盖会话保存的档位） |
| `--mcp-project` | 允许加载 `<工作区>/.cooper/mcp.json` |
| `--mcp-config <文件>` | 追加一份 MCP 配置，可重复传入 |
| `--show-reasoning` | 显示端点支持的推理文本或摘要 |
| `-h` / `--help` | 查看帮助 |

规则与优先级：

- 长参数支持 `--flag=value`；未知参数直接报错。
- 只能有一个提示；`--resume` 不能与 `--no-session` 同用；`--sessions` 不能与提示或 `--resume` 同用。
- 工作区由 `--cwd` 决定，文件工具、命令启动目录、项目指令、项目级 MCP 配置和会话都归属它。
- 启动模式取值顺序：`--mode` > 会话保存的 `plan`/`ask` > `config.json` 的 `mode` > `ask`。配置里的 `mode` 只接受 `plan` 和 `ask`，环境变量不参与选择；要在一个新进程里启用自动批准，必须显式传 `--mode auto`。

## 无头模式（`-p`）

```bash
npm run --silent dev -- -p "解释这个项目的入口" > answer.md   # --silent 避免 npm 输出命令标题
npm run dev -- -p - < prompt.txt                             # 从 stdin 读提示
echo "列出行数最多的文件" | npm run dev -- -p
```

- stdout 只写模型的回答，可直接重定向；工具进度、会话状态、模式提示、MCP 状态、诊断和推理输出走 stderr。
- 退出码：成功 `0`，错误或达到轮次上限 `1`，被中断 `130`。
- 没有人能回答审批提示，因此 `ask` 和 `plan` 都会拒绝写文件、执行命令和网络请求；需要这些能力时传 `--mode auto`（启动时 stderr 会给出提示）。
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
| `ask`（交互） | 允许 | 每次询问，或沿用进程内授权 |
| `ask`（无头 `-p`） | 允许 | 直接拒绝 |
| `auto` | 允许 | 自动批准，仍执行工具自身的校验 |

- 网络工具在 `ask` 下逐次确认，不能被进程内授权覆盖。
- 其他受管控工具可以按工具名授权到进程退出，只保存在内存，不写入会话；切换到 `plan` 后先应用只读限制，此前的授权不会变成可写。
- 恢复会话只会带回 `plan` 或 `ask`；保存过 `auto` 的会话在新进程里不会自动恢复为 `auto`，需要 `--mode auto` 或 TUI 里 `/auto`。

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
| `shell` | Windows 为 PowerShell，Linux 为 Bash，macOS 为 zsh |
| `webSearch` | 不配置即禁用网页搜索 |

- 首次在交互界面启动且缺少必填字段时进入引导：选择协议、模型 ID（必填）、可选的上下文窗口、服务地址与密钥，再用该配置请求一次模型列表（10 秒超时）验证连接；验证失败可重试、修改或跳过，放弃则退出并提示手工写入。无头或重定向启动不会进入引导，直接报错。
- 编辑器可改 12 个字段：四个连接字段、`maxOutputTokens`、`showReasoning`、`mode`、`shell` 和四个 `context.*`。`webSearch`、`defaultTier`、`modelTiers` 只能手改文件后用 `/reload` 应用。
- 未知字段、疑似密钥的其他字段、旧的 `env` 对象、`mode: "auto"` 都只是警告并忽略；JSON 语法错误或类型不匹配是硬错误，不会静默改变行为。
- `/config` 保存时先写同目录临时文件（POSIX 上权限 `0600`）再替换，并检查保存期间是否被外部修改；`/reload` 应用外部编辑，校验失败时继续使用已生效的配置。
- 旧配置可以把 `env` 中的 `COOPER_BASE_URL`、`COOPER_API_KEY` 移到顶层 `baseURL`、`apiKey`，然后删除 `env`。

命令 shell 可用 `shell` 覆盖：

```json
{ "shell": { "kind": "pwsh" } }
```

`kind` 支持 `powershell`、`pwsh`、`cmd`、`sh`、`bash`、`zsh`、`git-bash`；`powershell`/`cmd`/`git-bash` 仅限 Windows，`shell.executable` 需要绝对路径，Windows 上选 `bash` 必须显式给出可执行文件。

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
| `list_dir`、`read_file`、`grep` | `read` |
| `load_skill`、`mcp_list_resources`、`mcp_list_resource_templates`、`mcp_read_resource` | `read` |
| `write_file`、`edit_file` | `write` |
| `run_command` | `execute` |
| MCP 服务器暴露的工具（`mcp__<server>__<tool>`） | `execute` |
| `web_fetch`、`web_search` | `network` |

`/tools` 可以随时查看当前生效的工具与能力。文件与命令都被限制在工作区内。

## Skills

- 目录：`<工作区>/.cooper/skills/`、`<工作区>/.agents/skills/`、`~/.cooper/skills/`、`~/.agents/skills/`，同名时前者优先。
- 每个 Skill 是一个目录，内含 `SKILL.md`：YAML frontmatter 必须有 `name`（与目录同名）和 `description`。
- 正文和引用文件各限 64 KiB，引用路径只能在该 Skill 目录内；`allowed-tools` 之类字段不改变权限，脚本仍通过 `run_command` 按常规权限执行。
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

- `web_fetch` 抓取公网 HTTP(S) 页面并提取正文；`web_search` 走 Tavily，返回标题、URL 和摘要。
- 启用搜索需要配置并在环境中提供密钥：

```json
{ "webSearch": { "provider": "tavily" } }
```

```bash
export TAVILY_API_KEY=...        # 可用 webSearch.apiKeyEnv 改用其他变量名
```

- 密钥缺失或格式不合法时禁用搜索并在启动时给出警告；编辑配置后用 `/reload` 应用。
- 两个工具都声明 `network`：交互 `ask` 每次确认出站请求参数，`plan` 与无头 `ask` 拒绝，`auto` 自动批准。

## 相关文档

- [架构总览](docs/architecture.md) · [CLI 与配置](docs/cli.md) · [工具与权限](docs/tools-and-permissions.md)
- [模型协议与档位](docs/providers.md) · [上下文与会话](docs/context-and-sessions.md) · [扩展与联网](docs/integrations.md)
