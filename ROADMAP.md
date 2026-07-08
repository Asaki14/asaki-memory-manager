# Asaki Memory Roadmap

目标：把当前可用 beta 打磨成稳定、可调试、低噪声的个人 agent memory layer。

## P0 — 先稳住质量

1. 建 search eval 集
   - 收集 30-50 条真实 query。
   - 每条标注 expected top results / bad results。
   - 扩展 `npm run eval:search`，避免靠单条 regression 调参。

2. 标定 score 阈值
   - 基于 eval 集观察 `score` 分布。
   - 分别给主动 search、auto-inject 设建议阈值。
   - 当前 auto-inject 默认：`ASAKI_MEMORY_AUTO_MIN_SCORE=0.50`。

3. 扩展 `score_details` 调试展示
   - Pi/MCP 搜索结果可选显示 `score_details`。
   - 保持默认简洁，debug 模式展开。

## P1 — 提升检索召回/排序

4. 加 D1 FTS5 / BM25
   - 对 `memories.content` 建全文索引。
   - search 召回来源改为 Vectorize + BM25 + current token/entity fallback。
   - 最终仍统一 rerank。

5. 改 rank fusion
   - 从手写加权公式升级到 reciprocal rank fusion 或 normalized rank fusion。
   - 保留 `semantic / keyword / entity / metadata` 明细。

6. 增强 entity extraction
   - 更好识别路径、env var、endpoint、package、repo、文件名。
   - 示例：`ASAKI_MEMORY_AUTO_INJECT`、`/v1/memories/search`、`src/services/memories.ts`。

## P2 — 提升写入质量

7. Structured memory extraction
   - 写入前用 LLM 抽取：subject / predicate / object / scope / kind / entities。
   - 保留当前 agent 侧提交，后端做轻量规范化。

8. 降低误 merge
   - 给 candidate dedupe 增加 eval 集。
   - 同关键词不同事实必须 add，不要 merge。
   - merge 前记录 `matched_memory` 和 reason，方便审计。

9. Review 工作流增强
   - review list 显示 potential duplicate / suggested action。
   - 支持批量 approve/ignore。

10. 云端抽取降级为校准工具（shadow-run）
    - 现状：agent 主动 `asaki_memory_add` 为主，Stop hook 云端 raw-text extract
      (`ASAKI_MEMORY_AUTO_EXTRACT`) 只做被动兜底（信号词门槛 + 敏感词门槛 + 节流），
      这一层维持不动。
    - 待办：加一个 shadow-run 校准脚本，定期（比如改 extraction prompt 后，或按周）
      拿最近一段 transcript 跑一遍抽取 pipeline，但不真写入——把云端候选跟 agent
      同期实际 `add` 的记忆做 diff，差异大的进 review 队列或出报告，而不是自动写库。
    - 目的：把云端 LLM 从"生产写手"降级成"事后阅卷"，攒够校准数据后再评估要不要把
      `ASAKI_MEMORY_AUTO_EXTRACT` 默认关掉。

## P3 — 长期维护能力

11. 记忆压缩与冲突治理
    - 同一主题多条旧记忆可归并成 summary。
    - 冲突记忆不直接覆盖，标记 conflict。

12. 生命周期策略
    - 支持 stale / archived 建议。
    - 低 confidence 或长期未命中的记忆降权。

13. 观测与回放
    - 记录 search query、返回 IDs、score_details、是否注入。
    - 支持离线 replay，用真实日志跑新 scoring。

## 当前不要做

- 不要直接上复杂 LLM rerank，成本和延迟先不值得。
- 不要让 pre-agent 自动无条件注入记忆。
- 不要把 importance/confidence 当检索相关性主信号。
- 不要为了单条误召继续手调 magic number；先补 eval 集。
