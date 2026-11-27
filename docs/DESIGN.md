# AGY × Codex 双端编排与定制架构设计

## 1. 背景与目标

本分支 `personal/agy-codex-orchestration` 在保留 `main` 跟踪上游的同时，面向 **原生 Linux / WSL2 / macOS + Antigravity (`agy` 主控) + ChatGPT 订阅版 Codex (`codex-cli 0.172.0`：GPT-6.2 Sol / Astra)** 落地完整的单人工程闭环，并纳入 GPT-6.2 Astra 红队审查后的全部修正项。运行与安装仅依赖 **Node 24+** 与 `codex-cli`（`bun` 仅在开发仓库跑 `validate:effect` 时需要）。

常规流程由 Neon 主控，配合 Codex Sol 与 Astra。可用 `agy models` 复核 Antigravity 模型 ID。

- **Gemini 4 Neon**（`gemini-4-neon-high`）负责架构设计、派单协调与验收。常规和高危 L2 默认由 Astra 配全新隔离的 Neon 盲审。Neon 只接收静态 `review_bundle.md`，不继承开发历史，组合不消耗 Claude 额度。
- **GPT-6.2 Sol** 负责日常只读侦察和代码实现，`scout` 与 `impl` 默认均为 `medium`。两类任务都应限定目标目录和关联文件，使上下文远低于 272K Token。
- **GPT-6.2 Astra** 负责只读红队排雷、L2 的第一席深度审查（`dispatch-codex run --role review --deep`，`high`）与 Sol 实现受阻后的攻坚。
- **Gemini 4 Hydrogen**（`gemini-4-hydrogen-low`、`gemini-4-hydrogen-medium`）仅在两种情况下临时启用。单次输入超过 272K Token 或需要音视频排障时，使用其 1M 平价上下文和原生音视频支持。ChatGPT Plus 达到 5 小时或周上限时，用 Hydrogen 过渡到额度恢复。
- **Gemini 4 Carbon**（`gemini-4-carbon-high`）仅由用户按需手动切换。
- **Claude Sonnet 5.5**（`claude-sonnet-5-5-high`）仅在用户明确要求一次额外 Anthropic 独立全审时作为 L2 第二席，对静态包做单轮盲审。
- **Claude Opus 5.5** 审查席位仅用于第三级客观终审（默认 `claude-opus-5-5-medium`，极复杂时用 `claude-opus-5-5-high`）和 L3 UI 评分（`claude-opus-5-5-high`）。

Gemini 共享配额耗尽后，由 Claude Opus 5.5 或 Sonnet 5.5 接管协调。Neon 与 Claude 主控均用 `dispatch-codex run --role scout` 将代码库摸排、调用链追踪和日志检索交给 Sol，主控依据侦察结果做架构决策和验收。Claude 主控时，L2 只用 `dispatch-codex run --role review --deep` 派 Astra，由主控直接复核。

主控必须记录并处理 Astra 红队或 L2 提出的 `Blocking / High / Critical` 发现，严禁静默驳回。先由 Sol 用最小复现单测核验具体缺陷。测试无法裁定的常规或主观分歧由主控中立呈报用户。仍未解决的高危客观真伪或可达性争议交 Opus 5.5 单轮零工具终审，使用 ≤20K Token 的 `/tmp/arbitration_brief.md`，允许以 `INSUFFICIENT_CONTEXT` 退回。敏感安全争议可能触发非 CVP 账号静默降至 Opus 4.8，安全结论须有复现测试、Astra 和人工复核。

