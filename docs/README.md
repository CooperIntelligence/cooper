# Cooper 源码与设计

这一组文档只描述**实现**：模块边界、数据流、必须保持的约束和它们的验证方式，面向需要改动代码的读者。

- 产品介绍与快速开始见 [README](../README.md)。
- 命令行参数、交互命令、配置文件与扩展接入（面向使用者）见 [使用参考](../USAGE.md)。
- 仓库级开发约束见 [AGENTS.md](../AGENTS.md)，决策记录的维护规则见 [Agent Notes](../.agents/notes/README.md)。

| 文档 | 负责的实现 |
| --- | --- |
| [架构总览](architecture.md) | 包边界、启动流程、Agent 循环与事件契约、系统提示与项目指令 |
| [CLI 与配置](cli.md) | 参数解析与入口分流、无头输出契约、流式渲染、配置加载与热更新 |
| [模型协议与档位](providers.md) | Provider 接口、三个协议适配器、协议续传的身份与前缀校验、档位切换 |
| [工具与权限](tools-and-permissions.md) | 工具契约、权限决策、审批与预览、文件与命令的工作区边界 |
| [上下文与会话](context-and-sessions.md) | token 估算、预算数学、压缩分组、JSONL 持久化与恢复修复 |
| [扩展与联网](integrations.md) | Skills 发现与加载、MCP 信任与资源、网页工具的限制 |

## 仓库地图

只列目录与关键入口，逐文件的职责由上面各页说明：

```
apps/cli/                 宿主：进程、配置、终端界面
  src/index.tsx           入口与分流（TUI / 无头 / 列出会话）
  src/app.tsx             TUI 主循环与审批交互
  src/headless.ts         无头单次运行（stdout 只有回答）
  src/args.ts             参数解析（纯函数）
  src/config.ts           有效配置计算，src/settings.ts 读写 config.json
packages/core/            内核：不依赖 Ink/React，不直接读写终端
  src/agent.ts            Agent 循环与事件
  src/permissions.ts      权限策略与 fail-closed 决策
  src/provider/           Provider 接口、三个协议适配器、续传
  src/tools/              工具契约与内置工具（fs / shell / skill / web）
  src/context/            token 估算、分组、剪枝与压缩
  src/mcp/                MCP 配置、客户端、工具与资源适配
  src/session.ts          会话持久化与恢复
  src/instructions.ts     COOPER.md / AGENTS.md 加载
scripts/                  构建与打包（build.mjs、package.mjs）
docs/                     本组文档
```

## 维护约定

- 每页只写实现真正强制的行为：给出源码入口，数值常量与代码保持一致，避免描述「应该怎样」。
- 用户可见但不涉及实现取舍的清单（参数、命令、配置字段、工具能力）留在 [USAGE](../USAGE.md)，这里不重复枚举；产品介绍与快速开始留在 [README](../README.md)。
- 目录归属调整时同步上面的仓库地图；修改接口、默认值或边界时，同步更新对应页面及其测试链接。
