# StarBack 架构基线

## 目标与边界

StarBack 是运行在用户个人 GitHub 仓库中的 GitHub 原生工具。它只使用 GitHub Actions、Issues 和 GitHub REST API，不使用服务器、数据库、队列服务或编译后的运行产物。

v0.1 只支持个人账号拥有的 StarBack 仓库，不支持组织仓库、多人代表组织执行 Star、自动取消 Star 或永久推荐去重。

运行时使用 Node 24 的原生 TypeScript 支持。入口只有：

- `node scripts/discover.ts`：处理 `watch` 和 `schedule` 事件。
- `node scripts/star.ts`：处理 `issues.edited` 事件。

## 组件边界

```text
GitHub event
    |
    +--> discover.yml --> scripts/discover.ts
    |                         |
    |                         +--> GitHub REST API (GITHUB_TOKEN)
    |                         +--> ranking and Inbox modules
    |
    +--> star.yml -----> scripts/star.ts
                              |
                              +--> issue/repository reads (GITHUB_TOKEN)
                              +--> user starring reads/writes (STARBACK_TOKEN)
```

公共的 GitHub API 客户端统一负责认证头、版本头、User-Agent、JSON 编解码和非成功状态处理。排名、月份标题、Inbox 页面解析、checkbox diff 和失败恢复保持为纯函数或只依赖注入的逻辑，便于使用 Node 内置 test runner 和注入式 `fetch` 验证。

## 事件链

### Watch 发现链

1. `watch: [started]` 触发 `discover.yml`。
2. 工作流只授予 `contents: read` 和 `issues: write`，以仓库级 concurrency 串行执行。
3. `discover.ts` 验证事件 action、仓库归属和事件仓库与 `GITHUB_REPOSITORY` 一致；仅接受个人账号仓库。
4. 确保 `starback-inbox` 标签存在。缺失时创建颜色 `0969da`、描述 `Managed by StarBack` 的标签。
5. 关闭标题合法、带此标签且月份早于当前 UTC 月份的开放 Inbox。
6. 分页读取 `sender` 自己拥有的公开仓库，过滤 fork、archived、disabled、`size === 0` 和没有 `pushed_at` 的仓库，按确定性评分排序。
7. 扫描当月所有 Inbox，按大小写不敏感的 `owner/repo` 排除已推荐目标；同一目标只在同一 UTC 月内去重。
8. 将排名最高且当月未出现的 1 条推荐追加到当月最后一页；当前页满时创建下一页。每页最多保存 100 条，容量会跨多个 watch 事件累计。推荐行带本次 `GITHUB_RUN_ID` 标记，已有相同标记的本次运行直接成功退出。

### Schedule 维护链

每月 1 日 `00:17 UTC` 触发同一入口。Schedule 只执行第 5 步：关闭开放且标题格式合法、月份早于当前 UTC 月份并带 `starback-inbox` 标签的 Inbox；不会读取 stargazer 或写入推荐。

### Checkbox Star 链

1. `issues: [edited]` 触发 `star.yml`。job 条件先检查事件是个人仓库 owner 编辑了带 `starback-inbox` 标签的 Issue，只有满足条件的 job 才获得 `STARBACK_TOKEN`。Inbox 可以由 `github-actions[bot]` 创建。
2. `star.ts` 再次验证事件 sender 是仓库 owner、Issue 非 Pull Request、标签和 body 变化；不以 Issue 创建者作为授权条件，只处理旧 body 中 `[ ]` 严格变为新 body 中 `[x]` 的合法 `owner/repo` 行。
3. 使用 `GITHUB_TOKEN` 重新读取 Issue。目标已取消勾选时跳过，保留用户最新编辑。
4. 对每个仍勾选的目标确认公开可访问；使用 `STARBACK_TOKEN` 查询当前用户是否已 Star。已 Star 则幂等跳过，未 Star 则以 `PUT /user/starred/{owner}/{repo}` 完成 Star，并要求 `204`。
5. 多个目标逐项处理。失效目标、缺少 PAT 或 API 失败不会阻断其他目标；全部处理后重新读取最新 body，只将失败目标恢复为 `[ ]`，最后以聚合错误结束，不发布评论。

## Token 信任边界

- `GITHUB_TOKEN` 是 Actions 自动令牌，只用于读取仓库、用户公开仓库、Issue 和目标仓库，以及创建/更新/关闭 Inbox 和标签。
- `STARBACK_TOKEN` 是仓库 owner 提供的 fine-grained PAT，只用于代表 owner 查询其 Star 状态和调用用户级 Star API。它不用于 Issue 写入，也不进入无关事件的 job。
- workflow 层的 owner、标签和事件条件是减少 PAT 暴露面的第一道边界；脚本层重复验证，不能仅依赖 workflow 条件。

## Inbox 数据格式与状态

Inbox 标题只接受以下格式：

```text
StarBack Inbox · August 2026
StarBack Inbox · August 2026 · #2
```

首页没有页码后缀，后续页从 `#2` 开始。月份和维护比较均按 UTC 自然月执行。推荐行格式为：

```text
- [ ] owner/repo — TypeScript · ★126 <!-- starback-run:RUN_ID -->
```

Issue body 是用户可编辑状态：勾选表示请求 Star，取消勾选表示不再请求。HTML run marker 不参与渲染，只用于同一 workflow run 幂等。合法目标严格是一个 `owner/repo` 路径，比较和去重大小写不敏感。

每次 `watch: started` 最多生成 1 条推荐；每页最多保存 100 条生成推荐，容量跨多个事件累计。新增内容总是基于更新前重新读取的 body 追加，保留用户正文和其他 checkbox；Star 失败恢复也只改变对应目标的 checkbox。

## 排名规则

对过滤后的候选仓库计算：

```text
35 × log1p(stars) / log1p(maxStars)
+ 30 × clamp(1 - pushedAgeDays / 365, 0, 1)
+ 10 × log1p(forks) / log1p(maxForks)
+ 10 if description is non-empty
+ 10 if topics is non-empty
+  5 if homepage is non-empty
```

`maxStars` 或 `maxForks` 为 0 时对应项为 0。按总分降序后，依次按 Star 数降序、`pushed_at` 降序、`full_name` 升序稳定排序。

## API 约定、并发与失败行为

所有 REST 请求发送：

- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2026-03-10`
- 固定 `User-Agent: StarBack/0.1.0`

API 分页使用 `per_page=100`，按响应的 `Link` 关系继续读取。发现工作流以仓库级 `queue: max` 串行更新 Inbox；Star 工作流按 Issue 编号串行排队。GitHub 自己使用 `GITHUB_TOKEN` 更新 Issue 不会再次触发新的 workflow。

单个候选失败时记录失败并继续。发现链没有合格候选、或候选全部在当月出现过时成功退出并记录原因。Star 链在尽力处理并恢复失败 checkbox 后返回失败状态，让 workflow 明确失败；不会用兼容旧格式的隐藏兜底掩盖错误。

## 配置接口

两条入口都需要 `GITHUB_TOKEN`、`GITHUB_REPOSITORY` 和 `GITHUB_RUN_ID`；入口根据 `GITHUB_EVENT_NAME` 区分事件类型。`star.ts` 另外需要 `STARBACK_TOKEN`，仅在存在待处理的 checkbox 转换时读取。

工作流固定使用 Node 24、`actions/checkout@v7`、`actions/setup-node@v7`，不生成 `dist`，运行阶段不执行 `npm ci`。