核心目标：
1. **P0 顺手修复**：修补模型匹配漂移（Fable 5.2 / Sonnet 5.5 / Haiku 5.5）、清理退役 Skill 引用与 `TOOLING-CHANGES.md` 本机路径、`AGENTS.md` 压回 14 KB 预算内零警告、修复 `inventory.mjs` 与 `proof-publication.mjs` 细节缺陷。
2. **双端一致安装**：支持 `./install-skills --only <skill>` 首次子集安装（且不误删共享 `~/.local/bin` 中其他 Harness 的命令）；为 Codex 提供自包含、零外部 Skill 依赖的只读审查 Profile（`review-sol` / `redteam-astra`）与极简执行者守则（`codex/executor-AGENTS.md`）。
3. **确定性单入口派单与并发（`dispatch-codex`）**：用 Effect v4 + TypeScript 封装唯一派单 CLI，统一 ChatGPT 登录锁定、角色与 Effort 分级、原子锁三轮熔断、显式 `git worktree` 隔离（禁用黑盒 `codex exec --worktree`）、完整 `git status -uall` + `git diff HEAD --stat` 验收输出、以及批量并发子任务（单点失败不拖垮兄弟任务）。
4. **评审阶梯与 Claude 池节流**：`code-review` 使用 L1（Sol）、L2（Astra + 隔离 Neon，用户显式要求时由 Sonnet 担任第二席）和 L3（Opus 5.5 视觉评分）。统一静态评审包、盲审隔离和时限，并按第 2.5 节裁定争议。改造 `grilling` 默认支持 `docs/DESIGN.md`。
5. **双端确定性护栏**：父端 Antigravity `PreToolUse` Hook（`packages/guardrails/agy-pretool-guard.ts`）与执行端 Codex `execpolicy` 规则（`packages/guardrails/codex-guardrails.rules`）各守边界。

## 2. 模块边界与接口契约

### 2.1 模型匹配与安装器子集契约
- `skills/writing-for-agents/scripts/materialize-skill-variants.mjs`：
  - `claude-fable-5-2` / `claude-fable-5.2` 匹配至 `claude-fable-5.1` Profile（避免日常升级报错，仍遵守现有版本比较与回退逻辑；明确支持 `claude-fable-5[.-]2` 精确匹配或兼容匹配并在测试覆盖）。
  - 新增 `claude-sonnet-*`、`claude-haiku-*` 家族识别（归入 `anthropic-sonnet` / `anthropic-haiku`，映射至现代 Claude 5.5 提示词 `claude-opus-5.5` 作为非精确兼容回退，或直接路由到 `claude-opus-5.5` 并在单测覆盖，确保 `--harness claude --model claude-sonnet-5-5` 不再报 `unsupported model family`）。
- `skills/writing-for-agents/scripts/install-skills.mjs` & `install-commands.mjs`：
  - 新增可重复参数 `--only <name>`（与 `--skill` 互斥）：
    - 允许在空白或已有 Harness 根目录下创建/替换为仅包含指定 Skill 子集的受管视图；
    - 仅回收当前 Harness 视图中未被选中的 Skill 软链；
    - 共享命令目录 `~/.local/bin/.jesse-merhi-skills-commands` 在 `--only` 模式下保留来自同一 `sourceRoot` 的其他 Skill 命令，不因单个 Harness 装子集而误删另一 Harness 依赖的命令。
  - 既有 `--skill`（增量更新已有视图）与全量安装（回收过时命令）行为 100% 保持兼容。

### 2.2 Codex 独立只读 Profile 与执行者守则
- `codex/orchestration/review-sol.toml`（及软链 `codex/review-sol.config.toml`）：`model = "gpt-6.2-sol"`, `model_reasoning_effort = "high"`, `[memories]` 全关，内联核心可读性/正确性/只读约束，**不依赖 `wait-efficiently` 或 `code-review` Skill**。
- `codex/orchestration/redteam-astra.toml`（及软链 `codex/redteam-astra.config.toml`）：`model = "gpt-6.2-astra"`, `model_reasoning_effort = "high"`, `[memories]` 全关，专注并发竞态、故障恢复、资源泄漏与边界隐患排雷。
- 清理 `codex/orchestration/findings-reviewer.toml` 与 `codex/orchestration/oracle.toml` 中已退役的 `parallel-slice-orchestration`、`pr-review-checkout`。
- `codex/executor-AGENTS.md`：~30 行极简执行者守则，供链接至 `~/.codex/AGENTS.md`。
- `packages/codex-profiles/install.mjs`：同步安装新增的 `review-sol.config.toml` 与 `redteam-astra.config.toml`。

