# Agent Note: Configurable Command Shell

Status: implemented

## Problem

启动 Cooper 的终端可能使用 PowerShell、Git Bash 或 zsh。Node 的隐式 shell
选择可能使用另一套语法，模型和用户只能从失败的命令反推实际执行环境。

## Decision

`run_command` 由 Cooper 选择 shell。Windows 默认使用系统自带的 Windows
PowerShell 5.1，便于调用 Windows 管理命令。Linux 默认使用 Bash，macOS 默认
使用 zsh。用户级 `config.json` 可指定 shell 类型和绝对可执行文件路径。
工具说明、审批和状态界面都由同一份解析结果生成。

## Alternatives considered

**保留 Windows 的 CMD 默认值。** 这可兼容已有 CMD 命令，但 PowerShell 更适合
Windows 设置和管理。依赖 CMD 语法的用户可在配置中显式选择 CMD。

**沿用启动终端的 shell 或自动选最新版本。** 这会让同一配置因启动方式或机器
安装的软件不同而使用不同语法。固定默认值，其他 shell 由用户明确选择。

## Consequences

已有 Windows CMD 命令可能需要改写或显式配置 CMD。PowerShell 命令以非交互、
无 profile 的方式执行，使用当前用户权限及系统执行策略。
精简 Linux 环境可安装 Bash 或显式配置 `sh`。
