# femtocms 設計書

- 日付: 2026-11-26
- 状態: 承認済み（2026-11-26）
- 表記: 【判断】= 会話で決まっていない点を設計者が決めたもの。異論があれば変更可。

## 1. 何を作るか・なぜ

**femtocms** は「画面のない CMS」。管理画面を持たず、**MCP（AI）・CLI・HTTP API** の3つの入り口だけで操作する。

- `npx femtocms init` の1コマンドで、利用者自身の Cloudflare アカウント上に CMS が立ち上がる。
- microCMS 互換は目指さない。microCMS より **シンプルで、AI から扱いやすく、導入が簡単** であることを目指す。
- GitHub で public に公開し、npm でも配布する OSS。誰でも簡単に導入できることが前提。
- 名前の由来: nano より2段小さい SI 接頭辞 femto（10⁻¹⁵）。npm の `nanocms` は既に使用済みのため。

### 最初の利用シーン

シンプルな LP（ランディングページ）に「お知らせ（ニュース）」欄を埋め込む。
AI に「ニュースを1本書いて公開して」と頼むと、LP に反映される、という体験が最初のゴール。

## 2. ゴール / 非ゴール / アンチゴール

### ゴール
- `npx femtocms init` だけで、Cloudflare 上にデプロイ済みの CMS・API キー・MCP の URL が手に入る。唯一の例外は R2 の初回有効化（下の「制約」参照）で、これは init が案内する。
- ニュースに限らず、**任意のスキーマ（コレクション）** を定義して使える。
- MCP / CLI / API のどれから操作しても、**できることと挙動が同じ**。キー管理・export/import・全削除のような管理系の操作も、AI（MCP）から行える（利用者の決定）。
- AI がスキーマを自分で調べ、正しい形のデータを書けること。間違えたら、直し方が分かるエラーが返ること。
- LP に **数行の HTML を貼るだけ** でニュース一覧を出せること。
- Cloudflare の **無料枠** の範囲で動くこと。

### 非ゴール（v1 ではやらない）
- 管理画面（編集用の Web UI）。
- microCMS の API 互換。
- 1つのデプロイで複数のサイトを管理する機能（マルチテナント）。1サイト = 1デプロイ。
- 多言語、予約公開、全文検索、Webhook、ユーザー/権限の細かい管理、変更履歴。将来の拡張候補として API 設計を邪魔しない形にだけしておく。
- femtocms 運営側がホストする SaaS 版。

### アンチゴール（動いても失敗とみなすもの）
- 導入に Cloudflare ダッシュボードでの手作業が必要になる（R2 の初回有効化だけは避けられないので、init が URL を示して案内し、終わるまで待つ）。
- MCP ではできるが CLI ではできない、といった入り口ごとの差が出る。
- AI がスキーマに合わないデータを保存できてしまう。
- 有料プランが前提の機能に依存する（例: Cloudflare Images の変換）。

## 3. 制約
- 実行基盤: Cloudflare Workers + D1 + R2（会話で決定: 案A）。
- 配布: npm パッケージ `femtocms`（空きを確認済み）、GitHub public リポジトリ。
- 利用者の環境: Node.js 22.12 以上【判断】（同梱する wrangler が 22.12 以上を要求するため。当初は 20 以上としていた）。Cloudflare アカウント（無料で可）。
- **R2 の初回有効化**: R2 は無料枠で使う場合でも、最初に一度ダッシュボードで有効にし、支払い方法を登録する必要がある（API では行えない）。利用者の決定により **R2 は必須** とする。init は R2 が使えるかを確認し、使えなければダッシュボードの URL と手順を示して、有効になるまで待つ（再確認する）。
- `*.workers.dev` では Workers の Cache API が効かない。既定の URL は workers.dev とし、独自ドメインは任意（7章 キャッシュ）。
- ローカルのフォルダ名は `nanocms` だが、成果物の名前はすべて `femtocms`。

## 4. アプローチ（検討した案）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A（採用）** | Worker 1本 + D1 + R2 | Cloudflare の標準構成で init を全部自動化しやすい。D1 は wrangler で中身を見られ、バックアップ・移行が楽 | init で D1/R2 を作る分、手順が少し長い（1回だけ） |
| B | Worker 1本 + Durable Object 内の SQLite | 作るものが Worker だけで設定が最小 | 外からデータを覗く・バックアップするのが面倒。将来の拡張が独特 |
| C | GitHub リポジトリに Markdown で保存 | 変更履歴が無料で残る | GitHub 必須、公開に時間差、「1コマンド」「シンプル」に反する |

