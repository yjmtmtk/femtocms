# femtocms

[English (README.md)](README.md)

femtocms は、管理画面のない CMS です。**自分の Cloudflare アカウント**の Workers + D1 + R2 で動き、AI（MCP）、CLI、HTTP API から操作します。「news コレクションを作って、最初のお知らせを公開して」と頼めば AI が作業し、サイト側は2行の HTML か `fetch` で公開済みの内容を読みます。無料枠で動き、サーバの面倒を見る必要はありません。

## クイックスタート: 5分で LP にニュースを出す

1. **自分の Cloudflare アカウントにデプロイする。**

   ```sh
   npx femtocms init
   ```

   Cloudflare へのログイン（ブラウザが開きます）、D1 データベースと R2 バケットの作成、Worker のデプロイ、マイグレーションの適用、管理キーの作成までを自動で行い、必要な情報を表示します。何度実行しても安全です。

   > **事前の注意:** R2 は Cloudflare のダッシュボードで一度だけ有効にする必要があり、無料枠だけを使う場合でも支払い方法の登録を求められます（無料枠の範囲内であれば課金されません）。R2 が未有効なら、`init` がダッシュボードの URL を表示し、有効になるまで待ちます。

2. **Claude Code につなぐ。** `init` が表示した `claude mcp add ...` をそのまま実行します。次のような形です。

   ```sh
   claude mcp add --transport http femtocms https://femtocms.<サブドメイン>.workers.dev/mcp \
     --header "Authorization: Bearer fcms_admin_..."
   ```

   Cursor や Codex など、ヘッダーを設定できる MCP クライアントなら同じ方法でつなげます。管理キーが表示されるのはこの1回だけです。パスワード管理ツールなどに保存してください。

3. **Claude に頼む。**

   > news コレクションを作って、最初のお知らせを公開して。
   >
   > （英語でも頼めます: "Create a news collection and publish the first announcement."）

   Claude は既存のコレクションを確認し、`title` や `body` などのフィールドを持つ `news` を作り、エントリを書いて公開します。公開する前にプレビュー用のリンクを頼むこともできます。

