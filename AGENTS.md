# Repository Guidelines

## 项目结构与模块组织

本仓库是一个 pnpm workspace，用于 Agent-vs-Agent 国际象棋房间 MVP。主要应用代码位于 `apps/`：`apps/web` 是 Next.js/React 前端，`apps/worker` 是 Cloudflare Worker 与 Durable Object 后端，`apps/mcp-adapter` 是本地 Agent 使用的 MCP 适配层。共享 TypeScript 类型放在 `packages/shared/src`。SQL 迁移位于 `migrations/`，使用递增编号命名，例如 `0001_init.sql`。设计、接口和需求文档位于 `docs/specs/`；变更行为或接口契约时应同步更新。

## 构建、测试与开发命令

项目命令应通过仓库脚本执行；脚本会在 docker-compose 环境中运行实际命令，不要直接在宿主机运行 pnpm、tsc、wrangler 或迁移。

- `./scripts/bootstrap.sh`：在容器内安装 workspace 依赖。
- `./scripts/dev-up.sh`：启动 PostgreSQL，执行本地迁移，并启动 web/worker 服务。
- `./scripts/dev-restart.sh`：配置或依赖变更后重启应用服务。
- `./scripts/dev-down.sh`：停止本地 docker-compose 服务。
- `./scripts/migrate-local.sh`：将 SQL 迁移应用到本地 PostgreSQL。
- `./scripts/typecheck.sh`：执行整个 workspace 的 TypeScript 检查。
- `./scripts/test.sh`：执行整个 workspace 的 Vitest 测试。

本地服务默认地址：Web `http://localhost:3000`，Worker API `http://localhost:8787`，PostgreSQL `localhost:5432`。

## 编码风格与命名规范

使用 TypeScript ES modules。导入保持明确，跨应用共享的数据结构优先从 `@chess-room/shared` 引用，避免重复定义。现有源码使用两个空格缩进、双引号、分号，变量和函数使用 camelCase。React 组件使用 PascalCase。测试文件采用 `*.test.ts`，放在被测试代码附近。Worker 中的 HTTP、棋规、认证和持久化逻辑应按模块拆分，避免新增大而杂的文件。

## 测试指南

测试框架为 Vitest。棋规、安全敏感逻辑、认证流程和 API 契约变更应补充聚焦的单元测试。优先编写确定性测试，避免依赖外部网络。提交前运行 `./scripts/test.sh`；任何 TypeScript 变更都应运行 `./scripts/typecheck.sh`。

## 提交与 Pull Request 规范

近期提交使用简短、面向行为的摘要，常见前缀包括 `add:`、`update:`，例如 `update: validate anonymous room creation`。Pull Request 应包含简要说明、相关 issue 或 spec 链接、测试和 typecheck 结果；涉及数据库时说明迁移影响；涉及可见前端变更时附截图。

## 安全与配置提示

不要提交生产密钥或数据库 URL。本地默认配置见 `README.md`；生产配置应放在 Vercel、Cloudflare Worker secrets/vars 或 Neon 配置中。生产数据库迁移必须显式确认目标，并按 README 要求校验 UTF-8 编码。
