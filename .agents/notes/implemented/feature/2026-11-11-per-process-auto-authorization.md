# Agent Note: Per-Process Auto Authorization

Status: implemented

## Problem

分层配置允许把 `auto` 作为持久默认值。即使启动时跳过会话保存的 `auto`，
新进程也可能从全局配置获得自动执行权限。环境变量同样可能在启动时被继承，
使授权来源在当前命令中不可见。

## Decision

自动执行授权属于当前进程。启动时由 `--mode auto` 授权，空闲的 TUI 也可通过
`/auto` 授权。会话可以记录该模式，但新进程恢复时跳过它。配置文件仍可
保存 `plan` 或 `ask` 作为默认偏好。启动顺序为 `--mode`、保存的
`plan` / `ask`、配置默认值、`ask`。

本决定接续 [Runtime-Switchable Permission Modes](2026-11-09-runtime-permission-modes.md)
的恢复约定，收紧新进程可采用的授权来源。

## Alternatives considered

**继续接受 `COOPER_MODE=auto`。** 环境变量适合脚本，但进程可能从外层环境
继承它。将标志写在启动命令上可以明确标出哪一次调用允许自动执行。

**保留全局配置的 `mode: "auto"`。** 全局默认可减少重复输入，但会将一次偏好
保存为跨进程、跨工作区的执行授权。

## Consequences

依赖 `COOPER_MODE` 的脚本需要改用 `--mode`。旧配置中的 `mode: "auto"`
在加载时提示迁移并跳过，用户可以继续以保守模式启动和恢复会话。
