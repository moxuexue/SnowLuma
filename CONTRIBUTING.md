# 贡献指南

## 分支模型

SnowLuma 使用 **`main` + `dev`** 双分支模型：

- **`main`** — 受保护的稳定分支，仅接收来自 `dev` 的合并 PR。**禁止直接 push**。
- **`dev`** — 日常开发分支。所有功能、修复、文档变更都先提交到 `dev`。
- **`native/auto-update-*`** — 由 `SnowLuma Bot` 自动创建的原生产物更新分支（来自 `SnowLumaNative`，不需要手动维护）。

## 把 `dev` 合并到 `main`

新增工作流 `.github/workflows/promote-dev-to-main.yml` 会以 `SnowLuma Bot` 身份开 / 更新一个 `dev → main` 的 PR，并可选地自动合并。三种触发方式：

无论使用哪种触发方式，工作流都会调用 `gh pr merge --auto`：**只有 `main` 分支保护中所有 required status checks（typecheck + 各架构 build）都通过后，机器人才会真正合并**。失败的工作流会卡住合并。

### 1. 提交信息前缀（推荐日常使用）

向 `dev` push 一个提交，提交信息**以**以下任一前缀**开头**即触发（不区分大小写）：

- `[merge]` — 例如 `[merge] fix: hotfix for OneBot mention`
- `chore(release):` — 例如 `chore(release): v1.7.0`，符合 conventional commits 的发版习惯

> 注意：是**前缀**匹配，不是任意位置。`fix: something [merge]` 不会触发，必须把 `[merge]` 写在最前面。

### 2. 推送 `chore.*` Tag

任何符合 `chore.*` 的 tag（如 `chore.merge-20240509`、`chore.promote-v1.7.0`）被推送时也会触发本工作流。这是和发布 tag 解耦的「合并触发 tag」：

- `chore.*` → 仅触发 `promote-dev-to-main.yml`（开 PR，自动合并）
- `v*` → 仅触发 `release.yml`（构建发布产物）

推荐流程：先用 `chore.*` tag 把 `dev` 合入 `main`，待合并完成后再在 `main` 上打 `v*` tag 触发发布。这样 `release.yml` 始终基于已经过完所有检查的 `main` HEAD 构建。

### 3. 手动触发

打开仓库 Actions 页面 → `Promote Dev to Main` → `Run workflow`。可选输入：

- `auto_merge`：是否启用 auto-merge（默认 `true`）。
- `merge_method`：`merge` / `squash` / `rebase`（默认 `merge`）。

工作流会按照当前 `dev` 与 `main` 的差异开 / 更新 PR。

## 启用 `main` 分支保护（必做）

仓库管理员需要在 GitHub 上为 `main` 配置一条规则集（Repository Rules）或经典分支保护，至少满足：

1. **Settings → Rules → Rulesets**（推荐）或 **Settings → Branches → Branch protection rules**。
2. 选择 `main` 作为目标分支。
3. 勾选：
   - **Restrict deletions** — 禁止删除 `main`。
   - **Require a pull request before merging** — 所有合并必须走 PR。
   - **Block force pushes** — 禁止强推。
   - **Require status checks to pass before merging（必勾）** — 把以下来自 `dev-build.yml` 的 check 全部加为 required：
     - `typecheck`
     - `build (win-x64)`
     - `build (linux-x64)`
     - `build (linux-arm64)`
   - **Require branches to be up to date before merging** — 保证 PR 合并前已 rebase 过最新 `main`。
4. 在 **Bypass list / Allow specified actors to bypass** 中加入 `SnowLuma Bot` GitHub App。这样 `gh pr merge --auto` 才能在所有 required check 通过后由机器人自动完成合并；否则 PR 会一直卡在 auto-merge 等待人工 review。
5. **不要**把任何用户加入 push 白名单，确保「禁止向 `main` 直接提交」的约束生效。第一次设置完后，连仓库管理员也只能通过 PR 改 `main`。

效果：任何对 `dev` 的推送都会先在 `dev-build.yml` 上跑 typecheck + 三个架构的 build；只有全部成功，promote 工作流的 `--auto` 合并才会真正发生。失败时 PR 会保留在 open 状态，修复后再次推到 `dev` 即可重新触发检查。

## 必需的 Secrets

`promote-dev-to-main.yml` 复用 `SnowLumaNative/build-native.yml` 同一个 GitHub App。请确认 SnowLuma 仓库（或 organization）级别已经配置：

- `SNOWLUMA_BOT_APP_ID` — 数字类型的 App ID。
- `SNOWLUMA_BOT_PRIVATE_KEY` — 该 App 的 PEM 私钥。

App 必须在本仓库已安装，且授予 **Contents: Read+Write**、**Pull requests: Read+Write**。

## 本地工作流速查

```bash
# 切到 dev 开发
git checkout dev
git pull

# 写代码 / 跑测试
pnpm install
pnpm typecheck
pnpm -s --filter @snowluma/core test

# 普通提交（不会触发 promote）
git commit -m "fix: something"
git push

# 把 dev 合入 main（三选一）

# 方式 A：commit-msg 前缀
git commit -m "chore(release): v1.7.0"     # 或 "[merge] fix: hotfix"
git push                                    # → 触发 promote-dev-to-main

# 方式 B：chore.* 合并 tag（与发布 tag 解耦）
git tag chore.merge-20240509                # 或 chore.promote-v1.7.0 等
git push origin chore.merge-20240509        # → 触发 promote-dev-to-main

# 方式 C：在 Actions 页面手动 Run workflow

# 合并完成后，发布版本（在 main 上打 v* tag）
git checkout main && git pull
git tag v1.7.0
git push origin v1.7.0                      # → 仅触发 release.yml
```
