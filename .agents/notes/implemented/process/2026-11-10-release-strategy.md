# Agent Note: npm Release Strategy

Status: implemented

## Problem

Cooper 目前没有任何分发渠道：用户只能 clone 仓库自己构建。开始发 npm 时会遇到
一组互相牵连、且改名成本随时间上升的一次性决策 —— 包名、发布什么、以什么形态
发布。npm 上无 scope 的 `cooper` 已被他人占用；组织 `cooper-intelligence` 与
账号 `boogon` 已创建但从未使用。如果不把理由固定下来，半年后的维护者会重新
调研一遍，或者随手选一个「看起来合理」的名字，而包名一旦发布就很难再改
（用户肌肉记忆、文档、搜索排名都会锁死它）。

## Decision

发行策略分三层：**包名、首发形态、演进路线**。三层参照 Anthropic 发布
Claude Code 的实际做法（拆包核对过 0.2.x、1.0.x、2.1.322 三个阶段的 tarball）。
标签体系与指针纪律另立一篇：
[Release Tag Discipline](2026-11-10-tag-discipline.md)。

### 包名与命令

- 包名 **`@cooper-intelligence/cooper-code`**，bin 命令 **`cooper`**。
- 产品名定为 **Cooper Code**：`-code` 后缀是品类信号，并给未来的「Cooper」
  产品族留出空间。

### 首发形态（阶段 1）

- **只发一个包**：CLI。`@cooper/core` 不单独发布，保持 `private`，随
  esbuild bundle 内置。
- 产物复用 `scripts/build.mjs`：单文件 ESM（入口自带 shebang），与 SEA
  管线共用同一 bundle。输出在**包根内**的 `apps/cli/dist/cooper.mjs`
  （不是仓库根 `dist/`）—— npm 的 `files` 白名单不能逃出包目录，SEA 的
  `sea-config.json` `main` 已同步指向该路径。
- `apps/cli/package.json` 具备：`name`、`bin`（`cooper` →
  `dist/cooper.mjs`）、`files` 白名单（只含 bundle，npm 自动附带
  `package.json` / `README` / `LICENSE`；顺带排除 `.env`、源码、
  `cooper.blob`、`cooper.exe`）、`publishConfig.access: "public"`
  （scoped 包默认按私有处理）、`license: "MIT"`、`engines.node >= 22.12.0`、
  `repository`、`description`、`keywords`；无 `private`。
- **发布包的 `dependencies` 为空**：bundle 已内联全部运行时依赖，
  workspace 的运行时依赖（`@cooper/core`、ink、react 等）一律在
  `devDependencies` —— 若留在 `dependencies`，用户安装时 npm 会去
  registry 解析根本不存在的 `@cooper/core@0.1.0`，直接装不上。
- `esbuild` 为直接 devDependency（此前只是 `tsx` 的传递依赖）。
- 发布护栏：`prepublishOnly` 在未设置 `AUTHORIZED` 环境变量时拒绝发布
  （思路抄 Claude Code，但落在 `prepublishOnly` 而非 `prepare`：
  `prepare` 在 workspace 的 `npm install` 时也会触发，会打断日常开发）。
  同一脚本里再跑 `npm test` 作为发布前检查；`prepack` 负责自动 build，
  保证 tarball 里永远是新 bundle。

### 演进路线

| 阶段 | 形态 | 对照 Claude Code | 触发条件 |
|---|---|---|---|
| 1（已落地） | 单文件 bundle 发 npm，零运行时依赖 | 0.2.x（`bin: cli.mjs`，35 MB） | 包装链路已验证，首发绑定开源日 |
| 2 | SEA 单文件可执行（`scripts/package.mjs` 已有），走 GitHub Releases | 与 npm 并行的原生分发 | 阶段 1 链路跑通后 |
| 3 | 平台子包 + `optionalDependencies` + postinstall 覆盖占位符 | 2.x（主包 200 KB + 8 个平台包） | 有真实用户、需要免 Node 运行时 |

