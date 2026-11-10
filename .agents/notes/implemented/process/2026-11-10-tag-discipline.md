# Agent Note: Release Tag Discipline

Status: implemented

## Problem

发布要在 GitHub 和 npm 两侧各留标签，而两侧都没有内建的纪律：git tag 可以
随手乱命名、npm 的 `latest` 默认跟随每次裸发布。没有成文规则时，指针会在
某次手滑后指向实验版本、tag 会漏打或打错名、事后无人说得清某个版本该从
哪里获得。本 Note 规定**标签体系是什么、指针怎么分配、用什么规则维持** ——
纪律是唯一事实源，发布脚本是纪律的执行器。

## Decision

本 Note 只管标签纪律；包名、发布形态、演进路线与首发时机见
[npm Release Strategy](2026-11-10-release-strategy.md)。

### 版本语法（两侧共同的连接键）

```
{base}-{train}.{N}        train ∈ { alpha | rc }，正式版无后缀
例：0.1.0-alpha.1   0.1.0-rc.1   0.1.0（首个正式版出现前不存在）
```

同一 base 内 semver 强制 `alpha < rc < 正式`；跨 base 按 base 比较。
版本列车：bump base → `alpha.1..N` 迭代 → `rc.1..N` 迭代 →（正式版
另议，见 Consequences 的重审触发条件）。

### GitHub 侧：git tag 体系

- **命名**：`v` + 完整版本号，annotated —— `v0.1.0-alpha.1`、
  `v0.1.0-rc.1`。alpha/rc 的通道身份**编码在版本号里**，不另设标签名。
- **一一对应**：每个已发布到 npm 的版本（含每个 alpha、rc）恰好一个
  同名 git tag，指向发布该版本的 commit（bump 独立成 commit，形如
  `chore(release): 0.1.0-rc.1`）。
- **git tag 只做锚点，不承担通道语义**。GitHub 侧不设可移动的通道
  tag（如名为 `alpha`/`rc` 的浮动标签）—— 通道只存在于 npm 指针；
  git tag 推送后永不移动、永不删除。
- （阶段 2 起）GitHub Release 挂在同一个 `v` tag 上，资产必须由该
  tag 的 commit 构建；Release 的 prerelease 勾选仅是展示标记，不构成
  通道。

### npm 侧：dist-tag 指针分配

```
latest → 最新 rc 版本       裸 npm install 获得的推荐版（预览期推荐 = rc）
alpha  → 最新 alpha 版本     实验线，仅显式 @alpha 获得
```

- **每次发布恰好移动本线一个指针**：
  - 发 alpha：`npm publish --tag alpha`（只动 `alpha`）
  - 发 rc：`npm publish --tag latest`（只动 `latest`；等价于默认值，
    但必须显式写出，脚本强制 tag 参数存在）
- **alpha 永不触碰 `latest`**：两条线的发布命令在脚本中物理分离，
  不存在一条能同时动两个指针的路径。
- 指针可随时向后拨（见 R5 回滚），但向前推进只随发布发生。

### 纪律规则

- **R1** 版本唯一事实源：`apps/cli/package.json` 的 `version`；bump
  独立 commit。
- **R2** 每个发布版本一个 `v{version}` git tag，与 npm 版本一一对应
  （含每个 alpha/rc）。
- **R3** 禁止裸 `npm publish`：发布必须经脚本，tag 参数必须显式
  （alpha 线 `--tag alpha`，rc 线 `--tag latest`）。
- **R4** alpha 线与 `latest` 指针操作物理分离（见上）。
- **R5** 不可变纪律：版本号不复用；已推送的 tag 不移动、不删除；已发布
  版本不删除。回滚 = `npm dist-tag add` 把指针拨回旧版本，不删任何东西。
- **R6** 发布顺序：手动期 = 干净工作区 → bump commit → publish →
  推送 commit 与 tag（先发后推）；CI 期（开源后）= 推 `v*` tag → CI
  校验 version == tag 名 → publish（tag 先行，因 CI 由 tag 触发）。
- **R7** 校验：发布前断言（工作区干净、当前 commit 带 `v{version}`、
  tag 参数显式）；发布后 audit —— npm 每个版本 ↔ git 同名 tag 一一
  对应；`latest` 目标必须带 `-rc.` 后缀；`alpha` 目标必须带
  `-alpha.` 后缀；两指针目标 ∈ 已发布版本。
- **R8** 纪律变更先改本 Note、再改脚本：指针分配、命名、顺序的任何
  改动以本 Note 为准，脚本永远是纪律的执行器而非事实源。

