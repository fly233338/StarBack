# StarBack 架构基线

## 目标与边界

StarBack 是一个可复用的 GitHub 原生引擎。它运行在调用方个人 GitHub 仓库的 Actions 中，只使用 GitHub Actions、Issues 和 GitHub REST API，不使用服务器、数据库、外部队列或编译后的运行产物。

v0.1 只支持个人账号拥有的调用方仓库，不支持组织仓库、多人代表组织执行 Star、自动取消 Star 或永久推荐去重。StarBack 源码仓库同时是引擎发布仓库和第一个 dogfood 调用方。

引擎运行时使用 Node 24 原生 TypeScript。调用方负责事件、权限和 Secret；reusable workflow 负责取得精确引擎源码并运行入口；TypeScript 负责事件验证、GitHub API、排名、Inbox 和 Star 逻辑。

## 三层组件边界

```text
调用方仓库 workflow
    | 事件、github.repository、github.token、权限、STARBACK_TOKEN
    |  all callers: fly233338/StarBack/.github/workflows/reusable-*.yml@main
    v
reusable workflow
    |  job.workflow_repository + job.workflow_sha
    |  checkout 引擎到 .starback
    v
StarBack TypeScript 引擎
    |  node .starback/scripts/discover.ts
    |  node .starback/scripts/star.ts
    v
调用方仓库的 GitHub API 资源
```

### 引擎来源与运行上下文

- 引擎代码来源由 reusable workflow 内的 `job.workflow_repository` 和 `job.workflow_sha` 确定。checkout 使用这两个值并放入 `.starback`，不会默认 checkout 调用方仓库。
- 运行上下文始终属于调用方：事件 JSON、`GITHUB_REPOSITORY`、`GITHUB_RUN_ID`、`GITHUB_EVENT_NAME`、默认环境变量和 `github.token` 都指向触发调用方 workflow 的仓库。
- 用户身份属于调用方：只有 Star reusable workflow 接收调用方显式传入的 `STARBACK_TOKEN`，并且只用于用户级 Starring API。
- StarBack 自身与外部调用方都使用公开的 `fly233338/StarBack/.github/workflows/reusable-*.yml@main`；如需可复现执行，可将 caller 引用替换为已验证的 commit SHA。

GitHub.com 提供 `job.workflow_repository` 和 `job.workflow_sha`；v0.1 不支持 GitHub Enterprise Server。

## 仓库内文件与公共接口

```text
.github/workflows/
  reusable-discover.yml       # workflow_call，无 inputs、无用户 Secret
  reusable-star.yml           # workflow_call，必需 STARBACK_TOKEN
  starback-discover.yml       # StarBack 自用 watch/schedule caller
  starback-star.yml           # StarBack 自用 issues caller
scripts/
  discover.ts                 # 被 reusable discover 运行
  star.ts                     # 被 reusable star 运行
src/                          # 纯逻辑与 GitHub REST 客户端
test/                         # Node 内置 test runner + fetch mock
```

Reusable workflow 的公共接口只有 `workflow_call`：

- `reusable-discover.yml` 无 inputs、无用户 Secret，使用调用方 `github.token`。
- `reusable-star.yml` 声明必需的 `workflow_call.secrets.STARBACK_TOKEN`，不使用 `secrets: inherit`。
- Caller 授予 `contents: read`、`issues: write`；called workflow 只能维持或降低调用方权限，不能提升权限。

## 事件链

### Watch 发现链

1. 调用方的 `watch: [started]` 触发 discover caller；StarBack 自用 caller 还在每月 1 日 `00:17 UTC` 触发 schedule。
2. Caller 授予 `contents: read` 和 `issues: write`，并调用公开的 `reusable-discover.yml@main`。
3. Reusable job 按调用方仓库建立 `queue: max` concurrency，使用 Node 24 checkout 精确引擎源码到 `.starback`，然后运行 `node .starback/scripts/discover.ts`。
4. `discover.ts` 验证事件 action、仓库归属和事件仓库与调用方 `GITHUB_REPOSITORY` 一致；仅接受个人账号仓库。
5. 确保 `starback-inbox` 标签存在。缺失时创建颜色 `0969da`、描述 `Managed by StarBack` 的标签，并关闭标题合法、带此标签且月份早于当前 UTC 月份的开放 Inbox。
6. 分页读取 stargazer 自己拥有的公开仓库，按确定性评分排序，排除当月已经出现的目标。
7. 每次 watch 事件只将去重后排名最高的 1 条推荐追加到当月最后一页；当前页满时创建下一页。每页最多保存 100 条，容量跨多个 watch 事件累计。
8. 推荐行带本次 `GITHUB_RUN_ID` 标记；已有相同标记的本次运行直接成功退出。

