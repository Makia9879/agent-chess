# Chess Agent Room

Chess Agent Room 是一个面向 Agent vs Agent 国际象棋对局的 MVP 项目。Web 用户在浏览器创建房间并查看棋局，本地 Agent 通过 MCP adapter 加入房间、查询局面、获取合法走法并提交走法。服务端不运行 AI，不提供 bestmove，只负责房间、棋局状态、合法性校验、持久化和实时同步。

## 技术栈

- Frontend: Next.js + React，生产部署到 Vercel。
- Backend: TypeScript Cloudflare Workers。
- Realtime: Cloudflare Durable Objects，按房间串行处理走法并广播 WebSocket 事件。
- Database: PostgreSQL，本地使用 docker-compose PostgreSQL，生产使用 Neon PostgreSQL，要求 UTF-8。
- Local Agent: MCP adapter，调用 Worker HTTP API，不直接连接数据库。
- Monorepo: pnpm workspace，所有本地构建、运行、测试、迁移命令都通过 docker-compose 执行。

## 目录结构

```text
apps/
  web/             Next.js 前端
  worker/          Cloudflare Worker + Durable Object 后端
  mcp-adapter/     本地 MCP adapter
packages/
  shared/          Web / Worker / MCP 共用 TypeScript 类型
migrations/        PostgreSQL SQL 迁移
scripts/           本地开发、测试、迁移、部署脚本
config/            本地配置占位
```

主要文档：

- `spec_chess_api.md`：技术方案和 API 规格。
- `system_requirements.md`：系统需求和实施顺序。
- `review_deepseek.md`：外部 review 记录和处理标记。

## 本地前置条件

本地开发必须通过 docker-compose 管理，不在宿主机直接执行 `pnpm install`、`pnpm test`、`tsc`、`wrangler dev`、迁移等构建或运行命令。

需要提前准备镜像：

```sh
docker images node:22-alpine
docker images postgres:16-alpine
```

如果缺少镜像，请先拉取：

```sh
docker pull node:22-alpine
docker pull postgres:16-alpine
```

## 本地开发

首次安装依赖：

```sh
./scripts/bootstrap.sh
```

启动本地开发环境：

```sh
./scripts/dev-up.sh
```

启动后服务：

- Web: `http://localhost:3000`
- Worker API: `http://localhost:8787`
- PostgreSQL: `localhost:5432`
- MCP adapter: docker-compose 内服务名 `mcp-adapter`

重启应用服务：

```sh
./scripts/dev-restart.sh
```

停止本地服务：

```sh
./scripts/dev-down.sh
```

本地 PostgreSQL 使用：

- user: `chess`
- password: `chess`
- database: `chess`
- encoding: UTF-8

`postgres` 服务带 `pg_isready` healthcheck，`migrate` 和 `worker` 会等待 PostgreSQL healthy 后启动。

## 常用脚本

所有脚本都在宿主机触发，但内部通过 docker-compose 执行实际命令。

```sh
./scripts/bootstrap.sh       # 容器内安装 pnpm 依赖
./scripts/dev-up.sh          # 安装依赖、启动 postgres、执行本地迁移、启动 worker/web
./scripts/dev-restart.sh     # 重启 worker/web/mcp-adapter
./scripts/dev-down.sh        # 停止 docker-compose 服务
./scripts/migrate-local.sh   # 对本地 PostgreSQL 执行迁移
./scripts/typecheck.sh       # 容器内 TypeScript 检查
./scripts/test.sh            # 容器内测试
```

## API 概览

Worker API：

- `GET /api/health`
- `POST /api/rooms`
- `GET /api/rooms/{room_id}`
- `GET /api/rooms/{room_id}/legal-moves`
- `POST /api/rooms/{room_id}/moves`
- `POST /api/rooms/by-code/{room_code}/join`
- `GET /api/rooms/{room_id}/events`

MCP tools：

- `join_room`
- `get_room_state`
- `get_legal_moves`
- `submit_move`

走法使用 UCI 格式，例如 `e2e4`、`e7e8q`。服务端使用棋规库校验合法性，棋局状态以 FEN 持久化。

## 数据库迁移

迁移文件放在 `migrations/`，命名使用递增编号：

```text
0001_init.sql
0002_add_xxx.sql
```

本地迁移：

```sh
./scripts/migrate-local.sh
```

Neon 生产迁移需要显式确认目标：

```sh
CONFIRM_NEON_MIGRATION=yes NEON_DATABASE_URL="postgres://..." ./scripts/migrate-neon.sh
```

生产迁移前必须确认 Neon 项目、分支、连接串和备份点。迁移完成后需要校验：

```sql
SHOW SERVER_ENCODING;
```

结果必须为 `UTF8`。

## 配置

本地 docker-compose 主要环境变量：

- `DATABASE_URL=postgres://chess:chess@postgres:5432/chess`
- `CORS_ALLOW_ORIGINS=http://localhost:3000`
- `ROOM_CODE_LENGTH=6`
- `RUNTIME_CONFIG_TTL_SECONDS=60`
- `NEXT_PUBLIC_WORKER_BASE_URL=http://localhost:8787`
- `NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8787`
- `WORKER_BASE_URL=http://worker:8787`

生产环境：

- Vercel 配置 `NEXT_PUBLIC_WORKER_BASE_URL`、`NEXT_PUBLIC_WS_BASE_URL`。
- Cloudflare Worker 使用 `apps/worker/wrangler.toml` 声明 Worker、Durable Object binding 和 vars。
- Neon 连接信息使用 Cloudflare Secret、Hyperdrive binding 或 Neon pooled connection string，不写入仓库。
- MCP adapter 使用 `WORKER_BASE_URL` 指向 Cloudflare Worker 正式域名。

## 生产部署

生产目标组合：

- Frontend: Vercel
- Backend: Cloudflare Workers + Durable Objects
- Database: Neon PostgreSQL

建议发布顺序：

1. 执行容器内 typecheck 和 test。
2. 确认 Neon 目标环境并执行生产迁移。
3. 部署 Cloudflare Worker。
4. 部署 Vercel 前端。
5. 调用 `GET /api/health` 并完成一次建房、Agent 加入、提交走法的冒烟验证。

部署 Worker：

```sh
./scripts/deploy-worker.sh
```

部署 Web：

```sh
./scripts/deploy-web.sh
```

注意：部署脚本内部使用容器内 Wrangler / Vercel CLI。生产账号登录、Cloudflare Secret、Vercel 项目绑定和 Neon 连接串需要在对应平台侧提前配置。

## 验证

类型检查：

```sh
./scripts/typecheck.sh
```

测试：

```sh
./scripts/test.sh
```

docker-compose 配置检查：

```sh
docker-compose config
```

## 设计边界

- MVP 不做账号体系、登录注册和反作弊。
- MVP 不做服务端 AI、Stockfish、bestmove 或任何后端建议走法能力。
- 每个房间第一阶段只允许两个 Agent 执棋：一个 `white`，一个 `black`。
- C2 浏览器可以观察房间；MCP Agent 不允许以 spectator 身份加入。
- 棋局正确性依赖参与者 token、执棋方、版本号、Durable Object 串行处理和服务端棋规校验。
