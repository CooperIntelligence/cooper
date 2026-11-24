# Agent Note: Linux Shell Sandbox

Status: implemented

## Problem

Linux 的交互 Ask 原先直接启动宿主 shell，Auto 则要求一个尚未接入的沙箱。用户批准的工作区、临时目录和联网权限需要对子进程同样生效。

## Decision

Linux 通过 MXC 的 Bubblewrap 后端执行 shell。平台共享审批决策与助手进程生命周期。Linux 使用系统命名空间及 MXC 的 seccomp 过滤实现隔离，复用发行版现有工具链，采用私有临时目录与用户级、精确匹配工作区的出站配置。来自模型的命令和参数不决定出站范围。Windows 的独立 PowerShell 与 PSEC 策略见 [Windows 执行策略](2026-11-22-windows-agent-execution-policy.md)。

## Alternatives considered

**直接拼装 Bubblewrap 命令。** 这样可减少 SDK 依赖，但要自行处理命名空间、联网转发、挂载冲突和取消，涉及两套独立进程生命周期。

**以 Landlock 自动回退。** Linux 主机上的 ABI 和可用规则可能只满足部分权限。当前使用特定后端，执行器缺失或无法建立请求的权限时拒绝启动。

## Consequences

禁网与出站使用同一文件策略。网络授权来自用户配置，不能由审批模型扩大。工具链配置依赖真实家目录或系统套接字时，需要显式接入。工作区中的预存硬链接与绑定挂载会让同一文件具有多个路径，挂载权限不能被描述成对所有外部 inode 的隔离。宿主仍需提供可用的 Bubblewrap 与对应内核能力。