利用者が A を選んだ。理由: シンプルさと1コマンド導入を一番素直に実現でき、ニュース数件程度の用途なら速度も十分。

## 5. 全体構成

```
利用者の PC                          利用者の Cloudflare アカウント
┌──────────────┐                ┌────────────────────────────────┐
│ femtocms CLI │── HTTPS ──────▶│ Worker "femtocms"              │
└──────────────┘   (API)        │  ├ /api/...   HTTP API         │
┌──────────────┐                │  ├ /mcp       MCP サーバ        │
│ Claude 等    │── HTTPS ──────▶│  ├ /media/... 画像配信          │
└──────────────┘   (MCP)        │  ├ /embed.js  LP 埋め込み       │
┌──────────────┐                │  └ /preview/  下書きプレビュー   │
│ LP (ブラウザ) │── HTTPS ──────▶│        │            │          │
└──────────────┘   (API/embed)  │       D1           R2          │
                                └────────────────────────────────┘
```

- **中核は1つの「操作層」**（コレクション・エントリ・メディアの作成/取得/更新/削除と検証）。HTTP API と MCP はどちらもこの操作層を呼ぶだけの薄い入り口。CLI は HTTP API を呼ぶ。これで3つの入り口の挙動が一致する。
- MCP は Worker 自身が提供する（リモート MCP、Streamable HTTP）。利用者は URL とキーを AI クライアントに登録するだけ。ローカルへのインストールは不要。

### パッケージ構成【判断】
npm パッケージは `femtocms` の1つだけ。中身は次のとおり。
- CLI（`bin: femtocms`）
- Worker のソース（ビルド済み）と D1 マイグレーション。init/upgrade のときに、これをそのまま利用者のアカウントへデプロイする。

リポジトリの中は、作りやすいように分けてよい（例: `packages/worker`, `packages/cli`）。分け方は実装者に任せる。

## 6. データモデル

### コレクション（スキーマ）
コンテンツの「種類」。例: `news`, `works`, `faq`, `site`。

- `name`: 識別子（英小文字・数字・ハイフン。例 `news`）
- `label`: 表示名（例「お知らせ」）
- `description`: このコレクションは何のためのものか。**AI が読む前提の説明**
- `kind`: `list`（複数件。ニュースなど）または `single`（1件だけ。サイト設定、LP の文言など）
- `fields`: フィールド定義の配列
- `public`: 公開済みエントリを、キーなしで読めるかどうか（初期値 `true`）【判断】

### フィールド型（v1）【判断】
| 型 | 内容 | 主なオプション |
|---|---|---|
| `text` | 1行テキスト | `maxLength` |
| `textarea` | 複数行のプレーンテキスト | `maxLength` |
| `markdown` | Markdown 本文。API では原文と HTML の両方を返せる | — |
| `number` | 数値 | `min`, `max`, `integer` |
| `boolean` | 真偽 | — |
| `datetime` | ISO 8601 日時 | — |
| `select` | 選択肢から1つまたは複数 | `options`, `multiple` |
| `image` | R2 上のメディアへの参照。API では URL・幅・高さ・alt を返す | `multiple` |
| `reference` | 他コレクションのエントリへの参照 | `collection`, `multiple` |
| `list` | 同じ形の小さな項目の繰り返し（例: FAQ の Q&A、料金表の行） | `fields`（入れ子は1段まで） |
| `json` | 自由な JSON（逃げ道） | — |

全フィールド共通: `name`, `label`, `description`（AI 向けの説明）, `required`, `default`。

### エントリ
- `id`: 自動生成。URL などに使える `slug` を任意で付けられ、取得は id・slug のどちらでもできる。
- `status`: `draft` / `published`
- `data`: フィールドの値（JSON）
- `createdAt`, `updatedAt`, `publishedAt`
- **書き込みのたびにスキーマで検証する。** 失敗したら、どのフィールドがなぜダメか、正しい形は何かを、構造化されたエラーで返す（AI が自分で直せるように）。

### スキーマ変更時の扱い【判断】
- フィールドの追加: 既存エントリでは値なしになる（`default` があればそれを使う）。
- フィールドの削除: 保存済みデータは残すが、API からは返さない。
- 型の変更・名前の変更: v1 では「削除 + 追加」として扱う。データを自動で変換はしない。
- 既存エントリが新しいスキーマに合わなくなっても、読み出しは止めない。次に書き込むときに検証される。

