# Agent Note: Workspace and conversation rewind

Status: proposed

## Problem

用户把任务交给 agent 的意愿上限，取决于"改坏了能不能回来"。Claude Code 有
checkpoint（Esc-Esc 回退文件与对话），Codex 有 sandbox 回滚；Cooper 目前没有任何
回退路径：

- 审批面板显示的是**正向** diff——批准将要发生的事（`preview()` /
  `buildPreviewRows` 只服务审批）——批准之后没有反向操作。
- 会话是 append-only JSONL；`/clear` 只清对话不动文件。唯一的文件级恢复手段是
  用户自己的 git，它覆盖不了非 git 目录、脏工作区、以及 `run_command` 造成的
  改动。
- `ask` 模式下用户被迫逐条审批来换取安全感；`auto` 则不可逆，README 自己标注
  "谨慎使用"。批准是一瞬间的，收拾残局是手动的——代价不对称，所以用户不敢批。

结果是产品姿态停在"监督者"而非"委托者"。这是与 Codex / Claude Code 的核心差距，
也是用户期待的"敢把任务交出去"的第一块缺失地基。

## Proposal

**回合级 checkpoint：文件 copy-on-write 日志 + 回合指纹清单 + 对话截断，一条
`/rewind` 同时回退两者。**

三个组成部分：

1. **文件（可恢复）**：`write_file` / `edit_file` 首次写入某路径前，把原内容存入
   按会话分区的 content-addressed blob store。这是唯一保证能恢复的改动来源。
2. **检测（只报告，不恢复）**：每个用户回合开始时记录工作区指纹清单
   （path / size / mtime），用于在 rewind 时识别日志覆盖不到的改动
   （`run_command`、用户外部编辑），并在报告中如实列出——绝不静默部分恢复。
3. **对话**：rewind 向会话文件追加一条 `checkpoint` 记录（现有记录类型，action
   新增 `"rewind"`），复用 loadSession "以最后一个 checkpoint 为基底"的既有
   机制完成截断，不引入新的会话语义。

### 为什么是回合粒度

checkpoint 创建在**用户消息入列之前**（`messageIndex = history.current.length`），
语义是"撤销这一整个回合"。这与用户心智一致（"回到我下这条命令之前"），也与
Claude Code 的交换粒度一致。每次工具调用一个 checkpoint 会让记录数与存储爆炸；
回合粒度已覆盖主要场景。

### 数据布局

会话文件保持不动（除 rewind 时追加的一条既有 `checkpoint` 记录）。其余全部走
sidecar 目录，与 `sessions/` 同级：

```
~/.cooper/projects/<workspaceKey>/
  sessions/<sessionId>.jsonl            # 追加式，不因本功能改变格式
  checkpoints/<sessionId>/
    turns/<seq>.json                    # 回合记录 + 指纹清单（sidecar，可重建）
    journal.jsonl                       # COW 日志，追加式，容忍损坏尾行
    blobs/<sha256[0:2]>/<sha256>        # 文件原内容，按内容寻址去重
```

sidecar 丢失或损坏时 fail-soft：`/rewind` 报告不可用，对话与会话文件毫发无损。

```ts
// packages/core/src/checkpoint/types.ts（原型）
type TurnRecord = {
  seq: number;                // 会话内单调递增
  at: string;
  messageIndex: number;       // 用户消息入列前的 history 长度
  userPreview: string;        // 该用户消息首行，用于 /rewind 选择器
  compactionEpoch: number;    // 创建时的压缩纪元（见下文）
  manifest: Fingerprint[];    // 回合开始时的工作区指纹
  manifestTruncated?: true;   // 超过上限，检测能力降级
};
type Fingerprint = { path: string; size: number; mtimeMs: number }; // posix 相对路径

type JournalEntry = {
  seq: number;                // 首次写入该路径的回合
  path: string;
  before: string | null;      // blob hash；null = 该回合创建的文件
  after: string;              // 写入后的 blob hash，用于冲突检测
  unrestorable?: true;        // 原内容超过 2MB 上限，只记录不存 blob
};
```

### 捕获点（原型）

不改 `fs.ts`：在 core 导出一个工具包装器，宿主组装工具时套上即可。包装器在
`tool.execute` 之前读取原内容——此时审批已通过，读到的正是写入前状态；只读工具
与 `run_command` 不受影响。

```ts
// packages/core/src/checkpoint/journal.ts（原型）
export function withJournal(tool: Tool, journal: Journal): Tool {
  if (!tool.capabilities.includes("write")) return tool;
  return {
    ...tool,
    async execute(input, ctx) {
      const rel = (input as { path?: unknown }).path;
      if (typeof rel === "string") {
        await journal.capture(ctx.root, rel); // 幂等：每路径每回合只记第一次
      }
      return tool.execute(input, ctx);
    },
  };
}
```