### 2.3 确定性派单 CLI：`dispatch-codex`
位于 `skills/agy-codex-orchestrator/`，通过 `install-commands.mjs` 注册为 `~/.local/bin/dispatch-codex`（`runtime: ["node"]`）：
- **子命令**：
  - `dispatch-codex run --role <redteam|impl|escalate|review|scout> [options]`
  - `dispatch-codex batch --plan <json-file> [--concurrency 2]`（显式独立 `git worktree` 并发，捕获单项失败不中断兄弟任务，统一输出逐项状态与路径）
  - `dispatch-codex status --task <id>` / `dispatch-codex reset --task <id>`
- **角色映射（均强清 `CODEX_API_KEY` / `OPENAI_API_KEY` 并锁定 `model_provider="openai"` + `forced_login_method="chatgpt"`）**：
  - `redteam`：`gpt-6.2-astra`、`high`、`-s read-only --ephemeral`（若已安装 `redteam-astra.config.toml` 则附带 `-p redteam-astra`）
  - `review`：默认 `gpt-6.2-sol`（`--deep` 切 `gpt-6.2-astra`）、`high`、`-s read-only --ephemeral`（已安装则附带 `-p review-sol` / `-p redteam-astra`）
  - `impl`：`gpt-6.2-sol`、默认 `medium`、`-s workspace-write`。简单脚手架或文档用 `--effort low`，复杂逻辑或重构用 `--effort high` 或 `--effort xhigh`。
  - `escalate`：`gpt-6.2-astra`、默认 `xhigh`、`-s workspace-write`
  - `scout`：`gpt-6.2-sol`、默认 `medium`、`-s read-only --ephemeral`，跳过审查 Profile 和写任务重试锁。Neon 与 Claude 主控均默认走此入口，简单查找可用 `--effort low`。
  - 所有角色均可用 `--effort <low|medium|high|xhigh>` 覆盖默认值。
- **上下文与应急切换**。派发 `scout` 或 `impl` 时限定目标目录和关联文件，使上下文远低于 272K Token。仅在单次输入超过 272K Token 或需要音视频排障，或 ChatGPT Plus 达到 5 小时或周上限时，才在 Antigravity 临时切用 Hydrogen。
- **Prompt 边界注入**：统一在发送给 Codex 的 prompt 顶部附加最高优先级任务边界声明，压制第三方仓库 `AGENTS.md` 中的无关编排规则。
- **原子状态与三轮熔断**：
  - `impl` 和 `escalate` 必须传入 `--task <id>`，包括 `--dry-run`。升级到 `escalate` 时沿用同一个任务 ID。
  - 默认状态目录：`~/.local/state/agy-dispatch/<repo-hash>/<task-id>.json`（可用 `--state-dir` 覆盖便于测试）。
  - 复用进程身份锁（PID + `ps lstart`），启动前原子登记 `status: "running"`, `pid`, `attempt`, `worktreePath`, `baseHead`；同 `task-id` 若已有存活进程直接拒绝重派；写任务 `attempt >= 3` 硬熔断（退出码 `3`，除非 `--reset`）；`impl` 连续失败 `>= 2` 次提示或阻断并要求切 `escalate`（除非 `--force-sol`）。
- **显式 Worktree 与完整验收**：
  - 禁用 `codex exec --worktree`；传入 `--worktree <dir>` 时由 `dispatch-codex` 执行 `git worktree add` 并对 `codex exec` 传 `-C <dir>`。
  - 执行前在 WSL2 环境下校验目标路径不在 `/mnt/` 下（原生 Linux 与 macOS 自动跳过 `/mnt/` 误判；WSL2 下 `--allow-mnt` 可显式豁免）。
  - 执行后在**实际执行目录**收集 `git status --porcelain=v1 --untracked-files=all` 与 `git diff HEAD --stat`，输出结构化验收摘要（支持 `--json` 与 `--dry-run`）。

