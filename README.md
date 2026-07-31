# EdgeKintai

日本の勤怠を Cloudflare Workers + D1 だけで動かす、多ユーザー対応の出退勤管理ツール。  
面向日本工作场景的多用户勤怠管理，跑在 Cloudflare Workers + D1 上，Free 计划即可使用。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/EdgeKintai)

---

## 日本語 | [中文](#中文说明)

### 概要

EdgeKintai は Cloudflare Workers 上で動作する勤怠管理ツールです。バックエンドは Hono + D1、フロントエンドはブラウザ側の静的ファイル（Static Assets）で構成されています。Excel 出力もブラウザ内で完結するため、R2 や外部ストレージは使いません。

主な機能：

- 管理者／一般ユーザーの権限管理
- 出勤・退勤・在宅・有給休暇・休日・欠勤の記録
- 土日・祝日の自動判定（[内閣府の祝日 CSV](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html) を週次で取得・キャッシュ）
- 交通費の管理（片道金額で入力、片道・往復を選択）
- 月次カレンダー・実働時間・交通費の集計
- ブラウザ内での月次 Excel（`.xlsx`）生成・ダウンロード

### プロジェクト構成

```
EdgeKintai/
├── src/                  # Worker (Hono API)
│   ├── index.ts          #   エントリーポイント・Cron ハンドラ
│   ├── routes/           #   API ルート (auth, attendance, admin, export)
│   ├── middleware/        #   認証・管理者ガード
│   └── utils/            #   パスワード, 祝日, バリデーション等
├── public/               # Static Assets（Worker を経由しない）
│   ├── index.html        #   SPA
│   ├── app.js            #   フロントエンドロジック
│   ├── excel.js           #   ブラウザ内 Excel 生成
│   └── styles.css
├── migrations/           # D1 マイグレーション
├── scripts/              # デプロイヘルパー・Excel テスト
├── test/                 # Vitest テスト
├── wrangler.jsonc        # Workers 設定
└── package.json
```

`wrangler.jsonc` の `run_worker_first: ["/api/*"]` により、`/api/*` だけが Worker を通過します。それ以外は Static Assets が直接返すので、Workers Free の動的リクエスト枠を節約できます。

### デプロイ

#### 方法 A：ワンクリックデプロイ

ページ上部のボタンをクリックすると、Cloudflare がリポジトリをフォークして Workers Builds を構成し、D1 も自動作成します。

途中で `SETUP_TOKEN` を求められたら、ターミナルで生成した値を入力してください：

```bash
openssl rand -hex 32
```

この値はコードや Issue には書かず、Cloudflare の暗号化 Secret としてのみ保存してください。

#### 方法 B：ローカルデプロイ

Node.js 24.11+ が必要です。

```bash
npm ci
npm run deploy:cf
```

`deploy:cf` は次の処理を順番に実行します：

1. `verify`（型チェック・テスト）
2. Wrangler ログイン確認
3. D1 `edge-kintai-db` の作成 or 再利用
4. `wrangler.jsonc` の `database_id` 置換（全ゼロ placeholder の場合のみ）
5. 未適用マイグレーションの実行
6. `SETUP_TOKEN` の生成・アップロード（初回のみ）
7. デプロイ

再実行しても安全です。新しいマイグレーションの適用と新バージョンの発行だけを行います。

#### Workers Builds の手動設定

GitHub リポジトリを手動で Workers Builds に接続する場合：

| 設定 | 値 |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Build variable | `NODE_VERSION=24.11.0` |

初回ビルド前に、`database_id` が全ゼロでないことと、Worker の Secrets に `SETUP_TOKEN` が設定されていることを確認してください。

### ローカル開発

```bash
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars の SETUP_TOKEN を openssl rand -hex 32 の出力で置き換える
npm run db:migrate:local
npm run dev
```

`http://localhost:8787` を開くと初期設定画面が表示されます。最初のユーザーが管理者として作成されます。

検証コマンド：

```bash
npm run verify          # 型チェック + テスト + デプロイ dry-run チェック
npm run deploy:dry-run  # wrangler deploy のドライラン
```

### 設定

`wrangler.jsonc` の環境変数：

| 変数 | デフォルト | 説明 |
|---|---:|---|
| `DEFAULT_BREAK_MINUTES` | `60` | 休憩時間（分） |
| `DEFAULT_ONE_WAY_FARE` | `210` | 片道交通費のデフォルト（円） |
| `DEFAULT_TRIP_TYPE` | `round_trip` | `one_way` or `round_trip` |
| `OVERTIME_THRESHOLD_HOURS` | `180` | 月次残業アラートの閾値（時間） |
| `SESSION_TTL_SECONDS` | `604800` | セッション有効期間（秒、デフォルト 7 日） |

ユーザーごとの交通費設定が優先されます。日ごとの記録も個別に変更可能です。

### 注意事項

