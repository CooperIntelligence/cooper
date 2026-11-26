# Agent Note: Windows AUTO Shell Sandbox

Status: implemented

## Problem

历史决策。现行策略见 [Windows 宿主执行](2026-11-26-windows-host-shell.md)。

命令工作目录校验只能约束启动位置。AUTO 跳过人工确认后，原有 PowerShell 进程可以继续使用宿主的路径权限、环境变量和网络。审核模型也无法替代操作系统约束。[AUTO 审核提案](../../proposed/feature/2026-11-20-auto-mode-tool-review.md)

## Decision

CLI 的 TUI、无头入口和 Electron 主进程向 Core 提供同一个宿主执行器。Windows `ask` 和 `auto` 的内置 `shell` 以及历史别名 `run_command` 使用同一沙箱入口。助手或运行时缺失和启动失败均返回错误。Desktop 根据随包运行时和助手决定是否开放 Auto，用户在空闲状态下显式切换。恢复会话不恢复自动授权。 [Windows 执行与审批设计](2026-11-22-windows-agent-execution-policy.md)

宿主从发布目录解析助手和 PowerShell 的真实路径。项目工作区与单次临时目录可写，明确拒绝工作区根下的 `.git`、`.cooper` 和 `.env`。标准位置安装的 Node.js 运行时可读，必要的父目录只开放枚举。Windows 自身的应用包 ACL 也可能提供对系统文件的访问。宿主构造环境并定向临时目录，Rust 助手用 MXC `ProcessContainer` 执行，网络入口、出口和宿主回环一律拒绝。PowerShell 在隔离桌面上初始化，保留 MXC 的剪贴板与输入注入限制。 [MXC 策略](https://github.com/microsoft/mxc/blob/main/docs/schema.md)

宿主通过 stdin 发送一次固定格式的请求，EOF 取消执行。Rust 助手并发收集有限的 stdout 和 stderr，通过原生进程句柄处理退出、超时和取消。关闭助手前结束原生作业，宿主等待助手退出后清理专用临时目录。原生 Setup 按 CLI 版本安装助手。

`pwsh` 需要读取自身的 .NET 运行时。宿主给随包的 PowerShell 专用目录只读权限。Store 版 PowerShell 在部分 Windows 启动环境中无法通过 PSEC 启动 MSIX。 [MXC 的 Job Object 限制](https://github.com/microsoft/mxc/issues/1754)

## Alternatives considered

**根据命令前缀判定是否安全。** 已安装程序和项目脚本可以转而执行其他命令，边界由运行时进程权限约束。

**首版给 shell 提供工作区写权限。** 初期只让命令写临时目录，保留由文件工具修改工作区的权限边界。后来为了运行需要产物的构建，验证并采用工作区写权限。

## Consequences

本阶段覆盖 Windows CLI 与 Desktop 的内置 shell。安装包把助手和解释器放在应用进程可直接打开的发布目录。Desktop 和 CLI 使用各自的安装与卸载标识，模型配置、历史会话和草稿由应用管理。MCP 执行工具隔离、一次性安装授权、其他操作系统后端和 npm 助手分发仍需单独实现。 [Desktop 安装定义](../../../../scripts/windows/cooper-desktop-setup.iss)
