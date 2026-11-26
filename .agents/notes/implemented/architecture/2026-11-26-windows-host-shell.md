# Agent Note: Windows Host Shell

Status: implemented

## Problem

Windows 的 MXC ProcessContainer 让命令查找、运行时权限和应用包启动流程各自依赖兼容条件。开发任务即使获得批准，也可能卡在 Python、Node.js 或 PowerShell 的启动流程上。随包的普通 PowerShell 只能解决命令解释器的启动。

## Decision

Windows CLI 和 Desktop 的交互 `Ask` 经用户批准后，以当前 Windows 用户权限启动宿主命令。原生安装包提供 PowerShell 7，缺少随包解释器时使用宿主 shell。Windows 提供 `Plan` 和 `Ask`。Linux 继续由 MXC Bubblewrap 执行沙箱命令。

本决策替代 Windows MXC 执行路径及其审批策略。 [原沙箱设计](2026-11-21-auto-shell-sandbox.md) · [原执行与审批设计](2026-11-22-windows-agent-execution-policy.md)

## Alternatives considered

**继续兼容 Windows MXC 的工具启动。** 自动授予工具目录读取权限只能解决一部分问题。WindowsApps 别名与 MSIX 激活还受原生启动限制。常用开发工具需要稳定地使用宿主环境。

**在 Windows 宿主上运行 Auto。** 这会让原先依赖沙箱的命令越过人工确认。Windows 对宿主命令使用交互 Ask。

## Consequences

获准的宿主命令具有当前 Windows 用户的文件和网络权限。Cooper 的文件工具继续校验工作区路径。Windows 无头模式仍能执行只读操作，受管控的操作因缺少审批而拒绝。