### ゴミ箱（利用者の決定：うっかり削除の防止）
- **削除はすべて「ゴミ箱へ移す」**。対象はエントリ・メディア・コレクション（コレクションを削除すると、その中のエントリもまとめてゴミ箱に入る）。
- ゴミ箱の中身は API・埋め込み・プレビューのどこにも出ない。ゴミ箱に入ったエントリを参照しているフィールドは `null` を返し、ゴミ箱の画像は配信しない（404）。
- **復元**できる。復元すると、元の状態（下書き・公開）に戻る。
- **ゴミ箱を空にする**と、本当に消える（D1 の行と R2 のファイルを削除）。これはサイト名の入力を求める確認つきの別操作。特定の項目だけ完全に削除することもできる。
- ゴミ箱の中身は、空にするまで残る（自動では消さない）【判断】。
- ゴミ箱にある間は、そのエントリの slug は他のエントリに使えない（復元できるように）【判断】。
- 全データ削除（`reset`）も、全部をゴミ箱に移すだけ。完全に消すには続けてゴミ箱を空にする。
- API キーの無効化は、安全のため即時に行い、ゴミ箱には入れない【判断】。

### 保存方法【判断】
D1 にテーブル `collections`, `entries`, `media`, `api_keys` を作る。ゴミ箱は、各テーブルの `deleted_at` 列で表す。エントリの値は JSON の列に入れ、絞り込みには SQLite の `json_extract` を使う。コレクションを増やしてもテーブル構造は変わらない（＝スキーマ変更で DB のマイグレーションが要らない）。

## 7. HTTP API

ベース: `https://<worker>/api`。応答は JSON。**API の仕様は OpenAPI として `/api/openapi.json` で配信し、コレクションの定義から自動で生成する**（AI やツールがそのまま読める）。

### 認証【判断】
- **管理キー**（`fcms_admin_...`）: すべての操作ができる。CLI と MCP が使う。`Authorization: Bearer` で送る。
- **読み取りキー**（任意）: `public: false` のコレクションを読む用。
- `public: true` のコレクションの **公開済み** エントリは、キーなしで読める（LP のブラウザから直接呼ぶため。ブラウザに置いたキーはどうせ見えてしまうので）。
- 下書きは管理キーか、期限付きのプレビュー用トークンがないと見えない。

### エンドポイント（概略）
- コレクション: `GET/POST /api/collections`, `GET/PATCH/DELETE /api/collections/:name`
- エントリ: `GET/POST /api/:collection`, `GET/PATCH/DELETE /api/:collection/:idOrSlug`
  - 公開/非公開: `POST /api/:collection/:id/publish`, `.../unpublish`
  - `single` のコレクションは `GET/PUT /api/:collection`
- メディア: `POST /api/media`（ファイル本体のアップロード、または URL を渡して取り込み）, `GET /api/media`, `DELETE /api/media/:id`
- 画像の配信: `GET /media/:id/:filename`（R2 から返し、長めにキャッシュする）

### 一覧の取得パラメータ【判断】
- `limit`（初期値 10、最大 100）, `offset`
- `sort`: 例 `-publishedAt`（先頭の `-` で降順）
- `filter`: 例 `filter[category]=info`, `filter[price][gte]=1000`（演算子は eq / ne / lt / lte / gt / gte / contains / in）
- `fields`: 返すフィールドを絞る
- `expand`: 参照先を展開する（1段まで）
- `status`: `draft` / `published` / `all`（管理キーがあるときだけ）
- 応答: `{ items: [...], total, limit, offset }`

- ゴミ箱: `GET /api/trash`, `POST /api/trash/:id/restore`, `DELETE /api/trash/:id`（1件を完全削除）, `DELETE /api/trash`（空にする）。上の各 `DELETE` は、ゴミ箱へ移す操作になる。
- 管理用（管理キー必須。CLI からも MCP からも使う）: `GET/POST/DELETE /api/keys`, `GET /api/export`, `POST /api/import`, `POST /api/reset`（全データをゴミ箱へ）
  - 最後の1本の管理キーは削除できない（AI が自分を締め出さないように）【判断】。
  - ゴミ箱を空にする操作・1件の完全削除・`reset`・`import`（既存データを上書きする場合）は、引数にサイト名を書かせて誤操作を防ぐ【判断】。

### メディアの URL【判断】
エントリには、メディアの URL ではなく **メディア id** を保存する。URL は応答を返すときに、そのリクエストのホスト名から組み立てる。こうしておけば、ドメインを変えたり別のデプロイに移したりしても、データを書き換えずに済む。