### 2.4 双端确定性护栏与生效自检门禁（Phase 2 & 跨平台）
- **WSL 环境探测**：仅在 `process.platform === "linux"` 且存在 `WSL_DISTRO_NAME` / `WSL_INTEROP`（或 `/proc/version` 含 `microsoft`）时启用 WSL2 `/mnt/<drive>` 跨盘护栏，原生 Linux 与 macOS 不误伤 `/mnt/data` 等常规挂载点。
- `packages/guardrails/agy-pretool-guard.ts`（`PreToolUse` Hook）：
  - 解析 stdin JSON（Effect Schema 校验），仅拦截 `toolCall.name === "run_command"`；
  - `git push --force` / `-f`（非 `--force-with-lease`）、`git reset --hard`、`git clean -fdx`、破坏性 `rm -rf`（含 Linux `/home`、`/root` 与 macOS `/Users`、`/System`、`/Applications`、`/Library`、`/Volumes`）→ 返回 `force_ask` 或 `deny`；
  - 仅在 WSL2 下对 `/mnt/[a-zA-Z]/` 的高频构建/包管理/测试命令返回 `ask` 并给出跨挂载提示；
  - 明确注释仅保护父端 `agy` 工具调用，不宣称隔离 Codex 内部命令。
- `packages/guardrails/agy-preinvocation-guard.ts`（`PreInvocation` 生效自检与拦截 Hook）：
  - 每次会话首次调用（`invocationNum === 1`）执行纯本地 fs 零网络、零 Token 自检：核对 `~/.gemini/GEMINI.md`（或 `~/.gemini/config/GEMINI.md`）可读、核心 Antigravity Skill（`agy-codex-orchestrator`、`code-review`）以实体目录存在于 `~/.gemini/config/skills/` 且 `realpath` 未逃逸、`~/.local/bin/dispatch-codex` 可执行、Codex 侧 `review-sol` / `redteam-astra` Profile 与 `guardrails.rules` 未断链；
  - 环境变量逃生阀 `AGY_ORCH_GUARD`：默认 `strict`（任一项缺失直接返回 `errorMessage` + `terminationBehavior: "terminate"`，在调模型前硬拦截）；`warn` 降级为 `systemMessage` + `user_markdown` 高亮告警放行；`off` 跳过。
- `packages/guardrails/codex-guardrails.rules`：
  - Codex 原生 `execpolicy` 规则（经 `codex execpolicy check` 校验），对 `git push --force`、`git push -f`、`git reset --hard`、`rm -rf` 设为 `decision="forbidden"`。
- `node packages/guardrails/render-agy-hooks.mjs`：输出包含 `deterministic-command-guard`（`PreToolUse`）与 `orchestration-health-gate`（`PreInvocation`）的完整 Hook 配置，使用当前 Node 24+ 与本仓库脚本的绝对路径。
- **一键跨平台激活与安装期 `doctor` 门禁**：
  - `packages/guardrails/verify-orchestration.mjs`：安装期硬门禁，校验 Node ≥ 24、`~/.gemini/GEMINI.md`、13 个 Antigravity 实体 Skill 及其 `realpath`、极简非登录 `env -i` 下的 `dispatch-codex` 路由（含 `-p review-sol` / `-p redteam-astra`）、`codex login status`（ChatGPT 登录）、5 个 Codex Skill / 5 个 Profile / `codex execpolicy check`、以及实际执行 `hooks.json` 中的 `PreToolUse` 与 `PreInvocation` 命令；任一项不通过非零退出。
  - `scripts/activate-orchestration.mjs`：统一 Linux / WSL2 / macOS 激活入口，支持 `--dry-run` / `--node-bin` / `--skip-codex-login-check`，幂等安装双端配置（备份并保留 `~/.codex/AGENTS.md` 用户自定义段与 `~/.gemini/config/hooks.json` 既有其他 Hook），最后强制调用 `verify-orchestration.mjs`。

