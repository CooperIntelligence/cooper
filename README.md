# Cooper Code

Cooper Code 是在终端里工作的 AI 编码助手。用自然语言交代任务，它会阅读代码、修改文件、运行测试，再把结果带回同一个对话。

## 它能做什么

- **先看方案，再动手。** `plan` 模式只读地梳理代码、制定方案；切到 `ask` 后，写文件、执行命令、发起网络请求前都会先展示文件差异或完整命令，由你批准再执行。
- **从对话到脚本。** 在交互界面跟进多步任务；用 `-p` 发起单次请求，stdout 只有模型的回答，工具进度和诊断走 stderr，可以直接重定向给脚本。
- **接着上次做。** 会话按工作区保存，重开终端后用 `--resume` 继续；`--sessions` 列出当前工作区的会话。
- **接自己的模型。** 支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三种协议，模型 ID、服务地址和 API 密钥由你配置；实验性的模型档位（`sera`、`cher`、`thr`）可在多个模型之间随时切换。
- **按需扩展。** Skills 让模型按需加载你写的工作流；MCP 接入外部工具服务器；内置网页抓取与搜索。

## 快速开始

需要 Node.js 22.12.0 或更高版本。在仓库根目录运行：

```bash
npm install
npm run dev
```

首次交互启动时，按引导选择 API 协议，填写模型 ID、服务地址和 API 密钥。

试着输入「找出处理登录请求的代码，解释调用链，并给出需要补测的场景」。在输入框键入 `/help` 查看交互命令。

```bash
npm run dev -- --mode plan                          # 只读梳理代码
npm run --silent dev -- -p "解释这个项目的入口"      # 单次请求，回答可重定向
npm run dev -- --sessions                           # 列出当前工作区的会话
npm run dev -- --resume <id>                        # 继续已有会话
```

## 文档

- [使用参考](USAGE.md) — 命令行参数、交互命令、配置文件、权限模式、扩展接入。
- [源码与设计](docs/README.md) — 架构、模块边界与实现约束，面向改动代码的开发者。
- [MIT 许可证](LICENSE) · [仓库约束 AGENTS.md](AGENTS.md)