- **Free プラン適合**: Workers Free（動的リクエスト 10 万/日、CPU 10ms/回）で動作しますが、大人数での利用は Cloudflare ダッシュボードで CPU 使用量を確認してください。
- **セキュリティ**: Cookie は `HttpOnly; Secure; SameSite=Strict`、パスワードは PBKDF2-SHA-256 でハッシュ保存。セッション token は SHA-256 ダイジェストのみ D1 に保存。
- **`SETUP_TOKEN`**: 初回管理者作成用のワンタイム認証情報です。Cloudflare Secret として保存し、コードにハードコードしないでください。
- **バックアップ**: D1 Free は 7 日間の Time Travel がありますが、会社提出用データは別途バックアップを推奨します。

---

## 中文说明

### 概要

EdgeKintai 是跑在 Cloudflare Workers 上的勤怠管理工具。后端用 Hono + D1，前端是纯静态文件（Static Assets），Excel 在浏览器里生成，不需要 R2 或其他存储。

主要功能：

- 管理员 / 普通用户权限
- 出勤、退勤、在宅、有给休假、休日、缺勤记录
- 自动识别周末和日本法定节假日（[内阁府 CSV](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)，每周刷新缓存）
- 交通费管理（按片道金额输入，选择片道或往復）
- 月度日历、实働时间、交通费汇总
- 浏览器内生成月度 Excel（`.xlsx`）

### 项目结构

```
EdgeKintai/
├── src/                  # Worker（Hono API）
│   ├── index.ts          #   入口 + Cron 处理
│   ├── routes/           #   API 路由（auth, attendance, admin, export）
│   ├── middleware/        #   认证、管理员守卫
│   └── utils/            #   密码、节假日、校验等
├── public/               # 静态资源（不经过 Worker）
│   ├── index.html        #   SPA 页面
│   ├── app.js            #   前端逻辑
│   ├── excel.js          #   浏览器端 Excel 生成
│   └── styles.css
├── migrations/           # D1 迁移文件
├── scripts/              # 部署助手、Excel 测试脚本
├── test/                 # Vitest 测试
├── wrangler.jsonc        # Workers 配置
└── package.json
```

`wrangler.jsonc` 里 `run_worker_first: ["/api/*"]` 让只有 API 请求走 Worker，其他静态文件直接返回，不消耗 Workers Free 的动态请求额度。

### 部署

#### 方式 A：一键部署

点页面顶部的按钮，Cloudflare 会 fork 仓库、配置 Workers Builds、自动创建 D1。

过程中需要填 `SETUP_TOKEN`，用终端生成一个随机值：

```bash
openssl rand -hex 32
```

这个值只填到 Cloudflare 的加密 Secret 里，不要写进代码或提交记录。

#### 方式 B：本地部署

需要 Node.js 24.11+。

```bash
npm ci
npm run deploy:cf
```

`deploy:cf` 会依次执行：verify → Wrangler 登录检查 → 创建/复用 D1 → 替换 `database_id`（仅全零 placeholder 时）→ 跑迁移 → 生成 `SETUP_TOKEN`（首次）→ 部署。

重复运行是安全的，只会应用新迁移和发布新版本。

#### Workers Builds 手动配置

| 设置 | 值 |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Build variable | `NODE_VERSION=24.11.0` |

首次 Build 前确认 `database_id` 不是全零，且 Worker Secrets 里有 `SETUP_TOKEN`。

### 本地开发

```bash
npm ci
cp .dev.vars.example .dev.vars
# 把 .dev.vars 里的 SETUP_TOKEN 换成 openssl rand -hex 32 的输出
npm run db:migrate:local
npm run dev
```

打开 `http://localhost:8787`，首次会看到初始设置页面，第一个用户自动成为管理员。

```bash
npm run verify          # 类型检查 + 测试 + 部署 dry-run 检查
npm run deploy:dry-run  # wrangler deploy 的 dry-run
```

### 配置

`wrangler.jsonc` 环境变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `DEFAULT_BREAK_MINUTES` | `60` | 默认休憩分钟 |
| `DEFAULT_ONE_WAY_FARE` | `210` | 默认片道交通费（日元） |
| `DEFAULT_TRIP_TYPE` | `round_trip` | `one_way` 或 `round_trip` |
| `OVERTIME_THRESHOLD_HOURS` | `180` | 月度残业提醒阈值（小时） |
| `SESSION_TTL_SECONDS` | `604800` | 会话有效期（秒，默认 7 天） |

用户个人交通费设置优先于全局默认，每天的记录也可以单独改。

### 注意事项

- **Free 计划**：Workers Free（动态请求 10 万/日，CPU 10ms/次）可以跑，但人多的话留意 Cloudflare 仪表板的 CPU 用量。
- **安全**：Cookie 用 `HttpOnly; Secure; SameSite=Strict`，密码 PBKDF2-SHA-256 哈希存储，会话 token 只保存 SHA-256 摘要。
- **`SETUP_TOKEN`**：初始管理员的一次性认证凭据，必须以 Cloudflare Secret 保存，不要硬编码。
- **备份**：D1 Free 有 7 天 Time Travel，但公司提交用的数据建议另外备份。

---

## License

[MIT](./LICENSE)