### CORS とキャッシュ【判断】
- 公開の読み出しは CORS を許可する。許可するオリジンは設定できる（初期値は全許可）。
- workers.dev（既定）: 公開の読み出しに `Cache-Control: public, max-age=60` と ETag を付けるだけにする。ニュース数件程度なら D1 から毎回読んでも十分速い。
- 独自ドメイン（`init --domain` で任意に設定）: さらに Cache API でエッジにもキャッシュする。キャッシュのキーにはコレクションごとの版番号を入れ、書き込みのたびに版番号を上げる。これで、キャッシュを消す API（purge）を使わずに古い内容を出さないようにできる。
- 画像（`/media/...`）は、id ごとに内容が変わらないので長期キャッシュ（`immutable`）にする。

### プレビュー【判断】
`/preview/:token` で、Worker がエントリの各フィールドを素の HTML で並べたページを返す（Markdown は HTML に変換し、画像も表示する）。LP の見た目は再現しない。トークンは期限付きで、MCP・CLI・API の `get_preview_url` / `preview` で発行する。同じトークンを `?preview=<token>` として API に付ければ、下書きを JSON で取得することもできる。

## 8. MCP

- URL: `https://<worker>/mcp`（Streamable HTTP）
- 認証: 管理キーを `Authorization: Bearer` で送る。利用者の決定により **v1 は キーのみ**。対象は Claude Code・Cursor・Codex など、ヘッダーを設定できるクライアント。Claude.ai（Web・デスクトップ）向けの OAuth は v2 で追加する。そのときに作り直しにならないよう、認証の処理は差し替えやすい形にしておく。
- 管理系のツールも出す（利用者の決定）: `create_key`, `list_keys`, `revoke_key`, `export_data`, `import_data`, `reset_site`。
  - `export_data` はスキーマ・エントリ・メディア情報を JSON で返す（画像は URL で返す）。`import_data` は同じ形の JSON を受け取り、画像は URL から取り込む。
  - 破壊的なツールには MCP の `destructiveHint` を付け、AI クライアント側で確認が出るようにする。
- ツール（操作層をそのまま出す）:
  - `list_collections`, `get_collection`（フィールド定義と説明を含む）, `create_collection`, `update_collection`, `delete_collection`
  - `list_entries`, `get_entry`, `create_entry`, `update_entry`, `delete_entry`, `publish_entry`, `unpublish_entry`
  - `upload_media`（URL から取り込み、または base64）, `list_media`
  - `get_preview_url`
  - ゴミ箱: `list_trash`, `restore_from_trash`, `delete_permanently`, `empty_trash`（`delete_*` 系のツールは、ゴミ箱へ移すだけであることを説明文に書く）
- ツールの説明文は「AI が読んで迷わない」ことを最優先に書く。たとえば `create_entry` の説明には「先に `get_collection` でフィールドを確認すること」と書く。
- 削除系のツールには、確認が必要な操作であることを示す注釈を付ける。

## 9. CLI

`npx femtocms <command>`。どのコマンドも `--json` を付けると機械が読める形で出力する（AI やスクリプトから使うため）。

### 導入・運用
- `init`: 対話形式で以下をすべて自動で行う。
  1. Cloudflare にログイン（wrangler の OAuth を使う。済んでいれば省略）
  2. D1 データベースと R2 バケットを作る（R2 が未有効なら、案内を出して有効になるまで待つ）
  3. Worker をデプロイし、D1 マイグレーションを流す
  4. 管理キーを生成する（サーバ側にはハッシュだけを保存する）
  5. 接続情報をローカルに保存する
  6. 最後に「API の URL・管理キー・MCP の URL・Claude Code に登録するコマンド・LP に貼る埋め込みコード」を表示する
  - オプション: `--name`（Worker 名。初期値 `femtocms`）。同じアカウントに複数サイトを置ける。`--domain`（任意。Cloudflare に登録済みのドメインのサブドメインを Worker に割り当てる）。
  - 実行し直しても壊れない（既にあるリソースは再利用する）。
