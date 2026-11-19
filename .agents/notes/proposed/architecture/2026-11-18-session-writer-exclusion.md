# Agent Note: Exclusive Session Writers

Status: proposed

## Problem

Desktop、TUI 和 headless 共享会话文件，可能同时向同一个会话追加。每个进程都能读到同一个旧尾部，然后各自确认不存在某个请求或收尾记录。提交去重和工具恢复因此需要跨进程协调。Desktop 单实例也覆盖不了从 CLI 打开同一会话的情况。 [会话写入实现](../../../../packages/core/src/session.ts)

## Proposal

所有 v2 会话写入走 Core 提供的独占会话句柄。Core 按规范化目录定位 JSONL 同目录的 SQLite 文件，用 Node 内置的 SQLite 申请独占事务。SQLite 文件只承载锁，会话继续存为 JSONL。锁保持到事务关闭或进程退出。该入口要求启用了 `node:sqlite` 的运行时和本地文件系统。 [Node SQLite](https://nodejs.org/api/sqlite.html) · [SQLite transactions](https://sqlite.org/lang_transaction.html)

| 场景 | 处理 |
| --- | --- |
| **获取** | 写入者用非阻塞方式尝试获取独占句柄，锁定后读取最新日志，再对账或开始运行。持锁期间覆盖从检查到写入，以及活跃运行的工具派发和终态记录。所有宿主和后台写入路径共用入口。 |
| **释放** | 正常完成、停止或异常退出清理时关闭锁句柄。句柄禁止继承给工具子进程。锁文件保持原位，避免两个进程锁在不同文件对象上。 |
| **进程崩溃** | 随拥有句柄的进程退出，操作系统回收锁。下一位写入者重新尝试获取，成功后重读日志。文件存在、时间戳和 PID 都不作为抢占依据。 |
| **争用或平台不可用** | Desktop 可查看已提交记录和内存恢复视图，写入操作给出具体提示。TUI 和 headless 在开始任务前报告占用或不支持。第一版只在原语验证通过的本地文件系统启用 v2 写入。 |

该契约只约束 v2 的 Cooper 写入者。旧版本通过会话版本检查退出，旧的 v1 会话仍可按原有方式使用。锁的单位是会话文件，工具进程退出和外部状态核对遵守 Core 中断恢复规则。 [Core 回合中断与恢复](2026-11-18-desktop-turn-interruption-and-recovery.md) · [Desktop 草稿与提交幂等](../feature/2026-11-18-desktop-draft-and-submit-idempotency.md)

## Implementation progress

Desktop 新建会话在内置 SQLite 可用时使用 v2，TUI 与 headless 恢复已完成的 v2 会话时使用同一写入入口。旧版会话沿用 v1。Windows 验证了 Electron 与 CLI 的真实争用、强制退出后的锁回收、审批重载及继续。WSL Arch Linux 在本地文件系统通过 Node.js 22.13.1 验证了跨进程争用、强制退出后取得同一把锁，以及未确认工具的恢复。macOS、原生 Linux Desktop 和共享文件系统待实机验收。

100 个模拟三工具回合的日志写入耗时，包含提交、派发、结果与终态，不含工具执行和模型请求。

| 本地环境 | v1 中位数 / P95 | v2 中位数 / P95 |
| --- | --- | --- |
| Windows | 0.53 / 0.75 ms | 1.01 / 1.51 ms |
| WSL Arch Linux | 0.025 / 0.029 ms | 0.041 / 0.074 ms |

## Alternatives considered

**Electron 单实例锁。** 可以减少 Desktop 重复窗口，对独立的 CLI 进程没有保护。

**排他创建文件加超时或 PID 回收。** 停顿的持有者可能被误判，回收还会引入删除他人新锁的竞态。由操作系统释放持有权可以消除这类抢占逻辑。

**写入后检测分叉。** 能诊断日志冲突，工具副作用可能已经发生。两条写入在确认前需要共享同一个互斥边界。

## Acceptance criteria

- Desktop 与第二个 Desktop、CLI 与 Desktop 分别争用同一会话，只有一个写入者。不同会话可独立运行。争用方只读查看前后文件字节一致。
- 在锁持有者已派发工具或正在提交时强制结束进程。存留的锁文件不会阻挡新写入者。重新获得锁以后核对日志和请求，避免重复追加。子进程保持存活时也不会继承锁。
- 在 Windows、macOS、Linux 验证争用、正常释放、崩溃回收和打包启动。模拟锁后端或文件系统不支持时，v2 写入明确失败，读取仍可用。运行 `npm run typecheck` 和 `npm test`。

## Risks

原生锁适配要覆盖桌面和 CLI 的打包目标及各平台 filesystem 语义。未经验证的共享文件系统先提供只读访问。锁文件会留在磁盘，系统回收句柄可能存在短暂延迟，客户端需要允许用户重试。
