# Asaki Memory Roadmap

目标：把当前可用 beta 打磨成稳定、可调试、低噪声的个人 agent memory layer。

## 已完成基线（勿重复投入，需要改动时再展开）

- Search eval 集：`eval/search-cases.json`（50 条），`npm run eval:search` 会给出 `search_min_score`/`auto_inject_min_score` 建议值。
- Candidate dedupe eval：`test/fixtures/candidate-decisions.json`，`npm run eval:candidates`。
- Extraction guardrail eval：`npm run eval:extraction` / `eval:extraction-guardrails`。
- 启动时高优先级记忆自动注入，默认开启，无需手动配置。
- 候选决策已优化，避免不必要的 LLM 调用。

## P0 — 先修一致性问题，再谈新功能

1. ~~统一 auto-inject 的 score 阈值 + search 接口加 min_score~~ — 已完成
   - 三处默认值（`integrations/pi/asaki-memory.ts`、`integrations/claude-code/user-prompt.sh`、`.env.example`）及 `README.md`/`AGENTS.md`/`integrations/claude-code/README.md` 文档已统一为 `npm run eval:search` 建议的 `auto_inject_min_score=0.67`。
   - `POST /v1/memories/search`（`src/services/memories.ts`）新增可选 `min_score`（0-1），过滤发生在 merge 之后、`last_accessed_at` 更新之前，避免给被过滤掉的记忆刷访问时间；`min_score` 也记进 `search` 事件 payload。客户端（Pi/MCP 工具）暂未暴露该参数，先留作后端能力。

2. ~~`score_details` 调试展示~~ — 已完成
   - `asaki_memory_search`（Pi `integrations/pi/asaki-memory.ts` 和 MCP `integrations/mcp/asaki-memory.ts`）新增可选 `debug` 参数，开启后每条结果附加 `[semantic=.. keyword=.. entity=.. metadata=.. source=..]`，默认关闭保持简洁。

## P1 — 提升检索召回/排序

3. D1 FTS5 / BM25（未做）
   - 对 `memories.content` 建全文索引，search 召回来源改为 Vectorize + BM25 + current token/entity fallback，最终统一 rerank。

4. Rank fusion 升级（未做）
   - 从 `searchScoring.ts` 手写加权公式升级到 reciprocal rank fusion 或 normalized rank fusion，保留 `semantic/keyword/entity/metadata` 明细供调试。

5. 增强 entity extraction（部分完成）
   - 现状：`searchScoring.ts` 的 `entityTokens()` 已能识别 env var（`UPPER_CASE`）、带前导 `/` 的路径（如 `/v1/memories/search`）、连字符/下划线复合词。
   - 缺口：裸相对路径（如 `src/services/memories.ts`，无前导 `/`、无连字符）识别不到。待办：补这类模式，并把新案例加进 `eval/search-cases.json`。

## P2 — 提升写入质量

6. Structured memory extraction（未做）
   - 写入前用 LLM 抽取 subject/predicate/object/scope/kind/entities，保留当前 agent 侧提交，后端做轻量规范化。

7. 降低误 merge（eval 基座已有，持续维护）
   - `npm run eval:candidates` 已覆盖同关键词不同事实的 add/merge 判断。发现新误判案例时补 `test/fixtures/candidate-decisions.json`，而不是手调 magic number。

8. Review 工作流增强（未做）
   - 现状：`src/services/reviews.ts` 的 `resolveMemoryReview` 只支持单条 resolve；`listMemoryReviews` 不返回 potential duplicate / suggested action。
   - 待办：review list 展示潜在重复项和建议动作；支持批量 approve/ignore。

9. 云端抽取降级为 shadow-run 校准工具（已规划，未实现）
   - 规划见上次 commit（docs）：定期拿最近 transcript 跑一遍抽取 pipeline 但不写库，把云端候选跟 agent 同期实际 `add` 的记忆做 diff，差异大的进 review 队列或出报告。
   - 待办：把规划落成脚本（`scripts/` 下新增），先跑起来攒校准数据，再评估是否默认关闭 `ASAKI_MEMORY_AUTO_EXTRACT`。

## P3 — 长期维护能力

10. 记忆压缩与冲突治理（未做）
    - 同一主题多条旧记忆归并成 summary；冲突记忆不直接覆盖，标记 conflict。

11. 生命周期策略（未做）
    - 支持 stale/archived 建议；低 confidence 或长期未命中的记忆降权。

12. 观测与回放（部分完成）
    - 现状：`memories.ts` 的 `search` 事件已记录 `query`/`top_k`/`result_count`（`src/services/memories.ts:222-226`）。
    - 缺口：没有记录 returned IDs、`score_details`、是否被 auto-inject 采用；没有离线 replay 能力。

## 当前不要做

- 不要直接上复杂 LLM rerank，成本和延迟先不值得。
- 不要让 pre-agent 自动无条件注入记忆。
- 不要把 importance/confidence 当检索相关性主信号。
- 不要为了单条误召继续手调 magic number；先补 eval 集。
- 不要把 eval 脚本给出的建议阈值直接照抄上线；改前先过一遍近期真实 query 抽查有无回归。