`capture` 必须经 `resolveInRoot` 解析（规则 5），恢复时同样逐路径校验；符号链接
与 junction 按现有规则拒绝或按冲突报告。

### 对话回退与压缩的相互作用

`prune` 原地改写工具输出内容但**不改变数组长度**，`summarize` / `truncate` 会
splice——所以 `messageIndex` 只在"自目标回合以来没有发生长度型压缩"时有效。为此：

- 回合记录携带 `compactionEpoch`；宿主观察到 `context-compacted` 且
  `action !== "prune"` 时自增（TUI 已在事件循环里处理该事件，`/compact` 走同一
  路径），恢复会话时从最后一个回合记录初始化。
- rewind 规划时：`target.compactionEpoch === currentEpoch` → 对话与文件一起回退；
  否则**只回退文件**，并明确提示"此回合之后上下文已压缩，对话无法回退"。
  指纹清单与 blob 不受压缩影响，文件回退始终可用。

对话截断复用既有机制：`appendCheckpoint("rewind", truncatedMessages)`。loadSession
不区分 action，天然从该点重建；旧版本 Cooper 读到这条记录也不报错（记录类型是
既有的），向后兼容免费获得。

### Rewind 规划与执行（原型）

```ts
// packages/core/src/checkpoint/rewind.ts（原型）
type RestorePlan = {
  restore: Array<{ path: string; blob: string }>;   // 写回 blob → path
  remove: string[];                                 // 目标回合后创建的文件 → 删除
  conflicts: Array<{ path: string; reason: "modified-after-write" }>;
  untouched: number;
  unrestorable: Array<{ path: string; reason: "command-change" | "external-edit"
    | "deleted-after-write" | "oversized" }>;
  conversation: { kind: "truncate"; messageIndex: number }
              | { kind: "unavailable"; reason: "compacted" };
};

function planRewind(state: CheckpointState, target: TurnRecord, now: Fingerprint[]): RestorePlan
// 1. 当前指纹 vs target.manifest → 找出目标回合后被碰过的路径
// 2. 其中有 seq ≥ target.seq 的 journal 条目 → 取最早一条的 before blob 作为恢复源
//    （该文件在目标回合后的第一次写入前状态 == 目标回合时的状态）
// 3. 恢复源 blob 存在且当前内容 hash === 条目 after → 进 restore；
//    不一致 → 写入后被外部改过 → 进 conflicts，绝不静默覆盖
// 4. 有指纹差异但无 journal 条目 → 命令 / 外部改动 → 进 unrestorable，逐条列出
// 5. 指纹相同 → untouched（包括"agent 写过但用户已手动改回原样"的情形）
// 6. journal before === null 且 seq ≥ target.seq → 进 remove（目标回合后创建）
```

执行顺序：先全部文件操作（逐路径 `resolveInRoot` + 写入/删除），全部成功或逐项
报告失败后，才截断对话并追加 `checkpoint` 记录——文件回退与对话回退要么都完成，
要么都不动，不允许出现"对话回去了文件没回去"的半状态。最后走 `/clear` 已有的
ANSI 清屏 + 重挂载路径重建滚动区（`buildResumeView` 需小改：把入参从
`LoadedSession` 放宽为 `messages + toolUi`，对话截断后两者都在内存里）。

### 权限与交互

- rewind 是**用户发起的宿主命令**，不是模型工具，不经过 `PermissionPolicy`
  （它闸的是 agent loop 里的工具调用，规则 8）。但它是写操作，所以**三种模式下
  都必须过恢复预览面板**——确认键本身就是授权，与审批面板的 `y` 同构。
- `plan` 模式不阻止 rewind：plan 约束的是 agent 不能改工作区，而 rewind 是用户
  显式要求的回退，且方向是"减少改动"。面板照常弹出，不做降级。
- 与其他命令一致：轮次进行中（含等待审批）不可用，等 idle。
- 面板复用 `buildPreviewRows` 渲染每个文件"当前 → 恢复后"的 diff，并列出
  conflicts / unrestorable。冲突默认**不覆盖**：`y` 只恢复安全集，`a` 连冲突一起
  恢复，`n` 取消。
- 交互入口：`/rewind`（撤销最近一回合）、`/rewind <n>`（n 个回合前），选择器显示
  `userPreview` 与文件计数。Esc-Esc 快捷键、headless `--rewind` 为后续增强。

```
⏪ rewind to “修一下类型错误” · 2 turns back
   files   restored 6 · removed 1 · untouched 3
   ⚠ changed by commands, not restorable:
       src/generated/api.ts
   ⚠ edited after Cooper wrote it:
       src/agent.ts                    [k] keep mine   [y] restore Cooper's
   conversation  messages 142 → 88
   [y] rewind   [n] cancel
```

