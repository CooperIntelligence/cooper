# Agent Note: Electron Desktop Host

Status: implemented

## Problem

Cooper 需要在 Windows、macOS 和 Linux 提供一致的会话与审批界面。配置、Agent 循环和会话已经在 Node.js 上运行。桌面接入需要保留现有工具的行为和审批边界。

## Decision

桌面宿主使用 Electron，与 CLI 共用 TypeScript 内核。Electron 提供统一的 Chromium 渲染环境，主进程直接运行 Node.js 内核。宿主间共用的配置、Provider 工厂、工具装配和系统提示由 `packages/host` 提供。渲染器通过固定的 IPC 接口发起操作，主进程判断工具权限并执行审批复查。

## Alternatives considered

**Tauri。** 系统 WebView 随平台变化，Cooper 需要为各平台的渲染与行为差异单独验证。接入既有 Node.js 内核也需要管理一个额外运行时。

## Consequences

Electron 自带 Chromium 和 Node.js，发布物需要携带运行时并随 Electron 更新。共享渲染环境降低界面差异，各平台仍需验证原生目录选择、命令终止和安装包。Electron 渲染器沙箱隔离的是界面进程，`shell` 仍由主进程按 Cooper 的权限策略启动，并继承当前用户的系统权限。

## Related

- [Single Provider Configuration Source](2026-11-11-single-provider-configuration-source.md)
