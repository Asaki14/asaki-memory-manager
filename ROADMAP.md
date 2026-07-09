# Asaki Memory Roadmap

目标：把当前可用 beta 打磨成稳定、可调试、低噪声的**个人自托管** agent memory layer。定位专精个人记忆系统，不为团队/多用户场景服务。规模假设：单用户几百到几千条记忆，不是多租户 SaaS——这决定了下面哪些投入划算。

## 已完成基线（勿重复投入，需要改动时再展开）

- Search eval 集：`eval/search-cases.json`（51 条），`npm run eval:search` 会给出 `search_min_score`/`auto_inject_min_score` 建议值。
- Candidate dedupe eval：`test/fixtures/candidate-decisions.json`，`npm run eval:candidates`。
- Extraction guardrail eval：`npm run eval:extraction` / `eval:extraction-guardrails`。
- 启动时高优先级记忆自动注入，默认开启，无需手动配置。
- 候选决策已优化，避免不必要的 LLM 调用。
- auto-inject score 阈值三处默认值 + 文档统一为 eval 建议的 `0.67`。
- `POST /v1/memories/search` 支持可选 `min_score` 过滤；`asaki_memory_search`（Pi/MCP）支持可选 `debug` 参数展示 `score_details`。
- entity 匹配识别裸相对路径（如 `src/services/memories.ts`），不再依赖前导 `/` 或连字符。

## 下一步（按优先级，代码审查发现的真缺陷/清理项，非猜测）

1. 控制注入记忆的上下文负担与注意力噪音
   - 背景：长记忆存库本身不占当前 context，但 startup top memories、auto-inject/search 命中后会进入上下文；长条目会增加 token 成本，也会把旧实现细节/过程日志带进模型注意力。
   - 方向：对 startup/search 输出增加单条字符上限或摘要化格式，优先保留稳定结论、scope/kind/importance/id，避免整段长因果链直接注入。
   - `/memory` 审计增加“过长记忆”检查：例如 >300 中文字符建议压缩、拆分或改成指向文档路径；一条只保留一个稳定结论。
   - 调整 classifier/agent 写入约束：preference/rule 目标 40-160 字，decision/workflow/bug_fix 目标 1-2 句、最多约 200-300 字。
   - 验证：改输出截断/格式后跑 `npm run typecheck`，并用真实长记忆手动检查 Pi startup 隐藏注入与 `asaki_memory_search` 输出不会淹没其他上下文。


1. ~~`expires_at` 字段没有被任何查询读取~~ — 已完成（选方向 b：删掉）
   - 生产 D1 核实过 `expires_at IS NOT NULL` 行数为 0（402 条记忆全没设过），装饰性死字段，直接删。
   - `migrations/0004_drop_expires_at.sql`：`ALTER TABLE memories DROP COLUMN expires_at`（`0001_init.sql` 保留原样不改历史迁移）。`src/types.ts`（`MemoryRow`/`CreateMemoryInput`/`UpdateMemoryInput`）、`src/services/candidateDecision.ts`、`src/utils/validation.ts`、`src/services/memories.ts` 的读写路径、`scripts/eval-*.ts` 里的 fixture 一并清掉。
   - 本地 `db:migrate:local` 跑过，`PRAGMA table_info(memories)` 确认列已删；`npm run smoke:management` 全绿。

2. ~~`projects` / `memory_sources` / `api_keys` 三张死表~~ — 已完成
   - `migrations/0003_drop_unused_tables.sql`：`DROP TABLE IF EXISTS` 三张表（这三张表本身没有专属索引需要清理）。本地 `db:migrate:local` 跑过，`sqlite_master` 确认三表已删、`memories`/`memory_events`/`memory_reviews` 还在；本地 `wrangler dev` 跑过一遍 create/delete 回归，行为不受影响。
   - 已推到远程：`npm run db:migrate:remote` 跑过，生产 D1 `sqlite_master` 确认三表已删。

3. ~~README "team agents" 措辞跟实际鉴权模型不符~~ — 已解决（改定位而不是改措辞）
   - 项目定位已明确改为个人单用户工具，不再服务团队/多用户场景，`README.md`/`AGENTS.md`/`package.json` 的描述已同步去掉"team"相关措辞。鉴权模型（单一共享 `ADMIN_API_KEY`）跟"个人单用户"定位天然一致，不再需要解释信任边界给团队用户。

## 近期完成（已验证落地）