### 保留与 GC

- 每会话保留最近 **50** 个回合记录；更早的回合记录与其独占 blob 删除
  （`journal.jsonl` 是追加式的，GC 依据保留后的回合集合重算引用，不改写文件）。
- blob 天然按内容去重：同一文件连续回合的 before/after 大量重叠，实际增量存储
  接近"每回合改动量"。
- 指纹清单受 `MAX_LIST_ENTRIES` 同类上限约束，超限置 `manifestTruncated`，此时
  unrestorable 检测降级并在报告中声明"检测不完整"。

### 分阶段

- **v1（本提案）**：journal 包装器、回合指纹清单、sidecar、`/rewind`、恢复预览
  面板、压缩纪元规则、保留与 GC。
- **v2（方向已定，另行立项）**：git 临时 index（`GIT_INDEX_FILE` 建树、不动用户
  index）快照，把 `run_command` 的改动纳入可恢复范围；Esc-Esc 快捷键；按文件
  选择性恢复；headless `--rewind`。

## Alternatives considered

- **全量目录复制 / 每回合快照**：磁盘与耗时不可控（大仓库 + 依赖目录），恢复
  还要处理"快照之后用户自己改的文件"。拒绝作为地基。
- **git stash / 临时 index 建 tree**：能覆盖 tracked 改动且 git 原生，但非 git
  目录不可用，stash 语义会动 ref、与用户脏工作区交互复杂。`GIT_INDEX_FILE`
  不动用户 index，是可行的 v2 方向，但依赖 git 二进制，不应成为 v1 的前置。
- **Codex 式 overlay / OS 沙箱回滚**：长期正解——命令改动天然可回滚。但依赖
  seatbelt / landlock / Job Object，是独立的大工程，不能作为本功能的前置。
- **让模型自己撤销修改**：依赖模型记住原始内容，不可靠且浪费 token。拒绝。
- **每次工具调用一个 checkpoint**：记录数与存储爆炸，且用户心智是"回到下命令
  之前"而非"回到上一个动作"。拒绝。
- **依赖用户自己的 git**：就是现状问题本身；Cooper 不应假设工作区是 git 仓库。

明确放弃的范围：v1 不恢复 `run_command` 造成的改动（改为如实报告）；checkpoint
不跨会话（`/clear` 新会话即新 sidecar，旧会话的 checkpoint 随其会话保留）。

## Acceptance criteria

- 一个回合内 `write_file`/`edit_file` 改了 3 个文件、创建了 1 个文件；
  `/rewind` 后这 3 个文件字节级回到回合前，创建的文件被删除，对话回到该用户
  消息之前；`--resume` 同一会话后状态一致。
- `run_command` 改动的文件**不在**恢复集中，而是逐条出现在 "not restorable"
  报告里；任何情况下都不存在静默的部分恢复。
- 目标回合之后发生过 `summarize`/`truncate` 压缩 → 对话回退被拒并明确提示，
  文件回退照常完成。
- agent 写入后被用户手动改过的文件 → 进入冲突列表，默认键不覆盖它。
- 会话文件除一条既有类型的 `checkpoint`（action `"rewind"`）记录外无新增记录
  格式；旧版本 Cooper 读取新会话不报错。
- sidecar 缺失或含损坏尾行 → `/rewind` 报告不可用，对话加载与会话文件不受影响。
- `plan` / `ask` / `auto` 下 `/rewind` 都弹恢复预览面板；轮次进行中命令被拒绝
  （与现有命令一致）。
- 每个恢复路径都经 `resolveInRoot`，工作区外路径与逃逸符号链接被拒绝。
- `npm run typecheck` 与 `npm test` 通过。

## Risks

- **过度承诺风险（最大）**：v1 恢复不了命令造成的改动。缓解：报告强制逐条列出、
  文档与 `/help` 同步写明，宁可报告难看也不静默。
- **磁盘增长**：blob store 随改动量增长。缓解：50 回合上限 + 引用式 GC + 内容
  去重；`manifestTruncated` 防止超大仓库的清单本身失控。
- **Windows 文件占用 / ACL**：恢复时文件被编辑器占用可能逐项失败。缓解：逐文件
  报告结果，失败项明确列出，不回滚已成功项（以报告为准，不承诺事务性跨文件
  原子）。
- **mtime 指纹误判**：文件系统时间粒度可能把未改动判为改动。缓解：一律按冲突
  保守处理——宁可多问一次，绝不错误覆盖。
- **双读开销**：包装器在 `execute` 前多读一次原文（上限 2MB，每路径每回合一次）。
- **生命周期错位**：会话与 sidecar 分离，极端情况下只丢 sidecar（fail-soft，
  rewind 不可用但对话无损）——这是有意的取舍，不是缺陷。
