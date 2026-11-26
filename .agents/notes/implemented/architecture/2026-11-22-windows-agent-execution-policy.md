# Agent Note: Windows Agent Execution Policy

Status: implemented

## Problem

历史决策。Windows 的现行策略见 [Windows 宿主执行](2026-11-26-windows-host-shell.md)，Linux 继续使用独立的 [Bubblewrap 执行策略](2026-11-23-linux-shell-sandbox.md)。

Windows PowerShell 把 `$home` 和只读的 `$HOME` 解析为同一变量。赋值错误可能是非终止错误，后续清理会访问启动时的用户目录。原先 Windows Ask 批准后在宿主执行，切换审批模式也改变了文件安全边界。Git Bash 和 Store PowerShell 又不是当前 PSEC 路径上可靠的运行时。

## Decision

Windows CLI 和 Desktop 从安装目录加载随包的独立 PowerShell 7 和 MXC 助手，Ask 与 Auto 共享这个执行路径。宿主只授权项目根和私有临时目录写入，不把用户配置的 shell 路径、任意安装目录或审核模型给出的范围当成授权。用户目录、包含它的父目录和卷根不能作为可写项目。原生助手要求枚举策略，使无法实现该策略的 Windows 拒绝启动。[底层沙箱设计](2026-11-21-auto-shell-sandbox.md)

Auto 对普通工作区编辑使用程序检查，对 shell 使用同一模型端点的独立审核，其他受管控动作和不确定的结果转人工。审核只拿实际调用、用户消息、隔离范围和有界的相关历史调用。工具结果和推理不进入审核上下文。审批结果不能放宽文件或网络策略。已实现部分见[审核提案](../../proposed/feature/2026-11-20-auto-mode-tool-review.md)。

## Alternatives considered

**只在 Auto 中启用沙箱。** Ask 的确认只能说明用户批准了呈现的调用。随后执行偏离预期时，仍需要同样的操作系统边界。

**在 Windows 复用用户选择的解释器。** Store MSIX 和 Git Bash 实测遇到不同的原生启动限制。固定一个可验证的运行时还能让终端入口和桌面入口使用同样的命令语法。

**让模型判断代替沙箱。** 审核只能判断待执行操作。测试表明同一脚本可以在工作区成功写入，同时因变量解析错误尝试删除另一个目录。最终保护必须对实际文件访问生效。

## Consequences

Linux 采用共享审批机制和独立的 [Bubblewrap 执行策略](2026-11-23-linux-shell-sandbox.md)。

可写工作区内的错误修改仍可能发生。用户审批与模型审批控制允许执行的调用，MXC 控制调用能接触的资源。Windows 用户配置中的旧 shell 值被忽略。工作区外的临时授权、网络扩权以及其他执行后端仍需另行接入。
