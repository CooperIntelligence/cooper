# Agent Note: Single Provider Configuration Source

Status: implemented

## Problem

按字段覆盖会将不同来源的协议、模型、端点和密钥拼成一组。启动时实际采用的
端点与引导验证的端点可能不同，保存的密钥也可能通过进程环境流向工作区命令。

## Decision

TUI 和 headless 的连接参数来自同一个用户级 `config.json`。引导用文件里的
已有值初始化，并把验证的连接参数写回该文件。Cooper 将文件里的密钥直接交给
provider。创建 SDK 客户端时隔离供应商环境变量，防止 SDK 的隐式默认值参与
连接配置。

## Alternatives considered

**保留逐字段的环境变量和命令行覆盖。** 这些入口便于临时切换，但各字段独立解析
会产生用户未整体配置过的连接组合。两种运行方式共用一个文件可以消除这层歧义。

## Consequences

脚本需在启动前准备配置文件。旧 `env` 对象由用户迁移到顶层字段。
工作区命令仍按宿主的正常规则继承环境，配置文件中的密钥不会因此被注入。
