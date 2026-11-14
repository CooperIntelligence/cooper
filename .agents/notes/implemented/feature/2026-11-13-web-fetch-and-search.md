# Agent Note: Web Fetch and Web Search

Status: implemented

## Problem

Cooper 能检查工作区，但依赖升级、外部 API 参数或已知报错往往要到官方文档、issue 和发布说明核对。用 `run_command` 联网会把网络请求、命令解释和输出处理都交给通用 shell。模型既能读取工作区，又能生成 URL 和查询词，因此网页读取也需要明确数据发给谁、发了什么。

## Decision

Cooper 内置 `web_fetch`，通过用户配置启用 Tavily `web_search`。抓取读取已知公开 URL，搜索从索引发现候选来源。客户端工具与模型供应商解耦，沿用 TUI 和 headless 共用的 `Tool`、`PermissionPolicy`、上下文和会话路径。

### 逐次审批外发参数

两种工具都声明 `network`。TUI `ask` 展示完整规范化 URL 或后端和查询词，每次可以单独批准。URL 的路径和查询参数能携带本地数据，搜索词也可能包含内部包名、仓库路径或报错。按工具名的进程授权会覆盖未来不同的目标和参数，因此 UI 与 core 都只接受单次批准。预览阶段只格式化参数，批准后才解析域名和请求。

`plan` 和 headless `ask` 拒绝网页工具。显式 `auto` 自动审批，工具仍执行各自的网络校验。模式通知沿用 `<cooper-runtime>` 追加机制。网页内容和摘要属于工具数据，无法改变宿主的执行权限。 [运行时权限模式](../../implemented/feature/2026-11-09-runtime-permission-modes.md) · [交互式工具审批](../../implemented/feature/2026-11-11-interactive-tool-approvals.md) · [进程级自动授权](../../implemented/feature/2026-11-11-per-process-auto-authorization.md)

### 限制抓取目标和响应

`web_fetch` 对公网 HTTP(S) 直连发 GET。每次请求都检查目标 IP，连接只使用已校验的 DNS 结果，以防主机名在检查后重新解析到内网。HTTPS 使用原域名进行 TLS 校验。同源跳转逐次校验，跨源跳转返回新链接，后续调用重新走权限判断。工具限时、限制响应与解压体积，并接入用户中断信号。HTML 经过静态解析，保留标题、链接、代码和表格。 [OWASP SSRF 防护指南](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

### 搜索后端与会话记录

选择 Tavily，依托现有网页索引和搜索 API。Tavily 允许保留摘要和元数据，符合 Cooper 将工具结果写入会话并在恢复时重放的行为。Cooper 只发查询和结果数等搜索参数，只返回标题、URL 和摘要。凭证由用户配置指定的环境变量提供，只随请求发给固定 Tavily 地址。无有效配置或凭证时仅省略搜索工具。空闲 TUI 的 `/reload` 会重新应用搜索配置。 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) · [Tavily 结果保留说明](https://help.tavily.com/articles/1612400809-storing-caching-retaining-output) · [会话记录实现](../../../../packages/core/src/session.ts)

## Alternatives considered

**按 `read` 自动放行。** 这样 `plan` 也能查文档，交互成本最低。代价是用户无法在模型发送工作区数据前查看目的地和内容。

**通过 `run_command` 联网。** 现成的 shell 命令可以发请求。Cooper 只能按通用命令审批，难以统一限制目标、重定向、凭证和响应。

**使用模型供应商托管的网页工具。** 供应商可提供内置索引或引用，但请求在供应商的模型调用期间执行，本地 `PermissionPolicy` 无法逐次核对出站参数，工具可用性也取决于模型和协议。 [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search) · [Anthropic Web Fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)

## Consequences

搜索后逐个阅读来源会多次询问。显式 `auto` 适合用户已授权的无人值守调用。静态抓取覆盖公开 HTML、Markdown 和纯文本，登录页面、PDF、依赖浏览器渲染的内容以及仅能通过代理访问的环境需要不同的实现。

查询会发给 Tavily，抓取目标会收到 URL 和请求来源。返回正文和摘要进入模型上下文与本地会话。搜索结果提供候选来源，具体版本和参数可以进一步打开原文核对。

## Verification

回归测试覆盖模式矩阵、拒绝进程授权、TUI 预览、搜索配置、DNS 固定、内网地址和重定向拦截、取消、解压上限以及 Tavily 请求和错误处理。真实 HTTPS 抓取验证了 Example Domain 和 RFC 9110。Tavily 使用模拟响应验证。
