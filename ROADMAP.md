# Asaki Memory Roadmap

目标：把当前可用 beta 打磨成稳定、可调试、低噪声的**个人/小团队自托管** agent memory layer。规模假设：单用户几百到几千条记忆，不是多租户 SaaS——这决定了下面哪些投入划算。

## 已完成基线（勿重复投入，需要改动时再展开）

- Search eval 集：`eval/search-cases.json`（51 条），`npm run eval:search` 会给出 `search_min_score`/`auto_inject_min_score` 建议值。
- Candidate dedupe eval：`test/fixtures/candidate-decisions.json`，`npm run eval:candidates`。
- Extraction guardrail eval：`npm run eval:extraction` / `eval:extraction-guardrails`。
- 启动时高优先级记忆自动注入，默认开启，无需手动配置。
- 候选决策已优化，避免不必要的 LLM 调用。
- auto-inject score 阈值三处默认值 + 文档统一为 eval 建议的 `0.67`。
- `POST /v1/memories/search` 支持可选 `min_score` 过滤；`asaki_memory_search`（Pi/MCP）支持可选 `debug` 参数展示 `score_details`。
- entity 匹配识别裸相对路径（如 `src/services/memories.ts`），不再依赖前导 `/` 或连字符。

## 下一步（按顺序）

1. ~~云端抽取降级为 shadow-run 校准工具~~ — 已完成
   - `scripts/shadow-run-extraction.ts`（`npm run shadow-run:extraction -- <transcript.jsonl> --user <id> --project <id>`）：读取 Claude Code transcript，调 `/v1/memories/extract`（新增 `dry_run` 参数，见 `src/index.ts`）拿云端候选但不写库，再跟同窗口内 agent 直接 `asaki_memory_add` 的记忆做 `lexicalSimilarity` diff，只读输出 covered/gap 报告；`--create-reviews` 可选择把 gap 候选推进 review 队列（默认不推，只报告）。
   - 已用本地 `wrangler dev` 验证：dry_run 不写库、直接 add 的记忆能被正确识别为窗口内的 direct add；diff 算法单独验证过 covered/gap 判定正确。
   - 待办（用起来之后才知道）：先手动跑几次攒数据，看 gap 量级，再决定要不要默认关闭 `ASAKI_MEMORY_AUTO_EXTRACT`。

2. ~~观测补字段~~ — 部分完成
   - `search` 事件（`src/services/memories.ts:223-233`）现在记录 `query`/`top_k`/`min_score`/`result_count`/`result_ids`/`score_details`。本地 `wrangler dev` + 直接查 D1 `memory_events` 表验证过字段真落地。
   - 未做："是否被 auto-inject 采用"——这个判断发生在客户端（Pi/hook 收到 search 结果后自己按 autoMinScore 过滤），服务端 search 事件那一刻并不知道。要记这个得让客户端回调一次，不是"加字段"这么便宜了，先不做，等真需要复盘 auto-inject 效果再评估。

3. Review 工作流增强（不急，等队列真的堆积再做）
   - 现状：`src/services/reviews.ts` 的 `resolveMemoryReview` 只支持单条 resolve；`listMemoryReviews` 不返回 potential duplicate / suggested action。
   - 待办：review list 复用已有的 `bestUsableMatch`/`findLexicalMatch` 数据展示潜在重复项和建议动作；支持批量 approve/ignore。

## 持续维护（非新投入，靠 eval 驱动）

- 降低误 merge：`npm run eval:candidates` 已覆盖同关键词不同事实的 add/merge 判断。发现新误判案例时补 `test/fixtures/candidate-decisions.json`，不手调 magic number。
- entity 规则余量：还没覆盖 npm 包名（`@scope/pkg`）、纯数字版本号等形态，等实际误召再补。

## 需要证据再做（不预先投入）

- 记忆压缩与冲突治理：同一主题多条旧记忆归并成 summary、冲突记忆标记 conflict——个人规模下人工偶尔清理成本远低于建自动治理机制的成本，先攒观测数据看是否真有堆积。
- 生命周期策略（stale/archived 建议、按命中率降权）：同理，无证据不投入。

## 已评估并砍掉（不做）

- **D1 FTS5 / BM25 全文索引**：当前 keyword score（token recall + jaccard）配合 entity match 已 51/51 eval 通过、margin 健康。BM25 的价值在语料量大时才明显，个人规模用不上，只会换来迁移和混合召回的复杂度。
- **Rank fusion（RRF）升级**：手写加权公式已调好，且刚为 `score_details` 投入了调试展示（见上）。RRF 是纯排名法，会丢弃绝对分数、削弱刚建的可调试性，不是"更先进"就该换。
- **Structured memory extraction（subject/predicate/object）**：与既定方向相反——项目正把云端 LLM 从"生产写手"降级为"事后阅卷"（见下一步 1），这条却是给云端 LLM 加更多结构化写权限。agent 侧已经自己蒸馏内容再提交，没必要在后端再加一层结构化。
- **离线 replay 系统**：给多租户产品用的重投入，个人工具规模用不上；观测的廉价部分（字段级）已经够用，见"下一步 2"。

## 当前不要做

- 不要直接上复杂 LLM rerank，成本和延迟先不值得。
- 不要让 pre-agent 自动无条件注入记忆。
- 不要把 importance/confidence 当检索相关性主信号。
- 不要为了单条误召继续手调 magic number；先补 eval 集。
- 不要把 eval 脚本给出的建议阈值直接照抄上线；改前先过一遍近期真实 query 抽查有无回归。
- 不要为个人规模的工具引入多租户 SaaS 级基础设施（全文索引引擎、rank fusion、结构化抽取管线、离线 replay）；先看有没有证据再投入。
