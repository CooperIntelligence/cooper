# Agent Note: Internal Windows Builds

Status: implemented

## Problem

实验安装包用人工编写的 `+local.*` 后缀可以区分文件名，但仍登记成公开安装，并复用公开客户端的配置和会话。一次分支上有多轮测试时，还需要能把 CLI、Desktop 的结果追溯到同一次构建。

## Decision

内部 Windows 构建拥有显式的 `internal` 渠道。配对构建为 CLI 和 Desktop 分配一个本地日期加递增序号的构建号，附加到产品版本，例如 `0.2.0-alpha.2+internal.20261122.1`。渠道从编译时设置传到应用和启动器，产品版本和 Git/npm 公开发布规则沿用 [Release Tag Discipline](2026-11-10-tag-discipline.md)。

构建记录保留实验名称、Git commit、工作区是否有改动、文件内容指纹和两个安装包的 SHA-256。配对构建校验源码指纹，完整的 `build.json` 表示两份产物均已生成。序号由本地构建工作区分配，排序依据日期和序号。

内部安装项使用自己的 AppId、目录和启动入口。`cooper-internal` 使用独立的版本指针和回滚历史。内部 CLI 和 Desktop 共享 `~/.cooper-internal` 下的配置、MCP 设置和会话，Desktop 另用自己的 Electron 用户数据目录。

## Alternatives considered

**把实验迭代占用公开 alpha 编号。** 实验包可能未经发布准备，同一公开候选版本也可能反复打包。公开预览版本与内部构建分别编号。

**只改安装包文件名。** Inno Setup 以 AppId 标识安装，改文件名仍会覆盖原安装并复用用户数据。能并装和独立卸载是测试安全边界的一部分。

## Consequences

内部包需要单独配置模型连接。在干净工作区构建时可以按 commit 复现源码，脏工作区的指纹用于辨别输入，构建记录并不保存未提交的源码。内部产物留在本地构建输出，公开发布工具继续用公开渠道。
