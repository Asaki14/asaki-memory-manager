<div align="center">
  <img src="https://raw.githubusercontent.com/Asaki14/asaki-memory-manager/main/assets/logo.svg" width="120" alt="Asaki Memory Manager 标志" />
  <h1>Asaki Memory Manager</h1>
  <p><b>基于 Cloudflare 的 AI Agent 长期记忆层</b></p>
  <p><a href="README.md">English</a> · 中文</p>
  <a href="https://github.com/Asaki14/asaki-memory-manager/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Asaki14/asaki-memory-manager/ci.yml?branch=main&style=flat-square&label=tests" alt="Tests"></a>
  <a href="https://github.com/Asaki14/asaki-memory-manager/stargazers"><img src="https://img.shields.io/github/stars/Asaki14/asaki-memory-manager?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Asaki14/asaki-memory-manager/tags"><img src="https://img.shields.io/github/v/tag/Asaki14/asaki-memory-manager?sort=semver&label=version&style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
</div>

## 功能

| 功能 | 适用场景 | 说明 |
|---|---|---|
| 分范围记忆 | 保存偏好、决策或项目知识 | 区分全局、项目和会话记忆。 |
| 混合检索 | 找回相关记忆 | 结合语义搜索与 D1 词法回退。 |
| 人工审核队列 | 后台分类器捕获候选 | 未监督候选进入队列，需明确审核。 |
| 会话上下文 | Agent 开始或恢复会话 | 注入有上限的常驻规则和项目上下文。 |
| 生命周期管理 | 检查或清理记忆 | 记录规则复现情况、提示检查长期未使用的规则，并支持过期记忆清理。 |
| Cloudflare 原生运行 | 自行托管服务 | 使用 Workers、D1、Vectorize 和 Workers AI。 |

## 安装

需要 Node.js 22+、Cloudflare 账号，以及 Workers、D1、Vectorize、Workers AI 服务。详细资源说明见[配置指南](docs/configuration.md)。

```sh
npm ci
npx wrangler login
npx wrangler d1 create asaki-memory-manager
npx wrangler vectorize create asaki-memory-manager --dimensions 1024 --metric cosine
for p in user_id scope project_id session_id kind; do
  npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName "$p" --type string
done
cp wrangler.example.jsonc wrangler.jsonc
# 在 wrangler.jsonc 中填写 D1 database_id。
npm run db:migrate:remote
npx wrangler secret put ADMIN_API_KEY
npm run deploy
```

部署后，在客户端配置 `ASAKI_MEMORY_BASE_URL`、`ASAKI_MEMORY_API_KEY` 和 `ASAKI_MEMORY_USER_ID`。详见[集成说明](#集成)。

## 集成

- **Claude Code：** 插件包含本地 hooks，并通过 Worker 使用远程 MCP。安装方式见 [`integrations/claude-code/README.md`](integrations/claude-code/README.md)。
- **Pi：** 可选扩展，入口为 [`integrations/pi/asaki-memory.ts`](integrations/pi/asaki-memory.ts)。
- **Codex：** 提供 hooks 集成和 stdio MCP 服务，配置见 [`integrations/codex/README.md`](integrations/codex/README.md)。
- 仓库还包含本地 MCP 集成，位于 `integrations/mcp/`。

## 为什么选择

大多数 Agent 记忆方案需要单独维护数据库和记忆服务。本项目将 API 和数据存储留在 Cloudflare 账号中：D1 是事实来源，Vectorize 是可重建的语义索引，Workers AI 提供向量嵌入和候选决策。项目面向单个操作者，不是多租户或团队产品。

## 参考文档

- [API 参考](docs/api.md)
- [配置指南](docs/configuration.md)
- [架构说明](docs/architecture.md)
- [安全说明](docs/security.md)
- [路线图](ROADMAP.md)

## 卸载

按对应集成文档移除插件、扩展或 hooks。若停止服务，请从 Cloudflare 账号删除 Worker、D1 数据库、Vectorize 索引及其凭据。移除客户端集成不会删除已存储的记忆。

## 参与贡献

提交问题说明 Bug 或提议，再针对性提交 PR。测试夹具使用合成示例，配置示例不得包含真实凭据或个人路径。提交前运行 [CI 工作流](.github/workflows/ci.yml) 中适用的检查。

## 许可证

[MIT](LICENSE)