阶段 3 的设计要点：子包带
`os`/`cpu`/`libc` 让 npm 自动选平台；子包版本与主包**精确锁定**（无 `^`）；
`bin` 放占位符，postinstall 把真二进制覆盖上去；占位符本身要能在安装被
跳过时打印清晰的修复指引。

### 发布流程

- **首发手动**：`npm login`（boogon）→ `npm pack --dry-run` 检查内容 →
  `AUTHORIZED=true npm publish --access public`（tag 按纪律显式指定）→
  全局安装冒烟。先验证整条链路。
- 跑通后接 CI（tag 触发、`AUTHORIZED` 护栏、`--provenance`）。
- 标签体系与指针纪律（GitHub tag 命名、npm `latest`→rc / `alpha`→alpha
  分配、发布与校验规则）见
  [Release Tag Discipline](2026-11-10-tag-discipline.md)，本 Note 不重复。

## Alternatives considered

- **`@cooper-intelligence/cli`**：语义清楚、与目录对应，但包名不带品牌与
  品类信息，`npm i -g` 之后用户记住的是命令而非包名，npm 页面孤立看也不
  知道产品叫什么。输给了带产品名的方案。
- **`@cooper-intelligence/cooper`**：产品名 = 包名 = bin，三者一条线；
  「品牌零改动」看似稳，实为伪收益 —— 此刻尚未发布任何东西，改名成本是
  零，以后才是真的贵。且名字不带品类信号。
- **无 scope 的 `cooper-code`**：名字可用（已查 404），但归属个人账号
  `boogon` 而非组织；组织包才能多人共管、脱离个人账号存续，也与已建好的
  `cooper-intelligence` org 意图一致。
- **core + cli 双包发布**：core 的 `main` 目前直指 TS 源码，发它需要
  一整套 tsc 构建 + `exports` 映射 + 版本联动，而 npm 上没有任何库消费者，
  纯属提前优化。单包方案零依赖解析问题、单版本号即可发版。
- **首发即上 GitHub Actions + provenance**：一步到位，但首次排错成本高
  （token、权限、构建环境全未知）；先手动跑通链路再自动化。
- **首发就做平台子包（阶段 3）**：需要 CI 矩阵构建、每平台约 340 MB 的
  上传，且 SEA 管线尚未在 CI 验证过；等有真实用户再做。

## Consequences

- 包名、bundle 路径、依赖布局、护栏均已落地并验证；**registry 首发
  绑定开源日**（发布 = bundle 可读代码公开，见发布前泄露审计结论），
  在此之前包装链路以 `npm pack` 级验证为完成态。
- **品牌一致性成本**：包叫 Cooper Code，README 及对外文案必须同步改，
  否则心智分裂。
- **单文件 bundle 的代价**：包体积数 MB；依赖升级必须发新版才能到达
  用户（没有运行时依赖树可增量更新）。阶段 1 接受此代价。
- **手滑发布**：`prepublishOnly` 护栏已实现并实测（未设 `AUTHORIZED`
  即失败；`npm install` 不受影响）；发布前 `npm pack` 人工检查；首发
  手动本身是一层验证。
- **scoped 包默认私有**：漏掉 `publishConfig.access: "public"` 会在
  发布时报错（显式失败，非静默），风险可控。
- **阶段演进不换名**：阶段 2/3 只改包内结构与分发通道，包名与 bin 保持
  不变；若未来要改名，须写新 Note 交叉链接本条。

## Testing

- `npm run typecheck` 与 `npm test` 通过（core 138 + cli 90）。
- `npm pack` 内容恰为 4 文件（bundle + `package.json` + `README` +
  `LICENSE`），无源码、`.env`、blob、exe。
- 本地 tarball `npm i -g` 后 `cooper --help` 冒烟通过。
- SEA 管线（`npm run package`）在 bundle 路径变更后验证通过。
