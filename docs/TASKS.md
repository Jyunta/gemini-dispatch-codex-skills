# 任务拆解与进度看板 (`personal/agy-codex-orchestration`)

## 任务清单

- [x] **T1｜P0 顺手修复**：修模型家族匹配（Fable 5.2 / Sonnet 5.5 / Haiku 5.5）、清理退役 Skill 引用、脱敏精简 `TOOLING-CHANGES.md`、`AGENTS.md` 压回 14 KB 零警告、修 `inventory.mjs` 与 `proof-publication.mjs` 入口与文案。
- [x] **T2｜安装器子集安装 (`--only`) + Codex 独立审查 Profile**：扩展 `install-skills` / `install-commands` 支持首次子集安装且不误删共享命令；新增自包含 `review-sol` / `redteam-astra` Profile 与 `codex/executor-AGENTS.md` 并更新 `install-codex-profiles` 及测试。
- [x] **T3｜`dispatch-codex` 确定性派单 CLI + `agy-codex-orchestrator` Skill**：基于 Effect v4 + Schema + `CheckedProcess` 实现角色路由、ChatGPT 登录锁死、原子锁三轮熔断、显式 `git worktree` 与并发 `batch`、完整 `git status -uall` 验收输出、WSL `/mnt/` 检查及 Vitest 契约测试，注册至 `install-commands.mjs`。
- [ ] **T4｜适配 `code-review`（L1/L2/L3 + Opus 盲审与超时降级）与 `grilling`（默认 `docs/DESIGN.md`）**：更新 `BASE.md`、全部 `variants/` 与引用文档，确保 `bun run lint:skills` 零错零警告。
- [ ] **T5｜Phase 2 双端确定性安全护栏**：实现 `packages/guardrails/agy-pretool-guard.ts`（含 Vitest 测试）、`hooks.template.json`、`codex-guardrails.rules`（经 `codex execpolicy check` 验证）。
- [ ] **T6｜本机双端激活与全链路验收**：安全备份后安装 Antigravity 子集 Skill、Codex 子集 Skill + Profile + 执行者 `AGENTS.md` + 双端护栏 + 更新 `~/.gemini/GEMINI.md`，执行全量测试与真机冒烟验证。