1. ~~云端抽取降级为 shadow-run 校准工具~~ — 已完成
   - `scripts/shadow-run-extraction.ts`（`npm run shadow-run:extraction -- <transcript.jsonl> --user <id> --project <id>`）：读取 Claude Code transcript，调 `/v1/memories/extract`（新增 `dry_run` 参数，见 `src/index.ts`）拿云端候选但不写库，再跟同窗口内 agent 直接 `asaki_memory_add` 的记忆做 `lexicalSimilarity` diff，只读输出 covered/gap 报告；`--create-reviews` 可选择把 gap 候选推进 review 队列（默认不推，只报告）。
   - 已用本地 `wrangler dev` 验证：dry_run 不写库、直接 add 的记忆能被正确识别为窗口内的 direct add；diff 算法单独验证过 covered/gap 判定正确。
   - 待办的"跑几次攒数据再决定"从没被执行，`ASAKI_MEMORY_AUTO_EXTRACT` 一直开着，实际统计显示云端 auto-extract 已经变成主要记忆来源（163 条 vs. 本地 Agent 直接 `asaki_memory_add` 27 小时无调用），跟"云端是事后审计、本地 Agent 是主要写手"的设计意图相反。已决定：`ASAKI_MEMORY_AUTO_EXTRACT` 默认关闭（`~/.claude/settings.json` 和 `~/.pi/agent/asaki-memory.json` 均已改为 off），`session-start.sh` 和 Pi 的 `asaki_memory_add` 提示语气从"decide yourself"改为"你是主要写手，不写就没有记录"。`shadow-run-extraction.ts` 保留作为周期性手动审计工具，不再是默认自动通路。

2. ~~观测补字段~~ — 部分完成
   - `search` 事件（`src/services/memories.ts:223-233`）现在记录 `query`/`top_k`/`min_score`/`result_count`/`result_ids`/`score_details`。本地 `wrangler dev` + 直接查 D1 `memory_events` 表验证过字段真落地。
   - 未做："是否被 auto-inject 采用"——这个判断发生在客户端（Pi/hook 收到 search 结果后自己按 autoMinScore 过滤），服务端 search 事件那一刻并不知道。要记这个得让客户端回调一次，不是"加字段"这么便宜了，先不做，等真需要复盘 auto-inject 效果再评估。

3. ~~Review 工作流增强~~ — 已完成（范围收窄）
   - `POST /v1/memories/reviews/list` 新增可选 `include_suggestions`：为每条 pending review 复用 `findBestMatch`（原 `findActiveDuplicate` 拆出的共享逻辑）算一次 `potential_duplicate: { memory_id, content, action, reason }`，默认关闭不影响现有调用方。Pi/MCP 的 `asaki_memory_review_list` 同步暴露该参数并在输出行里展示。本地 `wrangler dev` 验证过：造一条跟已有记忆高度相似的候选，`include_suggestions=true` 时能正确带出 `potential_duplicate`；不传时字段不出现，行为不变。
   - **没做批量 approve/ignore，主动砍掉**：这个项目里 review 的实际消费者是 agent（`/memory` 审计工作流），不是人工点 UI 复选框——agent 已经能在同一轮里对 `asaki_memory_review_resolve` 循环调用 N 次来达到"批量"效果，专门加一个 batch 端点是给不存在的 UI 交互模式建基础设施，跟"个人规模工具、不要造需求外的灵活性"的调性不符。

5. ~~生命周期策略：长期未调用记忆自动清理~~ — 已完成（用户明确要求，覆盖此前"无证据不投入"的判断）
   - 新增 `POST /v1/memories/prune-stale`（`pruneStaleMemories()`，`src/services/memories.ts`；`deleteMemory()` 顺手抽出共享的 `softDeleteMemory()` 避免重复）：按 `COALESCE(last_accessed_at, created_at)` 早于 `days`（默认 90，可配 1–3650）判定 stale，软删除（`status='deleted'` + Vectorize `deleteByIds`，跟 `DELETE /v1/memories/:id` 同一套机制，可从 `memory_events` 的 `prune_stale` 事件审计、可手动改回 `active` 恢复），不做物理硬删除。`limit` 默认 100（上限 500），`apply` 默认 `false`（dry-run，只报候选不动数据）。
   - `scripts/prune-stale.ts`（`npm run prune:stale -- [--days 90] [--limit 100] [--apply] [--max-rounds 20]`）：默认 dry-run 打印候选（kind/importance/last_accessed_at/内容预览），确认后加 `--apply` 才真删；`--apply` 时分轮跑到队列清空。
   - 手动触发，不做 cron——沿用项目"个人规模不需要常驻机制"的一贯方向。
   - 本地 `wrangler dev` 端到端验证过：造一条 `created_at` 回填到一年前、从未被访问的记忆，dry-run 正确列出候选且不改数据；`--apply` 后 `status` 变 `deleted`、`memory_events` 落 `prune_stale` 事件且 payload 字段正确；再跑 dry-run 该记忆不再出现（已排除非 active）。

