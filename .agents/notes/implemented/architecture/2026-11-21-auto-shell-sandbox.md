# Agent Note: Windows AUTO Shell Sandbox

Status: implemented

## Problem

命令工作目录校验只能约束启动位置。AUTO 跳过人工确认后，原有 PowerShell 进程可以继续使用宿主的路径权限、环境变量和网络。审核模型也无法替代操作系统约束。[AUTO 审核提案](../../proposed/feature/2026-11-20-auto-mode-tool-review.md)

## Decision

CLI 的 TUI、无头入口和 Electron 主进程向 Core 提供同一个宿主执行器。`runAgent()` 从权限策略确定 AUTO 必须使用沙箱，内置 `shell` 和历史别名 `run_command` 使用同一执行入口。助手缺失或启动失败时返回错误。交互 `ask` 仍使用经审批的宿主执行路径。Desktop 由主进程根据 Windows 助手是否存在决定能否开启 AUTO，用户在空闲状态下显式切换。恢复会话不恢复自动授权。

宿主从可信安装目录解析助手的真实路径，拒绝工作区内的助手。文件策略为工作区只读、单次临时目录可写，明确拒绝根下的 `.git`、`.cooper` 和 `.env`。标准位置安装的 Node.js 运行时可读，必要的父目录只开放枚举。Windows 自身的应用包 ACL 也可能提供对系统文件的访问。宿主构造环境并定向临时目录，Rust 助手用 MXC `ProcessContainer` 执行，网络入口、出口和宿主回环一律拒绝。PowerShell 在隔离桌面上初始化，保留 MXC 的剪贴板与输入注入限制。[MXC 策略](https://github.com/microsoft/mxc/blob/main/docs/schema.md)

宿主通过 stdin 发送一次固定格式的请求，EOF 取消执行。Rust 助手并发收集有限的 stdout 和 stderr，通过原生进程句柄处理退出、超时和取消。关闭助手前结束原生作业，宿主等待助手退出后清理专用临时目录。原生 Setup 按 CLI 版本安装助手。[宿主执行器](../../../../packages/host/src/shell-sandbox.ts) · [Rust 助手](../../../../packages/shell-sandbox/src/windows.rs)

## Alternatives considered

**根据命令前缀判定是否安全。** 已安装程序和项目脚本可以转而执行其他命令，边界由运行时进程权限约束。

**给 shell 提供工作区写权限。** 首版由内置文件工具修改工作区，命令只写临时目录。需要工作区写权限的构建和安装应在引入受限写入授权后独立验证。

## Consequences

本阶段覆盖 Windows CLI 与 Desktop 的内置 shell。Desktop 开发预览使用构建时复制的原生助手，Windows 安装包把助手放在 Electron 资源目录下，主进程可以直接启动真实的可执行文件。Desktop 和 CLI 使用各自的安装与卸载标识，模型配置、历史会话和草稿由应用管理。模型审核、MCP 执行工具隔离、一次性安装授权、其他操作系统后端和 npm 助手分发仍需单独实现。[Desktop 安装定义](../../../../scripts/windows/cooper-desktop-setup.iss)
