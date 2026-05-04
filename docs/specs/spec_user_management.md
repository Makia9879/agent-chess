# 用户管理模块技术方案

## 目标与范围

本模块为 Chess Agent Room 增加用户登录与身份管理能力，支持：

- Google OAuth 登录。
- Web3 钱包连接登录，支持 Monad Testnet / Mainnet 网络切换。
- 同一个用户可以绑定多个登录身份，例如一个 Google 账号和多个钱包地址。
- Web 用户登录后创建房间、查看自己创建的房间。
- 服务端为登录用户签发会话，后续 Web 请求可识别 `user_id`。

第一阶段目标是“可登录、可识别用户、可关联房间创建者”，不是完整社交账号系统。

本模块不改变棋局正确性核心规则。走法提交仍必须依赖房间参与者 `participant_token`、执棋方、版本号和服务端棋规校验。用户登录态只用于 Web 侧身份、审计、个人房间列表和后续产品能力。

## 复用边界

复用现有模块：

- `apps/web`：新增登录入口、会话状态展示、Google 登录按钮、钱包连接按钮。
- `apps/worker`：新增 auth API、OAuth callback、Web3 challenge 和 verify 接口。
- `packages/shared`：新增用户、会话、登录请求/响应类型。
- `migrations/`：新增用户管理相关表。
- `rooms.created_by`：当前是 `TEXT`，第一阶段保留；新增 `rooms.created_by_user_id` 关联登录用户。
- `room_participants`：保留 `participant_token` 设计；登录用户可以创建参与者，但参与者 token 仍是提交走法的直接凭证。

外部能力：

- Google OAuth 2.0 / OpenID Connect。
- Web3 钱包签名，前端优先支持 EIP-1193 provider，例如 MetaMask。
- Monad 网络：
  - Monad Mainnet：`chain_id = 143`，钱包侧十六进制为 `0x8f`。
  - Monad Testnet：`chain_id = 10143`，钱包侧十六进制为 `0x279f`。
- 以太坊地址签名校验，优先使用 `viem` 或 `ethers`。第一阶段建议 `viem`，包体较小、API 明确。
- 会话 Cookie 使用 Worker 签名，不依赖 Vercel Server Action。

不复用边界：

- 不把 `participant_token` 当用户登录态。
- 不让 MCP Agent 通过用户登录态绕过房间参与者 token。
- 不在 Vercel 直接连接 Neon。

## 身份模型

核心概念：

- `User`：系统用户，一个真实使用者的主身份。
- `Identity`：第三方身份绑定，包括 Google 和 Web3 wallet。
- `Session`：Web 登录会话，用于浏览器访问 Worker API。
- `WalletChallenge`：钱包登录前的一次性随机挑战记录，保存 nonce 的过期和消费状态，防止签名重放。

身份合并规则：

- 同一个 Google `sub` 只能绑定一个用户。
- 同一个钱包地址在同一链命名空间内只能绑定一个用户。
- 用户已登录时新增 Google 或钱包登录，视为绑定身份。
- 用户未登录时登录 Google 或钱包：
  - 如果 identity 已存在，登录对应用户。
  - 如果 identity 不存在，创建新用户并绑定该 identity。

Web3 地址规则：

- 地址统一保存为小写 checksum-insensitive 格式。
- 第一阶段只支持 EVM 地址。
- 第一阶段只支持 Monad Mainnet 和 Monad Testnet 两个网络。
- `chain_id` 必须是 `143` 或 `10143`。
- `chain_id` 作为登录留痕和前端网络提示依据，不参与唯一身份判断；唯一键使用 `namespace + address`，其中 namespace 第一阶段固定为 `evm`。
- 签名消息必须包含 domain、nonce、issued_at、expires_at 和 statement。

## 数据落表方案

新增迁移建议：`migrations/0002_user_management.sql`。

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE user_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  email_verified BOOLEAN NOT NULL DEFAULT false,
  wallet_namespace TEXT NOT NULL DEFAULT '',
  wallet_address TEXT NOT NULL DEFAULT '',
  wallet_chain_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_user_identities_google
  ON user_identities(provider_subject)
  WHERE provider = 'google';

