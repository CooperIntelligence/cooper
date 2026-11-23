# 扩展与联网

[源码文档](README.md)

这一页面向改动代码的读者：Skills 的发现与加载、MCP 的信任边界与资源工具、网页工具的限制。如何配置和启用见 [使用参考](../USAGE.md)。

## Skills

[`discoverSkills()`](../packages/core/src/skills.ts) 依次扫描四个位置，同名时先命中者胜出并给出被遮蔽的警告：

1. `<工作区>/.cooper/skills/`
2. `<工作区>/.agents/skills/`
3. `~/.cooper/skills/`
4. `~/.agents/skills/`

每个 Skill 是一个目录，内含 `SKILL.md`：

- 目录名必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，frontmatter 的 `name` 必须与目录同名，`description` 必填（≤ 1,024 字符）。
- frontmatter 读取上限 16 KiB，正文与引用文件各 64 KiB；引用路径只能落在该 Skill 目录内，绝对路径被拒绝。
- 清单解析失败只记入 `warnings`，不阻断其他 Skill；目录或名称在进程运行中发生变化时，[`readSkill()`](../packages/core/src/skills.ts) 拒绝继续读取并提示重启，避免重新指向的链接扩大访问范围。

加载路径有两条：模型通过只读的 [`load_skill`](../packages/core/src/tools/skill.ts) 按需读取；用户用 `/skill <name> [请求]` 显式激活，此时 [`skillActivation()`](../packages/core/src/skills.ts) 生成一条带 `runtime: "skill"` 标记的用户消息，与请求本身在[分组](context-and-sessions.md)时绑成一组。系统提示里附 Skill 目录（名称 + 描述），共用 16,000 字符预算，超限截断并提示模型用 `load_skill` 浏览。

Skill 内声明的 `allowed-tools` 之类字段**不改变权限**：脚本仍通过 `shell` 按常规策略执行。Skill 文本是任务指引，权限规则始终在其之前（见 [架构总览](architecture.md)）。相关测试：[skills](../packages/core/test/skills.test.ts)、[系统提示目录](../apps/cli/test/system-prompt.test.ts)。

## MCP

MCP 服务器会执行外部代码，因此配置是受信任输入。[`loadMcpConfig()`](../packages/core/src/mcp/config.ts) 只加载三处来源，按顺序合并，同名服务器后者覆盖前者：

1. `~/.cooper/mcp.json`
2. `<工作区>/.cooper/mcp.json`——**仅当显式传入 `--mcp-project`**；存在但未启用时给出警告，这样克隆一个仓库不会自动运行任何东西
3. 可重复的 `--mcp-config <文件>`——文件缺失是硬错误

解析规则：服务器名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`；单条配置非法只警告并跳过，不拖垮其余服务器；`stdio`（默认）、`http`、`sse` 三种传输，`http`/`sse` 要求 http(s) URL；配置值按字面量解析，不做环境变量展开；`cwd` 相对配置文件所在目录解析。

[`mcp/tool.ts`](../packages/core/src/mcp/tool.ts) 把服务器工具映射为 `mcp__<server>__<tool>`：

- 一律声明 `execute`，服务器自报的 `readOnlyHint` 不参与决策；
- 转发服务器声明的原始 JSON Schema，输入用宽松解析器，权威校验由服务器完成；
- 命名时把非 `[A-Za-z0-9_-]` 的字符替换成 `_`，超过 64 字符则截断并拼上名称哈希；归一化后跨服务器重名时保留先出现的，后到者警告跳过；
- 连接超时 10 秒、单次调用超时 60 秒，工具列表最多翻 100 页；输出最多 30,000 字符，图片与音频用文本占位。

[`mcp/client.ts`](../packages/core/src/mcp/client.ts) 并行连接所有服务器，单个失败只标记该服务器并附上其 stderr 尾部，不影响其他服务器与内置工具；退出或中断时关闭全部客户端与子进程（关闭幂等）。[`mcp/resources.ts`](../packages/core/src/mcp/resources.ts) 提供三个共享只读工具，按需访问已配置的服务器、接收显式 `server` 参数，因此在 `plan` 中也能调用；一个服务器都没配置时这三个工具不会注册，省掉对应的 schema 与 token：

| 工具 | 作用 |
| --- | --- |
| `mcp_list_resources` | 列出资源，`cursor` 取单页，省略时汇总分页 |
| `mcp_list_resource_templates` | 列出 URI 模板，遵循相同的分页规则 |
| `mcp_read_resource` | 按 URI 读取，保留 URI、MIME 与文本，二进制用说明替代 |

服务器缺少 resources 能力时，列举返回空列表，读取返回明确错误——当前接入范围是工具调用与按需资源读取。相关测试：[配置](../packages/core/test/mcp-config.test.ts)、[客户端](../packages/core/test/mcp-client.test.ts)、[工具适配](../packages/core/test/mcp-tool.test.ts)、[资源](../packages/core/test/mcp-resources.test.ts)。

## 网页工具

[`web_fetch`](../packages/core/src/tools/web-fetch.ts) 直连公网 HTTP(S)：

- URL 上限 4,096 字符，超时 15 秒（与取消信号合并），传输正文与解压正文各 2 MiB，提取文本最多 16,000 字符。
- 只接受公网地址：私网、环回、link-local 等目标直接拒绝，DNS 解析结果与实际连接绑定（`lookup` 覆盖 + `agent: false`），解析出混合答案即拒，避免请求被重定向到内网。
- 最多跟随 3 次**同源**跳转；跨源跳转不继续抓取，而是把目标地址作为 `redirect` 结果返回，由模型决定是否再请求一次。
- 只支持 HTML/XHTML、Markdown、纯文本；非 2xx、空正文、纯空白、无法识别的字符集都返回结构化状态。
- 结果区分 `ok` / `no_static_text`（页面可能靠 JavaScript 渲染）/ `empty_body` / `empty_text` / `redirect` / `error`（含状态码、最终 URL、内容类型），附带标题（≤ 256 字符）。

[`web_search`](../packages/core/src/tools/web-search.ts) 默认把查询直连发送到 Tavily 的免 Key 接口。查询最多 400 字符，`limit` 为 1–10（默认 5），返回标题、URL 和最多 1,000 字符的摘要。无效 URL 会被丢弃，标题与摘要中的 API 密钥会被替换为 `[redacted]`，包含密钥的 URL 会被跳过。免费请求收到 429 时会提示上游限流，并在响应提供重试秒数时显示等待时间。 [Tavily 免 Key 接口](https://docs.tavily.com/documentation/keyless)

两个工具都声明 `network`。`PermissionPolicy` 按平台和运行模式决定是否允许，逐次审批的请求会展示出站参数。网页请求由宿主工具发出，Windows 的 MXC 网络限制适用于内置 `shell`。结果进入模型上下文，启用持久化时随会话落盘。 [权限决策](tools-and-permissions.md#权限决策) · [网页工具测试](../packages/core/test/web-tools.test.ts)
