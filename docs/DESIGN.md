# AGY × Codex 双端编排与定制架构设计

## 1. 背景与目标

本分支 `personal/agy-codex-orchestration` 在保留 `main` 跟踪上游的同时，面向 **WSL2 + Antigravity (`agy` 主控) + ChatGPT 订阅版 Codex (`codex-cli 0.172.0`：GPT-6.2 Sol / Astra)** 落地完整的单人工程闭环，并纳入 GPT-6.2 Astra 红队审查后的全部修正项。

Antigravity 的 Flash 已下线，原有任务由 Gemini 4 Hydrogen 和 Gemini 4 Carbon 接替。模型分工如下，可用 `agy models` 复核 ID。

- **Gemini 4 Neon**（`gemini-4-neon-high`）负责架构设计、复杂方案与关键验证。
- **Gemini 4 Carbon**（`gemini-4-carbon-high`、`gemini-4-carbon-medium`）负责日常轻量与中等复杂度的编排、小改动，并在 Neon 不可用时接替。
- **Gemini 4 Hydrogen**（`gemini-4-hydrogen-low`、`gemini-4-hydrogen-medium`、`gemini-4-hydrogen-high`）负责代码库摸排、日志分析、并行探索等高吞吐只读任务。
- **Claude Opus 5.5**（`claude-opus-5-5-high`）用于指定的 L2 异构盲审、L3 UI 评分，以及 Neon 与 Astra 意见分歧时的 Oracle 仲裁。

核心目标：
1. **P0 顺手修复**：修补模型匹配漂移（Fable 5.2 / Sonnet 5.5 / Haiku 5.5）、清理退役 Skill 引用与 `TOOLING-CHANGES.md` 本机路径、`AGENTS.md` 压回 14 KB 预算内零警告、修复 `inventory.mjs` 与 `proof-publication.mjs` 细节缺陷。
2. **双端一致安装**：支持 `./install-skills --only <skill>` 首次子集安装（且不误删共享 `~/.local/bin` 中其他 Harness 的命令）；为 Codex 提供自包含、零外部 Skill 依赖的只读审查 Profile（`review-sol` / `redteam-astra`）与极简执行者守则（`codex/executor-AGENTS.md`）。
3. **确定性单入口派单与并发（`dispatch-codex`）**：用 Effect v4 + TypeScript 封装唯一派单 CLI，统一 ChatGPT 登录锁定、角色与 Effort 分级、原子锁三轮熔断、显式 `git worktree` 隔离（禁用黑盒 `codex exec --worktree`）、完整 `git status -uall` + `git diff HEAD --stat` 验收输出、以及批量并发子任务（单点失败不拖垮兄弟任务）。
4. **评审阶梯与 Opus 5.5 节流**：改造 `code-review` 为 L1（Sol）/ L2（Astra + 可选 Opus 5.5 异构盲审）/ L3（UI + Opus 5.5），固化冻结基线盲审与 Opus 硬超时降级契约；改造 `grilling` 默认支持 `docs/DESIGN.md`。
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
  - `dispatch-codex run --role <redteam|impl|escalate|review> [options]`
  - `dispatch-codex batch --plan <json-file> [--concurrency 2]`（显式独立 `git worktree` 并发，捕获单项失败不中断兄弟任务，统一输出逐项状态与路径）
  - `dispatch-codex status --task <id>` / `dispatch-codex reset --task <id>`
- **角色映射（均强清 `CODEX_API_KEY` / `OPENAI_API_KEY` 并锁定 `model_provider="openai"` + `forced_login_method="chatgpt"`）**：
  - `redteam`：`gpt-6.2-astra`、`high`、`-s read-only --ephemeral`（若已安装 `redteam-astra.config.toml` 则附带 `-p redteam-astra`）
  - `review`：默认 `gpt-6.2-sol`（`--deep` 切 `gpt-6.2-astra`）、`high`、`-s read-only --ephemeral`（已安装则附带 `-p review-sol` / `-p redteam-astra`）
  - `impl`：`gpt-6.2-sol`、默认 `high`（可 `--effort xhigh`）、`-s workspace-write`
  - `escalate`：`gpt-6.2-astra`、默认 `xhigh`（可 `--effort high|xhigh`）、`-s workspace-write`
