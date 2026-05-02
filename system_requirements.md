# Chess MVP 系统需求文档

## 项目范围

MVP 交付目标：

- 前端 C2 部署到 Vercel。
- 后端使用 TypeScript 实现，部署到 Cloudflare Workers。
- 房间实时能力使用 Cloudflare Durable Objects。
- 数据库使用 Neon PostgreSQL，字符集 UTF-8。
- 本地 Agent 通过本地 MCP adapter 加入房间、读取局面、获取合法走法、提交走法。
- 本地开发、构建、测试、迁移验证必须通过 `docker-compose` 执行。
- 对局以 Agent vs Agent 为主，MVP 不做反作弊，只保证棋局结果不能被未授权请求、非法走法、乱序提交恶意篡改。

## 系统需求表

| 序号 | 模块 | 功能 | 程序实现描述 | 涉及人员 | 预估工时 |
| ---- | ---- | ---- | ------------ | -------- | -------- |
| 1 | 工程基础 | Monorepo 初始化 | - 新增目录：`apps/web`、`apps/worker`、`apps/mcp-adapter`、`packages/shared`、`migrations`<br />- 初始化 TypeScript、lint、test、format 基础配置<br />- 前端、Worker、MCP adapter 共用基础类型<br />- 不实现业务页面和接口 | 前端、后端 | 1人天 |
| 2 | 开发环境 | docker-compose 开发环境 | - 新增 `docker-compose.yml`<br />- 定义 `web`、`worker`、`mcp-adapter`、`postgres`、`migrate` 服务<br />- 本地 PostgreSQL 使用 UTF-8 初始化<br />- 所有构建、测试、迁移验证命令通过容器执行 | 后端 | 1人天 |
| 3 | 配置 | Worker 配置初始化 | - 新增 `apps/worker/src/config.ts`<br />- 支持读取 Worker Vars、Secrets、Durable Object binding、Hyperdrive binding<br />- 启动或首次请求时校验必填配置<br />- 配置缺失时返回 `500 config_error` | 后端 | 1人天 |
| 4 | 配置 | 动态配置读取 | - 新增 `runtime_config` 表迁移<br />- 支持读取 CORS、房间配置、限流配置<br />- Worker 对动态配置做短 TTL 缓存<br />- 读取失败时保留上一份有效配置 | 后端 | 1人天 |
| 5 | 数据库 | 基础表迁移 | - 新增 `rooms`、`room_participants`、`games`、`game_moves` 表<br />- `games` 增加 `version` 字段<br />- `room_participants` 增加 token 哈希和白/黑执棋方唯一约束<br />- `game_moves` 增加 `participant_id` 和审计字段<br />- 本地和 Neon schema 保持一致 | 后端 | 1.5人天 |
| 6 | 数据库 | 迁移执行与校验 | - 容器内执行本地迁移<br />- 校验 `SHOW SERVER_ENCODING` 返回 `UTF8`<br />- 支持显式目标执行 Neon 迁移<br />- 防止误把生产迁移打到本地或反向误操作 | 后端 | 1人天 |
| 7 | 棋规 | 棋局规则封装 | - 引入 TypeScript 棋规库，优先 `chess.js`<br />- 支持标准初始局面和指定 FEN 初始化<br />- 支持合法走法列表、UCI 走法校验、终态判断<br />- 服务端不提供 AI 和 bestmove | 后端 | 1.5人天 |
| 8 | Worker API | 创建房间 | - 实现 `POST /api/rooms`<br />- 支持字段：`fen`、`display_name`<br />- 生成 `room_id`、`room_code`、`game_id`<br />- 写入 `rooms`、`room_participants`、`games`<br />- 返回 FEN、turn、status、version、legal_moves | 后端 | 1.5人天 |
| 9 | Worker API | 查询房间 | - 实现 `GET /api/rooms/{room_id}`<br />- 返回房间码、参与者、棋局状态、合法走法、走法记录<br />- 房间不存在返回 `404 room_not_found`<br />- 响应字段使用 `snake_case` | 后端 | 1人天 |
| 10 | Worker API | 查询合法走法 | - 实现 `GET /api/rooms/{room_id}/legal-moves`<br />- 根据当前 FEN 返回所有合法 UCI 走法<br />- 支持浏览器高亮和 MCP adapter 调用<br />- 棋局不存在时返回明确错误 | 后端 | 0.5人天 |
| 11 | 参与者安全 | 房间参与者令牌 | - 创建房间和加入房间时生成 `participant_id` 和 `participant_token`<br />- 原始 token 只返回一次，数据库只保存哈希<br />- 提交走法必须携带 token<br />- token 无效返回 `401 unauthorized_participant` | 后端 | 1人天 |
| 12 | Durable Object | 房间实例 | - 每个房间映射一个 Durable Object<br />- 支持根据 `room_id` 定位房间实例<br />- 维护房间内 WebSocket 连接<br />- 管理房间事件广播 | 后端 | 1.5人天 |
| 13 | Durable Object | 串行提交走法 | - Web 和 MCP 走法提交进入同一个房间 Durable Object<br />- 校验参与者 token、执棋方、`expected_version`<br />- 校验 UCI 合法性和棋局状态<br />- 合法后更新 Neon 并递增 `games.version`<br />- 广播 `game.updated` | 后端 | 2人天 |
| 14 | Worker API | WebSocket 订阅 | - 实现 `GET /api/rooms/{room_id}/events`<br />- 浏览器连接房间 WebSocket<br />- 支持事件：`room.participant_joined`、`game.updated`<br />- 支持心跳、断开清理和错误返回 | 后端、前端 | 1.5人天 |
| 15 | MCP adapter | MCP 服务入口 | - 新增本地 `apps/mcp-adapter`<br />- 暴露 MCP server 给本地 Agent<br />- 配置 Worker API 地址<br />- 不直接连接 Neon | 后端 | 1人天 |
| 16 | MCP adapter | 加入房间工具 | - 实现 `join_room`<br />- 入参：`room_code`、`display_name`、`side`<br />- 调用 Worker API 加入房间<br />- 返回当前棋局状态、合法走法、`participant_token` | 后端 | 0.5人天 |
| 17 | MCP adapter | 查询工具 | - 实现 `get_room_state`<br />- 实现 `get_legal_moves`<br />- 返回 FEN、turn、status、version、moves、participants<br />- 错误透传为 Agent 可读信息 | 后端 | 0.5人天 |
| 18 | MCP adapter | 提交走法工具 | - 实现 `submit_move`<br />- 入参：`room_id`、`uci`、`participant_token`、`expected_version`<br />- 服务端校验 token、执棋方、版本和走法合法性<br />- 返回更新后的棋局状态 | 后端 | 0.5人天 |
| 19 | Web 前端 | 创建房间页面 | - 新增首页或房间创建页<br />- 支持输入 `display_name`、执棋方和可选 FEN<br />- 点击创建后展示 `room_code`<br />- 保存创建者 `participant_token` 用于提交走法<br />- 创建失败展示错误信息 | UI、前端 | 1人天 |
| 20 | Web 前端 | 棋局房间页面 | - 展示棋盘、当前 FEN、行动方、棋局状态<br />- 展示参与者和走法记录<br />- 支持携带 `participant_token` 提交 UCI 走法<br />- 提交成功后刷新局面 | UI、前端 | 2人天 |
| 21 | Web 前端 | 实时更新 | - 连接房间 WebSocket<br />- 接收 `room.participant_joined` 更新参与者列表<br />- 接收 `game.updated` 更新棋盘和走法记录<br />- 断线时展示重连状态 | 前端 | 1.5人天 |
| 22 | Web 前端 | API 客户端封装 | - 封装 Worker HTTP 调用<br />- 封装 WebSocket 地址生成<br />- 读取 Vercel 环境变量<br />- 统一处理错误响应 | 前端 | 0.5人天 |
| 23 | 测试 | 后端单元测试 | - 覆盖配置校验、棋规封装、错误响应<br />- 覆盖合法走法、非法走法、终态判断<br />- 覆盖 token 无效、非当前行动方、版本冲突<br />- 测试命令通过 `docker-compose` 执行 | 后端 | 1.5人天 |
| 24 | 测试 | 集成测试 | - 覆盖建房、查询房间、加入房间、提交走法完整流程<br />- 覆盖两个 Agent 交替提交走法<br />- 覆盖未授权提交、非法走法、乱序提交被拒绝<br />- 校验 `games` 和 `game_moves` 正确落表<br />- 校验 PostgreSQL 编码为 UTF-8 | 后端 | 1.5人天 |
| 25 | 部署 | Vercel 前端部署 | - 创建 Vercel 项目<br />- 配置 `NEXT_PUBLIC_WORKER_BASE_URL` 和 `NEXT_PUBLIC_WS_BASE_URL`<br />- 完成生产构建<br />- 验证浏览器可访问前端页面 | 前端 | 0.5人天 |
| 26 | 部署 | Cloudflare Worker 部署 | - 配置 Worker 项目<br />- 配置 Durable Object binding<br />- 配置 Hyperdrive 或 Neon serverless 连接<br />- 配置 CORS 和生产环境变量<br />- 验证 Worker API 可访问 | 后端 | 1人天 |
| 27 | 部署 | Neon 生产数据库 | - 创建 Neon PostgreSQL 项目<br />- 执行生产迁移前显式确认目标环境<br />- 校验 `SHOW SERVER_ENCODING = UTF8`<br />- 配置连接 secret 或 Hyperdrive binding | 后端 | 0.5人天 |
| 28 | 验收 | MVP 联调验收 | - Web 创建房间并展示房间码<br />- 两个本地 Agent 通过 MCP adapter 加入白方和黑方<br />- 两个 Agent 都能查询局面和合法走法<br />- 两个 Agent 能按行动方交替提交合法 UCI 走法<br />- 未授权、非当前行动方、乱序提交均被拒绝<br />- 浏览器能收到 WebSocket 更新 | 前端、后端 | 1人天 |

## 实施顺序

1. 工程基础与 `docker-compose` 开发环境。
2. PostgreSQL 迁移和 UTF-8 校验。
3. Worker 配置、棋规封装、基础 HTTP API。
4. 参与者令牌、Durable Object 房间实例、WebSocket、串行提交。
5. MCP adapter 工具。
6. Vercel 前端页面。
7. 容器内测试和本地联调。
8. Vercel、Cloudflare、Neon 生产联调。

## 本轮不做

- 用户账号体系、登录注册和反作弊。
- 联机大厅、匹配系统、观战列表。
- 服务端 AI、Stockfish、bestmove 或任何后端建议走法能力。
- PGN 导入导出。
- 计时器和超时判负。
- 完整拖拽棋盘体验。
- 生产环境文件监听式热更新。
