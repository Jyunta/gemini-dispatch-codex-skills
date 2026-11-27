# 任务拆解与进度看板 (`personal/agy-codex-orchestration`)

## 任务清单

- [x] **T1｜P0 顺手修复**：修模型家族匹配（Fable 5.2 / Sonnet 5.5 / Haiku 5.5）、清理退役 Skill 引用、脱敏精简 `TOOLING-CHANGES.md`、`AGENTS.md` 压回 14 KB 零警告、修 `inventory.mjs` 与 `proof-publication.mjs` 入口与文案。
- [x] **T2｜安装器子集安装 (`--only`) + Codex 独立审查 Profile**：扩展 `install-skills` / `install-commands` 支持首次子集安装且不误删共享命令；新增自包含 `review-sol` / `redteam-astra` Profile 与 `codex/executor-AGENTS.md` 并更新 `install-codex-profiles` 及测试。
- [x] **T3｜`dispatch-codex` 确定性派单 CLI + `agy-codex-orchestrator` Skill**：基于 Effect v4 + Schema + `CheckedProcess` 实现角色路由、ChatGPT 登录锁死、原子锁三轮熔断、显式 `git worktree` 与并发 `batch`、完整 `git status -uall` 验收输出、WSL `/mnt/` 检查及 Vitest 契约测试，注册至 `install-commands.mjs`。
- [x] **T4｜适配 `code-review`（L1/L2/L3 + Opus 盲审与超时降级）与 `grilling`（默认 `docs/DESIGN.md`）**：更新 `BASE.md`、全部 `variants/` 与引用文档，确保 `bun run lint:skills` 零错零警告。
- [x] **T5｜Phase 2 双端确定性安全护栏**：实现 `packages/guardrails/agy-pretool-guard.ts`（含 Vitest 测试）、`render-agy-hooks.mjs`、`codex-guardrails.rules`（经 `codex execpolicy check` 验证）。
- [x] **T6｜本机双端激活与全链路验收**：安全备份后安装 Antigravity 子集 Skill、Codex 子集 Skill + Profile + 执行者 `AGENTS.md` + 双端护栏 + 更新 `~/.gemini/GEMINI.md`，执行全量测试与真机冒烟验证。
- [x] **T7｜补充 Gemini 4 Carbon / Hydrogen 分层与实测 `agy models` ID**：替代已下线的 Flash，写入实测模型 ID（`claude-opus-5-5-high`、`gemini-4-carbon-high`、`gemini-4-hydrogen-low/medium`）并同步刷新本地安装。
- [x] **T8｜纠正 Gemini 4 Carbon / Hydrogen 定位（方案 A）**：Gemini 共享池常规流程仅保留 Neon 主控 + Hydrogen 只读侦察，明确 Carbon 为重型顶配、不进常规流程仅手动按需切换，并同步刷新本地安装。
- [x] **T9｜Sol 只读侦察与 Opus 5.5 接管**：新增 `scout` 角色（`gpt-6.2-sol`、默认 `medium`、`-s read-only --ephemeral`）。同步更新仓库版本管理的 `gemini/GEMINI.md`（本地 `~/.gemini/GEMINI.md` 符号链接指向该文件）。Gemini 配额耗尽时由 Opus 5.5 接管、Sol 负责侦察，L2 只派 Astra（`--deep`）。
- [x] **T10｜Sol 默认中档与 Hydrogen 应急切换**。Neon 和 Claude 主控均将日常侦察交给 Sol。`scout` 与 `impl` 默认 `medium`，支持 `--effort low`，派单限定目录和文件以控制在 272K Token 以下。Hydrogen 仅用于超长输入或音视频排障，以及 ChatGPT Plus 达到额度上限时的临时过渡。
- [x] **T11｜修复 L2 双脑盲审发现的 3 处规则/文档漂移**：补齐 `agy-codex-orchestrator` 中 Hydrogen 应急开关的周上限说明，更新 `code-review/references/codex-implementation.md` 的 `impl` 默认 `medium` 说明，放宽 `gemini/GEMINI.md` 中 Opus 5.5 异构席位适用条件至所有非 Opus 5.5 主控（含 Sonnet 5.5）。
- [x] **T12｜补充非登录子 shell 的 PATH 兜底指引**：在 `gemini/GEMINI.md` 与 `agy-codex-orchestrator` 中明确调用 `codex` / `dispatch-codex` 前在非登录 shell 补全 `~/.local/bin` 至 `PATH`，避免新会话报 `command not found`。
- [x] **T13｜L2 零 Claude 池消耗与静态盲审限时**：常规 L2 使用 Astra 加隔离 Neon，高危 L2+ 使用单轮静态 Sonnet 5.5。Opus 5.5 仅用于单轮 Oracle 仲裁与 L3 视觉评分。派发前冻结并打包 `review_bundle.md`，执行 60 秒无进展熔断、180 秒常规上限及 300 秒超大 PR 补查上限。
- [x] **T14｜审查权分离与三级争议裁决**：常规和高危 L2 默认使用 Astra 加隔离 Neon，Sonnet 5.5 仅显式按需启用。严禁静默驳回 Astra 的严重发现，依次按适用条件走复现单测、书记员呈报用户或 Opus 5.5 单轮零工具客观终审。
- [x] **T15｜跨平台通用化（原生 Linux / WSL2 / macOS）**：增加 WSL 运行时探测使 `/mnt/` 护栏仅在 WSL2 生效（不误伤原生 Linux 挂载点），补全 macOS 系统目录保护，更新 `gemini/GEMINI.md` 为跨平台护栏并明确仅依赖 Node 24+ 运行期。
- [x] **T16｜一键跨平台激活、安装期 `doctor` 硬门禁与运行期 `PreInvocation` 拦截**：支持 `install-commands` 固化 Node 24+ 绝对路径，实现 `agy-preinvocation-guard.ts`（默认严格 `terminate` + `AGY_ORCH_GUARD` 逃生阀）、`verify-orchestration.mjs` 与 `scripts/activate-orchestration.mjs`，完成全量单测与本机实机激活验活。