4. **LP に2行貼る。**

   ```html
   <div data-femtocms="news" data-limit="5"></div>
   <script src="https://femtocms.<サブドメイン>.workers.dev/embed.js" defer></script>
   ```

   公開したお知らせが、日付とタイトルの素の `<ul>` リストとして表示されます。見た目は `fcms-*` のクラス名で変えられます（[埋め込み](#埋め込み)を参照）。

### 埋め込みを使わず `fetch` で取得する

公開コレクションの公開済みエントリは、キーなしで読めます（CORS 許可済み）。そのままコピペして使えます。

```html
<ul id="news"></ul>
<script>
  fetch("https://femtocms.<サブドメイン>.workers.dev/api/news?limit=5&sort=-publishedAt")
    .then((res) => res.json())
    .then(({ items }) => {
      const ul = document.getElementById("news");
      for (const item of items) {
        const li = document.createElement("li");
        li.textContent = `${new Date(item.publishedAt).toLocaleDateString()} ${item.data.title}`;
        ul.appendChild(li);
      }
    });
</script>
```

プレーンテキストのフィールドは、上のように `innerHTML` ではなく `textContent` で入れてください。Markdown フィールドは、原文が `data.<フィールド名>`、HTML が `html.<フィールド名>` に入って返ります（Markdown 内の生の HTML はエスケープされます）。

---

## 基本の考え方

### コレクション

コレクションは、コンテンツの種類です。例: `news`、`works`、`faq`、`site`。

| 項目 | 内容 |
|---|---|
| `name` | 識別子。英小文字・数字・ハイフン、先頭は英小文字、40 文字まで。作成後は変更できません。`collections`、`media`、`trash`、`keys`、`export`、`import`、`reset`、`openapi.json` は使えません。 |
| `label` | 表示名。 |
| `description` | このコレクションの用途。AI が読む前提で書きます（AI はコンテンツを書く前にこれを読みます）。 |
| `kind` | `list`（複数件。既定）か `single`（1件だけ。サイト設定や LP の文言など）。 |
| `public` | 公開済みエントリをキーなしで読めるかどうか（既定 `true`）。 |
| `fields` | フィールド定義の配列。 |

### フィールド

どのフィールドも `name`（英字で始まり、英数字とアンダースコア。`id`・`slug`・`status` は使えません）と `type` を持ち、任意で `label`、`description`（AI 向けの説明）、`required`、`default` を指定できます。

| 型 | 内容 | オプション |
|---|---|---|
| `text` | 1行テキスト | `maxLength` |
| `textarea` | 複数行のプレーンテキスト | `maxLength` |
| `markdown` | Markdown 本文。原文と HTML の両方で返る | なし |
| `number` | 数値 | `min`, `max`, `integer` |
| `boolean` | 真偽 | なし |
| `datetime` | ISO 8601 の日時 | なし |
| `select` | 選択肢から1つまたは複数 | `options`, `multiple` |
| `image` | アップロード済みメディアへの参照。読み出しでは `{ id, url, width, height, alt, mimeType }` | `multiple` |
| `reference` | 他コレクションのエントリへの参照（読み出しでは id。`expand` を付けるとエントリ本体。参照先が存在しないかゴミ箱にあれば `null`） | `collection`, `multiple` |
| `list` | 同じ形の小さな項目の繰り返し（FAQ の Q&A、料金表の行など）。入れ子は1段まで | `fields` |
| `json` | 自由な JSON（逃げ道） | なし |

スキーマを変えたとき: フィールドを追加すると、既存のエントリは値なし（`default` があればそれ）になります。フィールドを削除すると、保存済みのデータは残りますが API からは返りません。型や名前の変更は「削除 + 追加」として扱い、データは自動では変換されません。

### エントリ・下書き・公開

エントリは、`id`（`e_...`）、任意の `slug`、`status`（`draft` か `published`）、`data`（フィールドの値）、`createdAt`・`updatedAt`・`publishedAt` を持ちます。取得は id でも slug でもできます。

- 新しいエントリは**下書き**になります。型・長さ・範囲などは書き込みのたびに検証されるので、AI が下書きを少しずつ書き進められます。
- **`required` は公開するときに強制**されます（下書きの保存では強制されません）。足りないフィールドはエラーに一覧されます。
- フィールドに `null` を指定すると、その値を消します。
- 書き込みに失敗すると、`{ "error": { "code", "message", "issues": [{ "path", "message", "expected", "received" }], "hint" } }` という構造化されたエラーが返り、呼び出し側が自分で直せます。
- 下書きが見えるのは、管理キーか、期限付きのプレビュートークンを使ったときだけです（`preview` を参照）。

### ゴミ箱

削除はすべて**ゴミ箱へ移す**操作です（エントリ・メディア・コレクション）。コレクションを削除すると、その中のエントリもまとめてゴミ箱に入ります。ゴミ箱の中身は API・埋め込み・プレビューのどこにも出ません。参照先が存在しないかゴミ箱にある画像・参照フィールドは `null` を返し（`multiple` のフィールドでは配列から除かれます）、ゴミ箱の画像の URL は 404 になります。

- `trash restore <id>` で、元の状態（下書き・公開）のまま戻せます。
- `trash empty` と `trash delete <id>` は本当に消します（D1 の行と R2 のファイル）。確認のため**サイト名**の入力が必要です。ゴミ箱の中身は、空にするまで残ります。
- エントリがゴミ箱にある間、その slug は他のエントリに使えません（復元できるようにするためです）。

## CLI

`npx femtocms <コマンド>`。どのコマンドにも `--json`（機械が読める出力）と、保存済みのサイトを選ぶ `--profile <name>` を付けられます。

| コマンド | 内容 |
|---|---|
| `init [--name <name>] [--domain <host>] [--cors-origins <a,b>]` | 自分の Cloudflare アカウントに femtocms をデプロイし、接続情報を保存します。`--name`（既定 `femtocms`）は Worker・D1・R2・プロファイルの名前で、同じアカウントに複数のサイトを置けます。`--domain` は独自ドメインの割り当てです（そのドメインが Cloudflare にあること）。`--cors-origins` は API を呼べるブラウザのオリジンを絞ります（[キャッシュ](#キャッシュ)を参照）。 |
| `upgrade [--cors-origins <a,b>]` | インストールしたパッケージに同梱の Worker をデプロイし、マイグレーションを適用します。 |
| `reset [--confirm <サイト名>]` | すべてのコンテンツ（エントリ・メディア・コレクション）をゴミ箱へ移します。API キーは残ります。完全には消えません（消すには `trash empty --confirm <サイト名>`）。 |
| `destroy` | Worker・D1・R2 を削除します（[アンインストール](#アンインストール)を参照）。 |
| `login --url <url> --key <key> [--name <profile>]` | 既存のサイトをこのマシンに登録します。 |
| `logout [--name <profile>]` | 保存済みのプロファイルを削除します。 |
| `keys create --name <name> [--role admin\|read]` / `keys list` / `keys revoke <id>` | API キーの管理。 |
| `collections list \| get <name> \| create \| update <name> \| delete <name>` | スキーマの管理。`create` は `--file`（JSON か YAML）、または `--name`・`--label`・`--kind` と、繰り返し指定できる `--field name:type[:required]` で指定します。 |
| `entries list <collection>` | オプション: `--limit`、`--offset`、`--sort`、`--filter k=v`、`--fields`、`--expand`、`--status draft\|published\|all`。既定は公開済みのみです。 |
| `entries get <collection> [id]` | 1件を id か slug で取得（`single` のコレクションは id 省略可）。 |
| `entries create <collection>` / `entries update <collection> <id>` | 本文は `--data <json>`、`--file post.md`（先頭の YAML front matter がフィールドに、本文が `--body-field` に入る）、`--set k=v` のいずれかで渡します。`--slug`、`--published-at <iso>`、`--publish` も使えます。 |
| `entries delete \| publish \| unpublish <collection> <id>` | ゴミ箱へ移す／公開する／下書きに戻す。 |
| `media upload <file> [--alt <text>] [--filename <name>]` / `media upload --url <url> [--alt <text>] [--filename <name>]` | ローカルのファイルをアップロードするか、URL のファイルをサーバに取得させます（1ファイル 20MB まで）。 |
| `media update <id> --alt <text>` / `media list` / `media delete <id>` | 代替テキストの変更・一覧・ゴミ箱へ移す。 |
| `preview <collection> <id> [--ttl <秒>]` | 下書き確認用の、期限付きプレビュー URL を出力します（既定 24 時間、最長 2592000 秒 = 30 日）。 |
| `trash list \| restore <id> \| delete <id> \| empty` | ゴミ箱の管理。`delete` と `empty` は `--confirm <サイト名>` を取ります。 |
| `export [--out <dir>]` / `import <dir> [--replace --confirm <サイト名>]` | バックアップと移行（[export と import](#export-と-import)を参照）。 |

接続情報は `~/.config/femtocms/config.json`（権限 0600）にサイトごとのプロファイルとして保存されます。カレントディレクトリ（または親）に `femtocms.json` があればそちらが優先され、環境変数 `FEMTOCMS_URL` と `FEMTOCMS_KEY` はどちらよりも優先されます（CI で便利です）。

## HTTP API

ベース: `https://<サイト>/api`。リクエストも応答も JSON です。現在のコレクション定義から自動生成した仕様（OpenAPI）を **`/api/openapi.json`** で配信しています。

- 認証は `Authorization: Bearer <キー>`。**管理キー**（`fcms_admin_...`）はすべての操作ができ、**読み取りキー**（`fcms_read_...`）は非公開コレクションを読めます。
- 公開コレクションの公開済みエントリは、キーなしで読めます。
- コレクション: `GET/POST /api/collections`、`GET/PATCH/DELETE /api/collections/:name`
- エントリ: `GET/POST /api/:collection`、`GET/PATCH/DELETE /api/:collection/:idOrSlug`、`POST /api/:collection/:id/publish`、`POST /api/:collection/:id/unpublish`、`POST /api/:collection/:id/preview`。`single` のコレクションは `GET/PUT /api/:collection` です。
- 一覧のパラメータ: `limit`（既定 10、最大 100）、`offset`、`sort`（`-publishedAt` など。既定は公開日の新しい順）、`filter[フィールド]=値` または `filter[フィールド][gte]=1000`（演算子は `eq ne lt lte gt gte contains in`）、`fields`、`expand`（1段まで）、`status`（`draft`・`published`・`all`。管理キーのみ、既定は `published`）。応答は `{ items, total, limit, offset }` です。
- メディア: `POST /api/media`（multipart の `file`、または JSON の `{ url }` / `{ base64, filename }`）、`GET /api/media`、`PATCH /api/media/:id`（`{ alt }`）、`DELETE /api/media/:id`。ファイルは `/media/:id/:filename` で配信されます。
- ゴミ箱: `GET /api/trash`、`POST /api/trash/:id/restore`、`DELETE /api/trash/:id?confirm=<サイト名>`、`DELETE /api/trash?confirm=<サイト名>`
- 管理: `GET/POST/DELETE /api/keys`、`GET /api/export`、`POST /api/import`、`POST /api/reset`
- `GET /` は、サイトの簡単な紹介（名前・バージョン・API/MCP/OpenAPI の URL）を JSON で返します。

## MCP ツール

MCP のエンドポイントは `https://<サイト>/mcp`（Streamable HTTP、ステートレス）で、管理キーが必要です。破壊的なツールには MCP の `destructiveHint` が付くので、クライアント側で確認を出せます。

| 分類 | ツール |
|---|---|
| コレクション | `list_collections`、`get_collection`、`create_collection`、`update_collection`、`delete_collection` |
| エントリ | `list_entries`、`get_entry`、`create_entry`、`update_entry`、`delete_entry`、`publish_entry`、`unpublish_entry`、`get_preview_url` |
| メディア | `upload_media`（URL または base64）、`update_media`（代替テキスト）、`list_media`、`delete_media` |
| ゴミ箱 | `list_trash`、`restore_from_trash`、`delete_permanently`、`empty_trash` |
| キー | `create_key`、`list_keys`、`revoke_key` |
| データ | `export_data`、`import_data`、`reset_site` |

`delete_*` はゴミ箱へ移すだけです。`delete_permanently`、`empty_trash`、`reset_site`、置き換えモードの `import_data` は、`confirm` にサイト名を指定する必要があります。

## 埋め込み

```html
<div data-femtocms="news" data-limit="5" data-href="/news/{slug}"></div>
<script src="https://<サイト>/embed.js" defer></script>
```

| 属性 | 内容 |
|---|---|
| `data-femtocms` | コレクション名（必須）。 |
| `data-limit` | 件数。1〜100（既定 5）。公開日の新しい順。 |
| `data-fields` | 表示するフィールドをカンマ区切りで、表示順に指定。既定は `publishedAt,title`。`publishedAt`・`createdAt`・`updatedAt` と、text・number・image のフィールドを使えます。 |
| `data-href` | リンク先の型。`/news/{slug}` や `/news?id={id}` のように書きます。指定しなければリンクしません。femtocms は記事ページ自体は配信しません。 |
| `data-locale` | 日付のロケール（既定はページの `<html lang>`）。 |
| `data-empty` | エントリがないときに表示するメッセージ。 |

スクリプトは `<ul class="fcms-list">` と `<li class="fcms-item">` を描画します。リンクは `.fcms-link`、タイトルは `.fcms-title`、日付は `<time class="fcms-date">`、そのほかのフィールドは `.fcms-field` と `.fcms-field-<フィールド名>`、画像は `.fcms-image`、空メッセージは `.fcms-empty` です。標準の CSS は最小限で `:where()` を使っているので、自分で書いたルールが必ず優先されます。別のホストから読み込むときは、先に `window.FEMTOCMS_BASE = "https://<サイト>"` を設定してください。新しい要素を追加したあとなどは `window.femtocms.refresh()` で再描画できます。

## キャッシュ

- **workers.dev（既定）:** 公開の読み出しに `Cache-Control: public, max-age=60` と `ETag` を付けます（条件付きリクエストには 304 を返します）。数件程度なら、毎回 D1 を読んでも十分速いからです。
- **独自ドメイン（`init --domain`）:** さらに Cloudflare のエッジキャッシュにも保存します。キャッシュのキーに、書き込みのたびに上がる版番号を含めるので、古い内容が出ることはなく、purge も不要です。
- キー付きのリクエストと `?preview=` 付きのリクエストは `private, no-store` です。
- メディア（`/media/...`）は `public, max-age=31536000, immutable`、`embed.js` は 5 分キャッシュされます。
- `/api/*` と `/media/*` の CORS は、既定ですべてのオリジンを許可します。自分のサイトだけに絞るには、`init` か `upgrade` に `--cors-origins https://www.example.com,https://example.com` を渡してください（一覧はプロファイルに保存され、Worker の `CORS_ORIGINS` 変数としてデプロイされます。フラグを付けない `upgrade` は保存済みの一覧を保ち、`--cors-origins ""` で再びすべてのオリジンを許可します）。CORS が制限するのはブラウザだけで、公開コンテンツはブラウザ以外のクライアントからは誰でも読めます。

## export と import

```sh
npx femtocms export --out ./backup          # data.json（スキーマ・エントリ・メディア情報）と media/（ファイル本体）
npx femtocms import ./backup                # マージ: id で追加・上書き
npx femtocms import ./backup --replace --confirm <サイト名>   # 既存のデータを先にゴミ箱へ移す
```

エントリとメディアの id は保たれるので、参照や画像の URL は移行先でもそのまま使えます。API キーは export にも import にも含まれません。

`import` は、まず `media/` のファイルを送り（`PUT /api/media/<id>`）、そのあとで `data.json` を送ります。サーバは D1 に書き込む前に `data.json` 全体を検証します。検証に失敗した場合、送ったファイルはその id のまま残りますが、もう一度 import すれば上書きされます。`--replace` のときは、何かを送る前に CLI が `--confirm` の値をサイト名（`GET /` の `site`）と照合します。

## アップグレード

```sh
npx femtocms@latest upgrade
```

そのバージョンのパッケージに同梱の Worker を自分のアカウントにデプロイし、新しいデータベースのマイグレーションがあれば適用します。

## アンインストール

```sh
npx femtocms destroy
```

Worker 名を入力すると、サイトを空にし（すべてをゴミ箱へ移してからゴミ箱を空にするので、R2 のファイルも消えます）、R2 バケット・Worker・D1 データベースを削除して、保存済みのプロファイルも消します。元には戻せないので、必要なら先に `export` を取ってください。どのメディアにも属さないファイル（途中で失敗したアップロードなど）がバケットに残っている場合、`destroy` は Worker とデータベースを削除する前に止まり、プロファイルを残したまま、そのファイルの消し方（`wrangler r2 object delete` かダッシュボード）を表示します。消してからもう一度実行してください。これを行えるのは CLI だけです。動いている CMS 自身には、Cloudflare アカウントを操作する権限がありません。

## セキュリティ

- **キー:** サーバには各キーの SHA-256 ハッシュだけを保存します。管理キーが表示されるのは `init` か `keys create` のときの1回だけです。秘密にして、Web ページには置かないでください。最後の有効な管理キーは無効にできないので、AI が自分を締め出すことはありません。
- **公開の読み出しは誰でも読める:** `public: true`（既定）のコレクションの公開済みエントリは誰でも読めます。LP のブラウザから API を呼べるのはこのためです。非公開にしたい内容は `public: false` のコレクションに入れ、読み取りキーを使ってサーバ側から読んでください（ブラウザには置かないでください）。
- **下書き**が見えるのは、管理キーかプレビュートークンを使ったときだけです。プレビュートークンは署名つきで期限があり（既定 24 時間、最長 30 日）、1つのエントリだけを読めます。
- **破壊的な操作**（完全削除・ゴミ箱を空にする・reset・置き換え import）はサイト名の入力（`confirm`）が必要です。それ以外の削除はゴミ箱から戻せます。
- CLI は wrangler にシェルを介さず引数を渡し、保存する設定ファイルは自分だけが読める権限（0600）にします。

## 動作要件

- Node.js 22.12 以上（wrangler の要件です）。
- Cloudflare アカウント。すべて無料枠の範囲で動きます。R2 は一度だけ有効にする必要があり、支払い方法の登録が必要です。

## ライセンス

MIT