### 2.5 Skill 适配与全局配置激活
- `skills/code-review/` 对常规和高危 L2 均默认派 Astra（`--deep`，`high`）加全新隔离的 Neon（`gemini-4-neon-high`），不消耗 Claude 额度。仅用户显式要求额外 Anthropic 全审时用 Sonnet 5.5（`claude-sonnet-5-5-high`）作单轮静态第二席。Claude 主控时只派 Astra，由主控复核。
- L2 派发前冻结同一份目标，预打包静态 `review_bundle.md`，包含设计和需求摘要、`git diff --stat` 与冻结 diff。超过 1,500 行时，包内放核心非测试 diff 和关键调用方片段。两席隔离，双方交卷前各自保密。静态席位在 1,500 行及以下零工具调用，超大 PR 缺少关键调用方时最多做 2 次定向 `read_file`，禁止搜索、终端操作和嵌套 `agy -p` 派单。
- 额度等待立即关闭，连续 60 秒无工具或输出进展也关闭。单轮静态席位从启动起上限 180 秒，仅超过 1,500 行且确需补查时上限 300 秒。缺席时记录 `<模型> 缺席（原因）`，L2 继续用 Astra，L3 缺 Opus 时标记视觉评审未完成。严禁静默换模。
- 主控严禁静默驳回 Astra 红队或 L2 的 `Blocking / High / Critical` 发现。逐条记录证据与处理结果，并按三级裁决阶梯处理。
  1. 派 Sol 编写并运行最小复现单测，核验具体 Bug、竞态、边界崩溃或泄漏。测试因所指行为失败即确认缺陷并修复。
  2. 常规或主观取舍无法靠单测裁定时，主控以书记员身份按 `争议点 | Astra 原始指控与行号 | 主控反驳理由 | 修复成本评估` 四列表中立呈报用户拍板。此级不消耗 Claude 额度。
  3. 第一级未解决的高危客观争议，交 Opus 5.5 判断缺陷的真伪、可达性或协议及并发不变量是否被破坏。用 ≤20K Token 的 `/tmp/arbitration_brief.md` 收齐完整函数体、结构体和类型定义、接口契约、复现证据及双方原文（含 Astra 指控行号）。终审默认用 `claude-opus-5-5-medium`，极复杂时用 `claude-opus-5-5-high`，单轮零工具调用，180 秒硬上限。Prompt 鼓励以 `INSUFFICIENT_CONTEXT` 退回并列出缺失文件或符号。敏感安全或漏洞链争议中，Anthropic 非 CVP 账号可能静默降至 Opus 4.8。安全结论须经复现测试、Astra 与人工复核。
- Opus 5.5 只担任第三级客观终审及 L3 视觉评分席位。L3 用 `claude-opus-5-5-high`。
- 改造 `skills/grilling/`（`BASE.md` + `variants/`）使仓库内 `docs/DESIGN.md` 成为无 Obsidian 时的默认交付落盘路径。
- 本地激活：
  - 备份 `~/.gemini/GEMINI.md` 与 `~/.codex/rules/default.rules`；
  - Antigravity 侧用 `--only` 安装精简后的 13 个核心 Skill（含 `agy-codex-orchestrator`），移除无关的 `just-do-it` / `speak-fking-english` / `handoff` / `session-recall` / `pr-proof-pack` / `show-video`；
  - Codex 侧用 `--only` 安装 5 个编码与质量 Skill + `./install-codex-profiles` + `~/.codex/AGENTS.md` + `~/.codex/rules/guardrails.rules`；
  - 将生成的 Hook 写入 `~/.gemini/config/hooks.json`。如果文件已存在，只合并 `deterministic-command-guard` 条目。将 `~/.gemini/GEMINI.md` 符号链接指向纳入仓库版本管理的 `gemini/GEMINI.md`。

## 3. 验收标准
- 仓库全部检查绿灯：`bun run validate:effect`（0 error、**0 warning**）与 `./tests/skills-test` 全部通过。
- 新增契约测试全通过：`materialize-skill-variants.test.mjs`、`install-skills.test.mjs`、`packages/codex-profiles/install.test.mjs`、`skills/agy-codex-orchestrator/src/DispatchCodex.test.ts`、`packages/guardrails/agy-pretool-guard.test.ts`。
- 实机端到端冒烟验证：`dispatch-codex --dry-run`、真实 `codex exec` Profile 加载、`codex execpolicy check`、Hook stdin/stdout 拦截测试均通过。