4. ~~Vectorize 索引失败无重试/backfill~~ — 已完成
   - 新增 `POST /v1/memories/backfill-index`（`src/services/memories.ts` 的 `backfillPendingIndex()`，`upsertVector()` 同步导出复用）：查 `index_status IN ('pending','failed')` 的 active 记忆（默认 limit 50，上限 500），逐条重新生成 embedding + upsert，成功则落 `index_status='indexed'`，返回 `{ checked, indexed, remaining, remaining_ids }`。
   - `scripts/backfill-index.ts`（`npm run backfill:index -- [--limit n] [--max-rounds n]`）：跟 `shadow-run-extraction.ts` 一样走 HTTP 打已部署的 Worker（脚本本身摸不到 D1/Vectorize/AI binding），循环调用直到队列清空或到 `--max-rounds`。
   - 本地 `wrangler dev` 验证过：endpoint 正确捞出 pending 记忆、脚本正确分轮调用并汇总 checked/indexed 计数、`remaining_ids` 透传正确；受限于本地 dev 没有真实 Workers AI 凭证，`indexed` 计数在本地恒为 0（预期内——生产上跑 `npm run backfill:index` 才会真的重新生成 embedding），逻辑本身（查询条件、状态回写、分页）已核实无误。
   - 仍是手动触发，不做 cron/自动重试——跟 roadmap 既定方向一致。

## 持续维护（非新投入，靠 eval 驱动）

- 降低误 merge：`npm run eval:candidates` 已覆盖同关键词不同事实的 add/merge 判断。发现新误判案例时补 `test/fixtures/candidate-decisions.json`，不手调 magic number。
- entity 规则余量：还没覆盖 npm 包名（`@scope/pkg`）、纯数字版本号等形态，等实际误召再补。
- 小味道，顺手改：`src/services/memories.ts` 的 `vectorSearch()` 里 `Math.max(input.top_k * 3, input.top_k)` 数学上恒等于 `input.top_k * 3`（`top_k` 已校验 ≥1），`Math.max` 纯多余。不值得单独开 PR，下次改这块顺手带一下。

## 需要证据再做（不预先投入）

- 记忆压缩与冲突治理：同一主题多条旧记忆归并成 summary、冲突记忆标记 conflict——个人规模下人工偶尔清理成本远低于建自动治理机制的成本，先攒观测数据看是否真有堆积。
- 按命中率降权（非删除的 stale 建议）：仍无证据不投入，跟"生命周期策略"里已实现的硬删除是两回事。
- 服务端限流：当前只有单一共享 `ADMIN_API_KEY`，没有速率限制——key 一旦泄露就是无限 AI 调用成本敞口。个人规模下 key 只在自己机器/CI 用，没发生过滥用，先不投入；真出现异常调用量再加（Cloudflare 自带的 Workers Rate Limiting 绑定，不用自己写）。
- 单元测试框架：目前只有 eval 回归（`eval:candidates`/`eval:search`/`eval:extraction`/`eval:extraction-guardrails`）+ smoke 脚本，`validation.ts` 每个函数的错误分支没有系统性覆盖。项目已经明确选了"eval 驱动"而不是传统单测——不无证据引入新测试框架；`validation.ts` 或别处真出一个具体 bug 时，优先补一条对应的 eval/guardrail case，而不是补一整套单测基础设施。

## 已评估并砍掉（不做）

- **D1 FTS5 / BM25 全文索引**：当前 keyword score（token recall + jaccard）配合 entity match 已 51/51 eval 通过、margin 健康。BM25 的价值在语料量大时才明显，个人规模用不上，只会换来迁移和混合召回的复杂度。
- **Rank fusion（RRF）升级**：手写加权公式已调好，且刚为 `score_details` 投入了调试展示（见上）。RRF 是纯排名法，会丢弃绝对分数、削弱刚建的可调试性，不是"更先进"就该换。
- **Structured memory extraction（subject/predicate/object）**：与既定方向相反——项目正把云端 LLM 从"生产写手"降级为"事后阅卷"（见"近期完成"第 1 项），这条却是给云端 LLM 加更多结构化写权限。agent 侧已经自己蒸馏内容再提交，没必要在后端再加一层结构化。
- **离线 replay 系统**：给多租户产品用的重投入，个人工具规模用不上；观测的廉价部分（字段级）已经够用，见"近期完成"第 2 项。

## 当前不要做

- 不要直接上复杂 LLM rerank，成本和延迟先不值得。
- 不要让 pre-agent 自动无条件注入记忆。
- 不要把 importance/confidence 当检索相关性主信号。
- 不要为了单条误召继续手调 magic number；先补 eval 集。
- 不要把 eval 脚本给出的建议阈值直接照抄上线；改前先过一遍近期真实 query 抽查有无回归。
- 不要为个人规模的工具引入多租户 SaaS 级基础设施（全文索引引擎、rank fusion、结构化抽取管线、离线 replay）；先看有没有证据再投入。