### Schedule 维护链

Schedule 只执行过期 Inbox 维护，不读取 stargazer，不写入推荐。外部 caller 可按同样方式自行提供 schedule；StarBack 自用 caller 必须保留月度 schedule。

### Checkbox Star 链

1. 调用方的 `issues: [edited]` 触发 star caller。Caller 条件检查个人仓库、事件 `sender` 是仓库 owner、Issue 非 Pull Request 和 `starback-inbox` 标签，然后只显式传递 `secrets.STARBACK_TOKEN`。Inbox 可以由 `github-actions[bot]` 创建，Issue 作者不是授权依据。
2. Reusable job 按调用方仓库和 Issue 编号建立 `queue: max` concurrency，checkout 精确引擎源码到 `.starback`，运行 `node .starback/scripts/star.ts`。
3. `star.ts` 再次验证事件 sender 是调用方仓库 owner、事件仓库匹配、Issue 非 Pull Request、标签和 body 变化；只处理旧 body 中 `[ ]` 严格变为新 body 中 `[x]` 的合法 `owner/repo` 行。
4. 使用调用方 `GITHUB_TOKEN` 重新读取 Issue。目标已取消勾选时跳过，尊重用户最新编辑。
5. 对每个仍勾选的目标确认公开可访问；使用 `STARBACK_TOKEN` 查询当前用户是否已 Star。已 Star 则幂等跳过，未 Star 则以 `PUT /user/starred/{owner}/{repo}` 完成 Star，并要求 `204`。
6. 多个目标逐项处理。失效目标、缺少 PAT 或 API 失败不会阻断其他目标；处理后重新读取最新 body，只将失败目标恢复为 `[ ]`，最后以聚合错误结束，不发布评论。

## Token 信任边界

- 调用方的 `GITHUB_TOKEN` 只用于读取调用方仓库、用户公开仓库、Issue 和目标仓库，以及创建/更新/关闭调用方 Inbox 和标签。
- `STARBACK_TOKEN` 是调用方仓库 owner 提供的 fine-grained PAT，只由 Star caller 显式传给 reusable star，并仅用于代表 owner 查询其 Star 状态和调用用户级 Star API。它不用于 Issue 写入，也不进入无关事件的 job。
- Caller 层的 sender、个人仓库、标签和 Pull Request 条件是减少 PAT 暴露面的第一道边界；脚本层重复验证，不能仅依赖 caller 条件。
- Reusable workflow 不使用 `secrets: inherit`，也不从引擎仓库读取用户 Secret。

## Inbox 数据格式与状态

Inbox 始终创建在当前调用方仓库，而不是 StarBack 引擎仓库。标题只接受以下格式：

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

对候选仓库计算：

```text
35 × log1p(stars) / log1p(maxStars)
+ 30 × clamp(1 - pushedAgeDays / 365, 0, 1)
+ 10 × log1p(forks) / log1p(maxForks)
+ 10 if description is non-empty
+ 10 if topics is non-empty
+  5 if homepage is non-empty
```

`maxStars` 或 `maxForks` 为 0 时对应项为 0。候选仍过滤 fork、archived、disabled 和没有 `pushed_at` 的仓库；Star、活跃时间、Fork 和元数据权重保持不变。按总分降序后，依次按 Star 数降序、`pushed_at` 降序、`full_name` 升序稳定排序。

## API、权限与并发

所有 REST 请求发送：

- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2026-03-10`
- 固定 `User-Agent: StarBack/0.1.0`

API 分页使用 `per_page=100`，按响应的 `Link` 关系继续读取。Discover reusable workflow 以调用方仓库为 concurrency group；Star reusable workflow 以调用方仓库和 Issue 编号为 concurrency group；两者均使用 `queue: max` 串行更新调用方 Inbox。GitHub 使用调用方 `GITHUB_TOKEN` 更新 Issue 不会递归触发新的 workflow。

单个候选失败时记录失败并继续。发现链没有合格候选、或候选全部在当月出现过时成功退出并记录原因。Star 链在尽力处理并恢复失败 checkbox 后返回失败状态，让调用方 workflow 明确失败；不会用兼容旧格式的隐藏兜底掩盖错误。

## 版本与发布

Caller 默认引用公开 StarBack 仓库的 `main` 分支，例如 `fly233338/StarBack/.github/workflows/reusable-discover.yml@main`。`main` 是滚动版本；如需固定引擎版本，应改用已验证的 commit SHA。本次不创建 tag 或 Release。