### 机制事实（纪律的依据）

两侧系统完全独立，以下为准确陈述，规则均由此推导：

- **npm 不读 git**。`npm publish` 只读工作区 `package.json`，不校验
  commit、tag、工作区干净与否 —— 从脏工作区可以发布任何 commit 都不含
  的版本号，漂移在机制上可能，只能靠流程约束。
- **dist-tag 与仓库历史正交**。`npm dist-tag add` 移动指针时不产生任何
  commit；指针可指向任意旧新版本（Claude Code 的 `stable` 落后于
  `latest` 即实例），与 git tag 不存在一一对应。
- **git tag ≠ GitHub Release**。前者是仓库内 commit 引用；后者是挂在
  tag 上携带 notes 与资产的 UI/API 对象，两者可独立存在。
- **`gitHead` 不是同步机制**。npm 发布时客户端可能记录 HEAD 哈希
  （实测 `ink@8.0.0` 有；DeepSeek Harness、Claude Code 近期版本没有），
  客户端提供、服务端不验证，不证明工作区干净、不绑定 tag。
- **三个事件彼此独立**：push git tag、npm publish、（阶段 2 起）Release
  资产上传 —— 任何两个成功不蕴含第三个，两两之间都有失败窗口。
- **漂移的五种形态**：① tag 已推、publish 失败；② 已发布、tag 漏推；
  ③ 脏工作区发布（任何 commit 都不含该版本）；④ 指针指错线（默认安装
  拿到 alpha）；⑤（阶段 2）Release 资产与 tag 的 commit 不符。
  R1–R7 逐条对应压制这些形态；R7 的事后 audit 兜底 ①②。

## Alternatives considered

- **三指针制（`latest` / `rc` / `alpha`，Claude Code 式再加 `stable`）**：
  预览期 `latest` 与 rc 同物，第三个指针零信息量；`stable` 需要正式版
  才有意义。两指针是当前最小完备集；首个正式版出现前重审（见
  Consequences）。
- **独立 `rc` 指针**（`npm i pkg@rc` 与 `@latest` 分开）：预览期两者
  必然同目标，徒增一次指针维护；保留为正式版出现后的候选方案。
- **GitHub 侧浮动通道 tag**（名为 `alpha`/`rc` 的可移动 git tag 镜像
  npm 指针）：git tag 约定不可变，移动即破坏已 fetch 副本；且指针移动
  不产生 commit，映射无定义。通道语义只放 npm 一侧。
- **用 `npm version` 一条命令完成 bump+commit+tag**：官方工具、原子性
  好；但顺序固化为先 tag 后 publish，且不带显式 dist-tag 与护栏编排，
  需要的是一条统一批发布脚本（其 bump 规范可借用）。
- **只给 rc 与正式版打 git tag，alpha 不打**：更干净；但 npm 版本发布
  即永久，每个版本都应有 commit 锚点，几十个 ref 成本可忽略。
- **以 npm 为事实源**（从 registry 回拉版本写入仓库）：构建需要版本在
  仓库内，离线/私有构建时 registry 不可达，方向不成立。
- **只靠 provenance 不打 tag**：provenance 依赖公开仓库与 CI（开源后
  才有），此前等于零关联；tag 同时服务人类阅读与 Release 资产锚点。
- **首发走 alpha、`latest` 暂指 alpha**：默认安装应拿到最好的构建
  （rc），实验线必须显式请求；首发即按纪律发 rc。

## Consequences

- **R3/R7 的强制脚本尚未落地**：当前由发布者按本 Note 人工执行，
  audit 人工比对；脚本化（发布脚本强制显式 tag + 断言、audit 脚本）
  是纪律从"自觉"变"强制"的关键路径。脚本实现后仍以本 Note 为事实源
  （R8）。
- **重审触发条件**：任何正式版发布前必须重审本纪律 —— 正式版出现时
  `latest` 是否从 rc 切到正式、rc 线是否需要独立指针，本 Note 只覆盖
  预览期（当前 reality：零正式版）。
- **先发后推的窗口**：手动期"publish 成功、推送失败"之间 npm 与 git
  无事务，靠 R7 事后 audit 发现；窗口期版本对任何 npm 读者可见但尚无
  公开 git 锚点。
- **alpha 列车使 git ref 持续累积**（R2 的代价，已评估可接受；变更
  须先改本 Note）。
- **多包边界**：将来发布第二个包（如 core）时，一个 git tag 对多个
  npm 版本，需锁步 bump —— 本 Note 按单包（`apps/cli`）设计，多包时
  须重审。
