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
- カレンダーから各日の勤務を直感的に補録・修正
- ユーザーごとの既定出退勤時刻と通勤設定（出発地、到着地、鉄道／バス／タクシー／その他、片道運賃、片道／往復）
- 通勤情報を日ごとのスナップショットとして保存し、既定値の変更後も過去記録を維持
- ログイン名とは別に、画面表示と Excel に使う氏名を変更可能
- 月次カレンダー・実働時間・交通費の集計
- ブラウザ内で 3 シート構成の月次 Excel（`.xlsx`）を生成（勤怠表、月次集計、交通費明細）

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
├── migrations/
│   └── 0001_schema.sql   # D1 2.0 最終スキーマ（単一ファイル）
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
3. D1 `edge-kintai-db-v2` の作成 or 再利用
4. `wrangler.jsonc` の `database_id` 置換（全ゼロ placeholder の場合のみ）
5. `0001_schema.sql` の適用
6. `SETUP_TOKEN` の生成・アップロード（初回のみ）
7. デプロイ

同じ 2.0 D1 に対する再実行は安全です。適用済みの最終スキーマは再実行されず、Worker と Static Assets だけが更新されます。

> **2.0 は破壊的メジャーアップデートです。** `migrations/` は新規環境向けの `0001_schema.sql` だけに整理しました。1.x の Demo D1 とそのマイグレーション履歴を引き継ぐアップグレード処理はありません。デプロイヘルパーは旧 `edge-kintai-db` を変更せず、2.0 専用の `edge-kintai-db-v2` を作成します。必要なら旧 D1 を先にエクスポートし、2.0 の動作確認後に削除してください。

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
npm run verify          # 型チェック + テスト + デプロイ設定チェック
npm run deploy:dry-run  # wrangler deploy のドライラン
```

### 設定

`wrangler.jsonc` の環境変数：

| 変数 | デフォルト | 説明 |
|---|---:|---|
| `DEFAULT_BREAK_MINUTES` | `60` | 休憩時間（分） |
| `DEFAULT_ONE_WAY_FARE` | `210` | 片道交通費のデフォルト（円） |
| `DEFAULT_TRIP_TYPE` | `round_trip` | `one_way` or `round_trip` |
| `DEFAULT_CLOCK_IN` | `10:00` | ユーザー未設定時の出勤時刻 |
| `DEFAULT_CLOCK_OUT` | `19:00` | ユーザー未設定時の退勤時刻 |
| `OVERTIME_THRESHOLD_HOURS` | `180` | 月次残業アラートの閾値（時間） |
| `SESSION_TTL_SECONDS` | `604800` | セッション有効期間（秒、デフォルト 7 日） |

ユーザーごとの設定が優先されます。日ごとの勤務・時刻・通勤経路・交通費は勤務カレンダーから個別に変更できます。ログイン名は認証用の不変 ID で、プロフィールの「氏名（Excel 表示名）」は独立して変更できます。Excel のファイル名は `勤怠表_<氏名>_YYYYMM.xlsx` です。

### 注意事項

- **Free プラン適合**: 個人〜小規模チーム用途を想定しています。Static Assets は無料・無制限で、`/api/*` のみ Workers の 10 万リクエスト／日・CPU 10ms／回の対象です。D1 Free は 500MB／DB、読み取り 500 万行／日、書き込み 10 万行／日（アカウント全体の保存枠 5GB）です。通常の勤怠件数には十分ですが、認証や祝日更新は CPU 上限に近づく可能性があるため、公開後は Metrics の Error 1102 と D1 Row Metrics を確認してください。
- **セキュリティ**: Cookie は `HttpOnly; Secure; SameSite=Strict`、パスワードは PBKDF2-SHA-256 でハッシュ保存。セッション token は SHA-256 ダイジェストのみ D1 に保存し、パスワード変更・管理者権限変更時は旧セッションを無効化します。
- **プライバシー**: R2 は使用しません。氏名・駅名・勤務記録は D1 と、利用者が端末へダウンロードした Excel にのみ保存されます。Excel にはログイン名を出力しません。
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
- 直接从日历补录或修改每天的记录
- 每个用户可设置默认上下班时间和通勤信息（出发地、到达地、轨道交通／公交／打车／其他、单程票价、单程／往复）
- 每天保存独立的通勤快照，之后修改默认路线不会影响历史月份
- 登录名与页面/Excel 显示姓名分离，显示姓名可随时修改
- 月度日历、实働时间、交通费汇总
- 浏览器内生成三张工作表的月度 Excel（勤怠表、月次集计、交通费明细）

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
├── migrations/
│   └── 0001_schema.sql   # D1 2.0 最终结构（单一文件）
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

`deploy:cf` 会依次执行：verify → Wrangler 登录检查 → 创建/复用 `edge-kintai-db-v2` → 替换 `database_id`（仅全零 placeholder 时）→ 应用 `0001_schema.sql` → 生成 `SETUP_TOKEN`（首次）→ 部署。

对同一个 2.0 D1 重复运行是安全的：已经应用的最终结构不会重复执行，只更新 Worker 和 Static Assets。

> **2.0 是破坏性大版本。** `migrations/` 已精简为只面向全新环境的 `0001_schema.sql`。项目不提供 1.x Demo D1 或旧迁移历史的升级转换。部署助手不会修改旧 `edge-kintai-db`，而是创建 2.0 专用的 `edge-kintai-db-v2`；需要时先导出旧 D1，确认 2.0 正常后再删除旧库。

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
npm run verify          # 类型检查 + 测试 + 部署配置检查
npm run deploy:dry-run  # wrangler deploy 的 dry-run
```

### 配置

`wrangler.jsonc` 环境变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `DEFAULT_BREAK_MINUTES` | `60` | 默认休憩分钟 |
| `DEFAULT_ONE_WAY_FARE` | `210` | 默认片道交通费（日元） |
| `DEFAULT_TRIP_TYPE` | `round_trip` | `one_way` 或 `round_trip` |
| `DEFAULT_CLOCK_IN` | `10:00` | 用户未设置时的默认出勤时间 |
| `DEFAULT_CLOCK_OUT` | `19:00` | 用户未设置时的默认退勤时间 |
| `OVERTIME_THRESHOLD_HOURS` | `180` | 月度残业提醒阈值（小时） |
| `SESSION_TTL_SECONDS` | `604800` | 会话有效期（秒，默认 7 天） |

用户个人设置优先于全局默认。每天的勤務、时间、通勤路线和交通费都可以从勤務日历单独修改。登录名是不可修改的认证 ID；个人资料中的“氏名（Excel 显示名）”与它相互独立，导出文件名为 `勤怠表_<氏名>_YYYYMM.xlsx`。

### 注意事项

- **Free 计划**：适合个人或小团队。Static Assets 免费且不限请求量，只有 `/api/*` 计入 Workers 的 10 万请求/日和 10ms CPU/次；D1 Free 为每库 500MB、500 万行读取/日、10 万行写入/日（账户总存储 5GB）。一般勤怠量远低于这些配额，但认证和节假日刷新可能接近 CPU 上限，上线后请观察 Metrics 的 Error 1102 和 D1 Row Metrics。
- **安全**：Cookie 用 `HttpOnly; Secure; SameSite=Strict`，密码 PBKDF2-SHA-256 哈希存储，会话 token 只保存 SHA-256 摘要；修改密码或管理员权限后旧会话会失效。
- **隐私**：不使用 R2。姓名、车站和勤怠记录只写入 D1，以及用户主动下载到设备的 Excel；Excel 不输出登录名。
- **`SETUP_TOKEN`**：初始管理员的一次性认证凭据，必须以 Cloudflare Secret 保存，不要硬编码。
- **备份**：D1 Free 有 7 天 Time Travel，但公司提交用的数据建议另外备份。

---

## License

[MIT](./LICENSE)
