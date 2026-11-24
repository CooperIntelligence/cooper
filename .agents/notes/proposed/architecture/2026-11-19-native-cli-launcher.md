# Agent Note: Native CLI Launcher and Version Activation

Status: proposed

## Problem

Node 版本管理器会随项目切换终端的 `PATH`。Cooper 的 npm 全局安装和命令入口属于安装它的那套 Node，切换后可能无法启动 Cooper。Windows 上活跃的 CLI 进程还会占用可执行文件，更新时需要同时考虑新进程的启动和已有会话的继续。

## Proposal

Windows x64 原型使用一个 Rust 控制台程序作为用户 `PATH` 上的入口。launcher 从自身所在的 `bin` 上一级定位安装目录。`current.json` 记录 `active`、`previous` 和 `channel`。每个版本的 SEA 程序位于 `versions/<版本>/cooper.exe`。普通调用继承参数、工作目录、终端和退出码。`rollback` 由 launcher 处理，从而在当前 SEA 程序启动失败时仍有恢复入口。

CLI 要求单次请求显式使用 `-p` 或 `--print`。`update [--check]` 和 `rollback` 在加载工作区、模型和 MCP 前分流，避免输错维护命令时误发模型请求。launcher 独立识别维护命令和未知的首个裸参数，因此把程序指向较老的构建也不会把这些参数送给模型。在线下载器接入前，更新命令明确报告当前不可用。

本地[初始安装脚本](../../../../scripts/install-native-cli.ps1)使用已构建的 launcher 和 SEA 产物，准备 `bin/cooper.exe`、首个版本目录和 `current.json`。安装先在同卷暂存并验证启动，再移入用户安装目录，最后登记用户 `PATH`。现有原型可通过内部命令 `cooper --launcher-activate <版本>` 激活已经放好的版本。激活和回滚共用安装锁，并在同卷替换状态文件。切换指针以后，已打开的进程继续持有各自的版本目录。

后续下载器应先在同一安装盘暂存并验证平台资产，然后把完整版本目录移入 `versions/`，最后调用 launcher 提交切换。通道和资产仍由现有[发布策略](../../implemented/process/2026-11-10-release-strategy.md)和[标签规则](../../implemented/process/2026-11-10-tag-discipline.md)定义。

本机 Setup 使用 [Inno Setup](../../../../scripts/windows/cooper-setup.iss) 负责当前用户的安装登记和卸载。重跑 Setup 可修复移除的程序文件或损坏的版本指针，也可替换固定入口。launcher 等待 CLI 退出期间持有运行锁，Setup 和卸载需要独占该锁。卸载按安装根目录清理程序和对应的 `PATH` 项，用户配置和会话继续由 `~/.cooper` 管理。

## Alternatives considered

**直接替换 `cooper.exe`。** Windows 运行中的程序会占用版本文件，替换需要等待已有实例结束或另设更新进程。版本目录让一次切换只提交小型状态文件。

**使用 npm 的全局命令入口。** 该入口的可见性随版本管理器切换，适合保留为 npm 安装方式。原生入口由一次独立安装提供，并随项目的 Node 切换继续可用。

## Acceptance criteria

- 在子进程 `PATH` 找不到 `node` 时，从固定路径正常运行 SEA CLI。
- 激活下一版本时保留正在运行的旧版本。新调用取得新版本，回滚可在当前版本缺失时恢复上一版。
- 保留工具使用的工作目录、参数、输入输出和子进程退出码。

## Risks

引入 Rust 编译 Windows launcher 的构建链。launcher 自身的升级需要安装流程支持，版本目录也需要保留规则，保证回滚目标和活跃进程可以继续使用。使用位置参数发送提示的旧脚本需要加上 `-p`。