CREATE UNIQUE INDEX idx_user_identities_wallet
  ON user_identities(wallet_namespace, wallet_address)
  WHERE provider = 'wallet';

CREATE TABLE user_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent_hash TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);

CREATE TABLE oauth_states (
  id UUID PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  session_token_hash TEXT NOT NULL DEFAULT '',
  state_cookie_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX idx_oauth_states_expires_at ON oauth_states(expires_at);

CREATE TABLE wallet_challenges (
  id UUID PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE,
  wallet_namespace TEXT NOT NULL DEFAULT 'evm',
  wallet_address TEXT NOT NULL,
  chain_id TEXT NOT NULL DEFAULT '',
  statement TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX idx_wallet_challenges_address ON wallet_challenges(wallet_namespace, wallet_address);

ALTER TABLE rooms
  ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_rooms_created_by_user_id ON rooms(created_by_user_id);

-- 回滚参考：
-- ALTER TABLE rooms DROP COLUMN IF EXISTS created_by_user_id;
-- DROP TABLE IF EXISTS wallet_challenges, oauth_states, user_sessions, user_identities, users CASCADE;
```

字段规则：

- `users.display_name` 是站内展示名，可来自 Google name、钱包短地址或用户后续修改。
- 第一阶段不落库 `avatar_url`。Google 用户头像按 email 派生 Gravatar URL；钱包用户没有 email 时使用地址派生的默认 identicon。后续如果支持用户自定义头像，再单独增加头像字段。
- `user_identities.provider` 可选 `google`、`wallet`。
- Google identity：
  - `provider = 'google'`
  - `provider_subject = Google sub`
  - `email`、`email_verified`、`display_name` 来自 ID token claims。
- Wallet identity：
  - `provider = 'wallet'`
  - `provider_subject = evm:<lowercase_address>`
  - `wallet_namespace = 'evm'`
  - `wallet_address = lowercase_address`
  - `wallet_chain_id` 只做最近登录留痕，取值为 `143` 或 `10143`。
- `user_sessions.token_hash` 保存会话 token 的 SHA-256 哈希，原始 token 只写入 HttpOnly Cookie。
- `oauth_states` 过期时间建议 10 分钟。该表保存 Google OAuth `state` 和 PKCE `code_verifier`，callback 时必须校验 state 未过期、未消费，并取出 `code_verifier` 换 token。
- `oauth_states.session_token_hash` 用于已登录用户绑定新身份时把 OAuth state 绑定到当前会话；未登录登录流程保持空字符串。
- `oauth_states.state_cookie_hash` 用于未登录场景 double-submit 校验：start 时额外设置短期 HttpOnly state cookie，callback 时校验 cookie hash 与表记录一致，降低 login CSRF 风险。标记 consumed 必须使用单条条件更新或事务锁，确保 `consumed_at IS NULL` 到写入 `consumed_at` 的状态变更是原子的。
- `wallet_challenges` 过期时间建议 5 分钟。该表独立保存钱包登录 nonce，原因是 verify 时必须确认 nonce 由服务端签发、未过期且未消费；如果只把 nonce 放在签名消息里，服务端无法可靠阻止同一签名在有效期内被重放。标记 consumed 必须使用单条条件更新或事务锁，确保 `consumed_at IS NULL` 到写入 `consumed_at` 的状态变更是原子的。
- `rooms.created_by_user_id` 只用于用户房间归属和查询，不参与走法合法性判断。

## 会话与 Cookie

会话策略：

- 登录成功后生成 32 字节随机 session token。
- 数据库只保存 `SHA-256(session_token)`。
- 浏览器 Cookie 名称：`car_session`。
- Cookie 属性：
  - `HttpOnly`
  - `Secure` 在生产环境开启
  - `SameSite=Lax`
  - `Path=/`
  - `Max-Age=2592000`，默认 30 天
- 退出登录时将 `user_sessions.revoked_at` 设置为当前时间，并清空 Cookie。

Worker 认证规则：

- 有 Cookie 且 session 存在、未过期、未撤销，则请求上下文带 `user_id`。
- 无 Cookie 的请求仍允许访问公开 API，例如健康检查、查看房间、创建匿名房间。
- 创建房间时如果已登录，则写入 `rooms.created_by_user_id`；未登录时保持 `NULL`。
- 实现统一认证辅助函数 `getSessionUser(sql, request): Promise<string | null>`：
  - 从 `Cookie` 读取 `car_session`。
  - 计算 `SHA-256(session_token)`。
  - 查询 `user_sessions.token_hash`，要求 `expires_at > now()` 且 `revoked_at IS NULL`。
  - 命中则返回 `user_id`，未命中或 Cookie 缺失返回 `null`。
  - 数据库异常按 `500 internal_error` 处理，不退化为匿名用户。
- `user_sessions` 过期记录不要求请求路径同步删除；早期只在查询中过滤，后续用 Worker Cron Trigger 或迁移脚本定期清理 `expires_at < now()` 的记录。
- `oauth_states` 和 `wallet_challenges` 同样不要求请求路径同步删除；查询时必须过滤 `expires_at > now()`，过期记录由同一 Worker Cron Trigger 或迁移脚本定期清理。

CORS 策略：

- 前端请求用户 API 必须使用 `credentials: 'include'`。
- Worker CORS 响应必须包含 `Access-Control-Allow-Credentials: true`。
- 启用 credentials 时 `Access-Control-Allow-Origin` 必须返回 allowlist 中匹配的具体 origin，不能返回 `*`。
- `Access-Control-Allow-Headers` 至少包含 `content-type,authorization`。

## Google 登录流程

配置：

- Worker secret：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。
- Worker var：`GOOGLE_REDIRECT_URI`。
- Worker env 类型新增：
  - `GOOGLE_CLIENT_ID?: string`
  - `GOOGLE_CLIENT_SECRET?: string`
  - `GOOGLE_REDIRECT_URI?: string`
  - `SESSION_MAX_AGE_SECONDS?: string`
- Vercel env：前端只需要 Worker base URL，不保存 Google secret。
- 本地测试使用 Worker 本地回调地址，例如 `http://localhost:8787/api/auth/google/callback`，并加入 Google Cloud Console 的 Authorized redirect URIs。前端和回调地址必须使用同一个 host，避免 OAuth state cookie 在 `localhost` 和 `127.0.0.1` 之间丢失。
- 生产环境使用 Cloudflare Worker HTTPS 回调地址，生产域名确定后加入 Google Cloud Console。

接口：

### `GET /api/auth/google/start`

生成 Google OAuth 授权 URL。

处理：

1. 生成 `state` 和 PKCE `code_verifier`。
2. 如果当前已有 `car_session`，计算 `session_token_hash` 并写入 `oauth_states`。
3. 生成短期 state cookie token，保存其 SHA-256 到 `oauth_states.state_cookie_hash`。
4. 将 `state`、`code_verifier`、`session_token_hash`、`state_cookie_hash`、`expires_at` 写入 `oauth_states`。
5. 设置短期 HttpOnly state cookie。
6. 返回授权 URL，或直接 302 跳转 Google。

响应：

```json
{
  "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?..."
}
```

### `GET /api/auth/google/callback`

Google OAuth 回调。

处理：

1. 校验 `state` 存在、未过期、未消费。
2. 从 Cookie 读取短期 state cookie token，计算 `SHA-256(state_cookie_token)`，与 `oauth_states.state_cookie_hash` 比对；不一致返回 `400 invalid_oauth_state`。
3. 如果 `oauth_states.session_token_hash` 非空，校验它与当前 `car_session` hash 一致，用于已登录用户绑定身份；如果当前无 `car_session` 或 hash 不一致，返回 `400 invalid_oauth_state`，不创建新用户。
4. 使用 `code_verifier` 和 `code` 换取 token。
5. 校验 ID token issuer、audience、expiration。
6. 读取 `sub`、`email`、`email_verified`、`name`、`picture`。
7. 标记 `oauth_states.consumed_at`。
8. 查找或创建 `users` 和 `user_identities`。
9. 创建 `user_sessions`。
10. 设置 `car_session` Cookie，清空短期 state cookie。
11. 302 跳转回前端登录完成页。

错误：

- `400 invalid_oauth_state`
- `400 oauth_exchange_failed`
- `401 invalid_google_token`

## Web3 钱包登录流程

### `POST /api/auth/wallet/challenge`

请求：

```json
{
  "wallet_address": "0xabc...",
  "chain_id": "10143"
}
```

规则：

- `wallet_address` 必须是合法 EVM 地址。
- `chain_id` 必须是 Monad Mainnet `143` 或 Monad Testnet `10143`。
- 服务端生成 `nonce` 和标准签名消息。
- challenge 5 分钟内有效，只能消费一次。

响应：

```json
{
  "nonce": "random",
  "message": "Chess Agent Room wants you to sign in...\nNonce: random\nIssued At: ...",
  "expires_at": "2026-05-03T12:00:00Z"
}
```

### `POST /api/auth/wallet/verify`

请求：

```json
{
  "wallet_address": "0xabc...",
  "chain_id": "10143",
  "nonce": "random",
  "signature": "0x..."
}
```

处理：

1. 查找未过期、未消费的 challenge。
2. 校验 `chain_id` 与 challenge 记录一致，且属于 Monad Mainnet/Testnet 白名单。
3. 校验签名恢复地址等于 `wallet_address`。
4. 标记 challenge 已消费。
5. 查找或创建 `users` 和 wallet identity。
6. 创建 `user_sessions`。
7. 设置 `car_session` Cookie。

错误：

- `400 invalid_wallet_address`
- `400 unsupported_chain_id`
- `400 wallet_chain_mismatch`
- `400 challenge_not_found`
- `400 challenge_expired`
- `401 invalid_wallet_signature`

## 用户 API

### `GET /api/me`

读取当前登录用户。

响应：

```json
{
  "user": {
    "user_id": "uuid",
    "display_name": "makia",
    "avatar_url": "https://www.gravatar.com/avatar/...",
    "identities": [
      {
        "provider": "google",
        "email": "user@example.com",
        "email_verified": true
      },
      {
        "provider": "wallet",
        "wallet_namespace": "evm",
        "wallet_address": "0xabc...",
        "wallet_chain_id": "10143"
      }
    ]
  }
}
```

未登录：

```json
{
  "user": null
}
```

### `POST /api/auth/logout`

退出登录。

响应：

```json
{
  "ok": true
}
```

### `GET /api/me/rooms?limit=20&cursor=...`

读取当前用户创建的房间。

查询参数：

- `limit`：可选，默认 `20`，最大 `50`。
- `cursor`：可选，上一页最后一条记录的分页游标。游标是不透明字符串，客户端不应解析其内容；服务端使用 base64url 编码 JSON `{"updated_at":"...","room_id":"..."}`。

规则：

- 必须登录。
- 只返回 `rooms.created_by_user_id = current_user.id` 的房间。
- 按 `updated_at DESC, room_id DESC` 排序。
- `cursor` 编码上一页最后一条记录的 `updated_at` 和 `room_id`。

响应：

```json
{
  "rooms": [
    {
      "room_id": "uuid",
      "room_code": "AB12CD",
      "room_status": "active",
      "game_id": "uuid",
      "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "status": "active",
      "version": 5,
      "updated_at": "2026-05-04T10:00:00Z"
    }
  ],
  "next_cursor": "base64url-json-cursor"
}
```

错误：

- `401 unauthenticated`

## 前端交互

新增 UI：

- 顶部用户状态区：
  - 未登录：显示 `Google 登录`、`连接钱包`。
  - 已登录：显示头像/展示名、退出按钮。
- 登录完成后刷新 `GET /api/me`。
- 创建房间时无需前端额外传 `user_id`；Worker 从 session 中识别当前用户。
- 钱包登录使用浏览器 EIP-1193 provider：
  - 展示网络切换控件，选项为 Monad Testnet 和 Monad Mainnet。
  - 页面显式展示当前钱包连接网络，例如 `Monad Testnet` 或 `Monad Mainnet`。
  - 如果钱包当前网络与用户选择不一致，调用 `wallet_switchEthereumChain` 尝试切换。
  - 如果钱包未添加目标网络，调用 `wallet_addEthereumChain` 引导添加。
  - 请求账户。
  - 请求 challenge。
  - 调用 `personal_sign` 或等价签名。
  - 提交 verify。

第一阶段不要求 MCP adapter 登录。Agent 加入房间仍使用 `room_code` 和 `participant_token`。

## 请求解析与校验

统一约定：

- 请求和响应使用 JSON，Google callback 除外。
- 用户 API 认证优先读取 `Cookie: car_session=...`。
- 所有 auth API 返回统一错误结构：

```json
{
  "error": {
    "code": "unauthenticated",
    "message": "login required"
  }
}
```

输入限制：

- `display_name` 最大 64 字符。
- 钱包地址必须通过 EVM 地址格式校验。
- OAuth `state`、wallet `nonce` 必须是高熵随机值。
- challenge 和 OAuth state 都必须有过期时间。
- 用户房间列表 `limit` 必须在 `1..50`，非法分页参数返回 `400 invalid_pagination`。

限流：

- Auth 端点必须接入现有限流机制，触发时返回 `429 rate_limited`。
- `GET /api/auth/google/start`：按 IP 限流，建议每分钟 20 次。
- `GET /api/auth/google/callback`：按 IP 限流，建议每分钟 20 次。
- `POST /api/auth/wallet/challenge`：按 IP 限流，建议每分钟 20 次。
- `POST /api/auth/wallet/verify`：按 IP 和 `wallet_address` 双维度限流，建议每分钟 10 次。

## 业务处理

创建房间关联用户：

1. Worker 解析 session。
2. 如果 session 有效，得到 `current_user_id`。
3. 原有创建房间流程不变。
4. 写入 `rooms.created_by_user_id = current_user_id`；未登录则写入 `NULL`。
5. 返回结构保持兼容，第一阶段不强制返回用户字段。

查询用户房间：

1. Worker 解析 session。
2. 未登录返回 `401 unauthenticated`。
3. 校验 `limit` 和 `cursor`。
4. 查询 `rooms.created_by_user_id = current_user_id`。
5. 返回分页房间摘要列表和下一页 cursor。

身份绑定：

1. 用户已登录时发起新的 Google 或 wallet 登录。
2. 如果 identity 未被其他用户绑定，则绑定到当前用户。
3. 如果 identity 已绑定当前用户，刷新 identity 信息。
4. 如果 identity 已绑定其他用户，返回 `409 identity_already_bound`。

## 响应组装

用户展示结构：

```ts
interface CurrentUserView {
  user_id: string;
  display_name: string;
  /** Derived field, not persisted in users/user_identities. */
  avatar_url: string;
  identities: UserIdentityView[];
}

type UserIdentityView =
  | {
      provider: "google";
      email: string;
      email_verified: boolean;
    }
  | {
      provider: "wallet";
      wallet_namespace: "evm";
      wallet_address: string;
      wallet_chain_id: "143" | "10143";
    };
```

房间摘要结构：

```ts
interface UserRoomSummary {
  room_id: string;
  room_code: string;
  room_status: string;
  game_id: string;
  fen: string;
  status: string;
  version: number;
  updated_at: string;
}

interface UserRoomsResponse {
  rooms: UserRoomSummary[];
  next_cursor: string | null;
}
```

## 错误口径

- `400 invalid_json`：请求体不是合法 JSON。
- `400 invalid_display_name`：展示名为空或超过 64 字符。
- `400 invalid_pagination`：分页参数非法，`limit` 必须在 `1..50`，`cursor` 必须是合法游标。
- `400 invalid_oauth_state`：Google OAuth state 缺失、过期或不匹配。
- `400 oauth_exchange_failed`：Google code 换 token 失败。
- `400 invalid_wallet_address`：钱包地址格式非法。
- `400 unsupported_chain_id`：钱包网络不是 Monad Mainnet 或 Monad Testnet。
- `400 wallet_chain_mismatch`：verify 请求的 chain id 与 challenge 记录不一致。
- `400 challenge_not_found`：钱包 challenge 不存在或已消费。
- `400 challenge_expired`：钱包 challenge 已过期。
- `401 unauthenticated`：需要登录。
- `401 invalid_google_token`：Google ID token 校验失败。
- `401 invalid_wallet_signature`：钱包签名校验失败。
- `409 identity_already_bound`：第三方身份已绑定其他用户。
- `429 rate_limited`：触发限流。
- `500 config_error`：登录相关生产配置缺失。
- `500 internal_error`：未预期错误。

## 强制执行顺序

1. 完成本文档 review，确认 Google OAuth 与 Web3 登录范围。
2. 新增 `migrations/0002_user_management.sql`，只包含用户、身份、session、challenge、rooms 用户关联字段。
3. 用户人工执行本地迁移，确认 `SHOW SERVER_ENCODING = UTF8`。
4. 重新读取最新 schema 和 store 代码。
5. 更新 `packages/shared` 用户与登录协议类型。
6. 实现 Worker session 解析和 auth store。
7. 实现 Google OAuth start/callback。
8. 实现 wallet challenge/verify。
9. 改造创建房间逻辑，登录时写入 `rooms.created_by_user_id`。
10. 实现 `GET /api/me`、`POST /api/auth/logout`、`GET /api/me/rooms`。
11. 实现 Web 登录 UI。
12. 在 docker-compose 中补充本地 auth 配置占位。
13. 通过容器内 typecheck/test。
14. 生产部署前配置 Vercel、Cloudflare Worker secrets、Google OAuth redirect URI、Neon 迁移。

## Review 结论

用户登录模块适合独立成新规格，不应该直接混入棋局合法性规则。

原因：

- 棋局防篡改已经由 `participant_token`、版本号、Durable Object 串行和棋规校验保证。
- 用户登录解决的是 Web 产品身份、房间归属、个人列表和后续用户体验。
- Google OAuth 与 Web3 钱包登录都需要独立表、会话和错误口径，和现有房间参与者模型职责不同。
- 第一阶段保持“登录用户”和“房间参与者”解耦，可以避免影响 MCP Agent 流程。

## 验收口径

- 未登录用户仍可创建匿名房间，现有 Agent vs Agent 流程不回归。
- 用户可通过 Google 登录，刷新页面后 `GET /api/me` 仍能返回当前用户。
- 用户可通过 EVM 钱包签名登录，签名不可重放，challenge 只能消费一次。
- Google OAuth state 和 PKCE code verifier 有落库记录，callback 后 state 只能消费一次。
- 同一个 Google 账号重复登录不会创建多个用户。
- 同一个钱包地址重复登录不会创建多个用户。
- 已登录用户创建房间后，`rooms.created_by_user_id` 正确落表。
- `GET /api/me/rooms` 只返回当前用户创建的房间。
- 退出登录后 Cookie 清空，session 标记 revoked。
- 缺少 Google secret、redirect URI 等配置时返回 `500 config_error`。
- 跨域用户 API 响应带 credentials CORS 头，前端 `credentials: 'include'` 可正常读取 `GET /api/me`。
- 本地和生产数据库编码仍为 UTF-8。

## 待确认项

无。

## 本轮不做

- 邮箱密码登录。
- 手机号登录。
- Passkey / WebAuthn。
- 用户资料编辑。
- 用户手动修改 `display_name`。第一阶段只预留字段，不提供修改 API。
- 用户删除账号。
- 钱包交易签名或链上资产读取。
- 房间参与者关联登录用户，以及“查看自己参与过的房间”。
- MCP adapter 用户登录。
- 用登录态替代 `participant_token` 提交走法。