- `upgrade`: 新しい版の Worker を再デプロイし、マイグレーションを流す（`npx femtocms@latest upgrade`）。
- `login` / `logout`: 既存のサイトの URL とキーを、このマシンに登録する／消す。
- `keys create|list|revoke`: API キーを管理する。
- `export` / `import`: バックアップと移行用【判断】。`export` は、フォルダ（`data.json` にスキーマ・エントリ・メディア情報、`media/` に画像ファイル本体）を書き出す。`import` は、それを別のデプロイにも読み込める。画像は1枚ずつアップロードし直す。メディアは id で参照しているので、URL の書き換えは要らない。
- `destroy`: Worker・D1・R2 という Cloudflare 上の入れ物ごと削除する（強い確認あり）。動いている CMS 自身は Cloudflare アカウントを操作する権限を持たないため、これは CLI だけが行える（API は使わず wrangler を直接呼ぶ）。Claude Code のように AI がコマンドを実行できる環境なら、AI がこのコマンドを使えばよい【判断】。

### コンテンツ操作
- `collections list|get|create|update|delete`（`create` はフラグ指定でも JSON/YAML ファイル指定でもよい）
- `entries list|get|create|update|delete|publish|unpublish <collection> ...`（本文は `--file post.md` で渡せる）
- `media upload <file>` / `media list`
- `preview <collection> <id>`
- `trash list|restore|delete|empty`

### 接続情報の保存先【判断】
`~/.config/femtocms/config.json`。複数のサイトを「プロファイル」として持てる。カレントディレクトリに `femtocms.json` があれば、そちらを優先する。キーは環境変数 `FEMTOCMS_URL` / `FEMTOCMS_KEY` でも渡せる（CI 用）。

## 10. LP への埋め込み

最初の利用シーンのための機能。2通り用意する。

1. **貼るだけ（JS 埋め込み）**【判断】
   ```html
   <div data-femtocms="news" data-limit="5"></div>
   <script src="https://<worker>/embed.js" defer></script>
   ```
   公開済みエントリの一覧を、素の HTML（`<ul>` とクラス名）で描画する。見た目は最小限のデフォルト CSS だけにし、クラス名で上書きできるようにする。表示する項目（タイトル・日付など）は data 属性で指定する。
   - クリックしたときのリンク先【判断】: 既定ではリンクしない。`data-href="news.html?slug={slug}"` のように URL の型を書けば、各項目がそのページへリンクする。femtocms が記事ページそのものを配信することはしない。
   - 記事ページ（利用者の決定、2026-11-26 追加）: 利用者のページに `<div data-femtocms-entry="news">` と embed.js を貼ると、URL の `?slug=` の公開記事（タイトル・日付・Markdown 本文）を描画する。ページ URL の `preview` トークンは API に渡し、下書きを実際のデザインで確認できる。
   - テンプレート（利用者の決定、2026-11-27 追加）: 一覧・記事ページとも、中に `<template>` を置くと標準の表示のかわりに記事ごとに複製して描画する。`data-field`（値を文字として入れる。img・time・Markdown は専用の扱い）、`data-if`、`data-class`、`data-href`、`<template data-each>`（list 型・複数の画像や参照の繰り返し）。`author.name` のように参照の先を書くと `expand` を自動で付ける（記事の直下の参照だけ）。ページ送りも同じ規則で、`<template data-pager>` があれば標準のかわりに使う（`data-page`・`data-more`）。記事ページの前後の記事（`data-prevnext` / `<template data-prevnext>`、prev = 公開日が1つ前、next = 1つ後）、空・エラーの表示（`<template data-empty>` / `<template data-error>`）、一覧の `data-sort`、slug なしの `single` コレクション表示も同じ規則で扱う（2026-11-27 追加）。
2. **自分で取得**: `fetch("https://<worker>/api/news?limit=5")`。README に、そのままコピペで使える例を載せる。

## 11. 将来の拡張（v2 以降の候補）
- MCP の OAuth 対応（Claude.ai の Web・デスクトップから使えるようにする）
- 多言語、予約公開、全文検索、Webhook、変更履歴
- 見るだけの簡単な画面（一覧とプレビュー）

## 12. 実装者に任せること
- 内部のライブラリ選び（ルーティング、MCP の実装方法、バリデーション、Markdown → HTML の変換）。
- リポジトリの分け方、ビルド方法、テストの基盤。
- キャッシュを無効にする具体的な方法。
- エラーの JSON の細かい形（ただし、どのフィールドがなぜダメか・正しい形は何か、は必ず含めること）。
- README・ドキュメントの構成。ただし「init から LP 埋め込みまで5分」の手順を README の冒頭に置くこと。

## 13. 公開
- GitHub の public リポジトリ `femtocms`。ライセンスは MIT【判断】。
- npm パッケージ `femtocms`。リリースは GitHub Actions からタグを打って行う【判断】。