- **Prompt 边界注入**：统一在发送给 Codex 的 prompt 顶部附加最高优先级任务边界声明，压制第三方仓库 `AGENTS.md` 中的无关编排规则。
- **原子状态与三轮熔断**：
  - 默认状态目录：`~/.local/state/agy-dispatch/<repo-hash>/<task-id>.json`（可用 `--state-dir` 覆盖便于测试）。
  - 复用进程身份锁（PID + `ps lstart`），启动前原子登记 `status: "running"`, `pid`, `attempt`, `worktreePath`, `baseHead`；同 `task-id` 若已有存活进程直接拒绝重派；写任务 `attempt >= 3` 硬熔断（退出码 `3`，除非 `--reset`）；`impl` 连续失败 `>= 2` 次提示或阻断并要求切 `escalate`（除非 `--force-sol`）。
- **显式 Worktree 与完整验收**：
  - 禁用 `codex exec --worktree`；传入 `--worktree <dir>` 时由 `dispatch-codex` 执行 `git worktree add` 并对 `codex exec` 传 `-C <dir>`。
  - 执行前校验目标路径不在 `/mnt/` 下（`--allow-mnt` 可显式豁免）。
  - 执行后在**实际执行目录**收集 `git status --porcelain=v1 --untracked-files=all` 与 `git diff HEAD --stat`，输出结构化验收摘要（支持 `--json` 与 `--dry-run`）。

### 2.4 双端确定性护栏（Phase 2）
- `packages/guardrails/agy-pretool-guard.ts`（`PreToolUse` Hook）：
  - 解析 stdin JSON（Effect Schema 校验），仅拦截 `toolCall.name === "run_command"`；
  - `git push --force` / `-f`（非 `--force-with-lease`）、`git reset --hard`、`git clean -fdx`、破坏性 `rm -rf` → 返回 `force_ask` 或 `deny`；
  - 针对 `/mnt/[a-z]/` 的高频构建/包管理/测试命令 → 返回 `ask` 并给出 WSL2 跨挂载提示；
  - 明确注释仅保护父端 `agy` 工具调用，不宣称隔离 Codex 内部命令。
- `packages/guardrails/codex-guardrails.rules`：
  - Codex 原生 `execpolicy` 规则（经 `codex execpolicy check` 校验），对 `git push --force`、`git push -f`、`git reset --hard`、`rm -rf` 设为 `decision="forbidden"`。
- `packages/guardrails/hooks.template.json`：指向本仓库 `agy-pretool-guard.ts` 的 `PreToolUse` 模板。

### 2.5 Skill 适配与全局配置激活
- 改造 `skills/code-review/`（`BASE.md` + `variants/` + `references/reviewer-dispatch.md` + `references/codex-implementation.md`）为 L1/L2/L3 评审阶梯，固化“冻结输入盲审”与“Opus 5.5 强制 `--print-timeout 180s` + 缺席明示降级 + 禁止嵌套 `agy -p` 递归派单”。
- 改造 `skills/grilling/`（`BASE.md` + `variants/`）使仓库内 `docs/DESIGN.md` 成为无 Obsidian 时的默认交付落盘路径。
- 本地激活：
  - 备份 `~/.gemini/GEMINI.md` 与 `~/.codex/rules/default.rules`；
  - Antigravity 侧用 `--only` 安装精简后的 13 个核心 Skill（含 `agy-codex-orchestrator`），移除无关的 `just-do-it` / `speak-fking-english` / `handoff` / `session-recall` / `pr-proof-pack` / `show-video`；
  - Codex 侧用 `--only` 安装 5 个编码与质量 Skill + `./install-codex-profiles` + `~/.codex/AGENTS.md` + `~/.codex/rules/guardrails.rules`；
  - 安装 `~/.gemini/config/hooks.json` 并重写 `~/.gemini/GEMINI.md`。

## 3. 验收标准
- 仓库全部检查绿灯：`bun run validate:effect`（0 error、**0 warning**）与 `./tests/skills-test` 全部通过。
- 新增契约测试全通过：`materialize-skill-variants.test.mjs`、`install-skills.test.mjs`、`packages/codex-profiles/install.test.mjs`、`skills/agy-codex-orchestrator/src/DispatchCodex.test.ts`、`packages/guardrails/agy-pretool-guard.test.ts`。
- 实机端到端冒烟验证：`dispatch-codex --dry-run`、真实 `codex exec` Profile 加载、`codex execpolicy check`、Hook stdin/stdout 拦截测试均通过。
