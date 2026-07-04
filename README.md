# Diary

Cloudflare Workers + D1 + R2 で動く、静かなメモ帳アプリです。
一覧から詳細を開き、Markdown で編集し、タグや検索で素早く絞り込めます。

## できること

- CRUD によるメモ管理
- Markdown での編集と簡易プレビュー
- 全文検索とタグ絞り込み
- ページングによる一覧読み込み
- ピン留めと並び替え
- 下書きの自動保存と復元
- キーボードショートカット
- ダークモード切り替えとテーマ保存
- 画像添付と表示

## 画面の流れ

1. 左側の一覧からメモを選ぶ
2. 右側で詳細を読む
3. 編集ボタンでフォームを開いて更新する
4. 新規ボタン、`n`、または検索欄で次の操作へ移る

このアプリは「少ない操作で完結すること」を重視しています。
一覧、詳細、編集の行き来をなるべく短くしつつ、必要な補助機能だけを足しています。

## 構成

- `index.html` : 画面の骨組み
- `style.css` : レイアウトとテーマ
- `app.js` : 画面制御、検索、編集、下書き、ショートカット
- `config.js` : フロントから Worker へ送る URL 設定
- `workers/` : Cloudflare Workers の API 実装
- `workers/migrations/` : D1 のマイグレーション

## バックエンド

- D1 に本文とメタデータを保存します
- R2 に画像だけを保存します
- テーマ設定は D1 の `settings` テーブルで保存します
- `normalizeTitleAndTags` により、タイトル未入力時は `タイトル未設定` タグを自動付与します

## API

- `GET /api/notes?limit=&offset=&q=&tag=&sort=`: 一覧取得
- `GET /api/notes/:id`: 詳細取得
- `POST /api/notes`: 新規作成
- `PUT /api/notes/:id`: 更新
- `PATCH /api/notes/:id`: ピン切り替え
- `DELETE /api/notes/:id`: 削除
- `GET /api/images/:key`: 画像取得
- `GET /api/settings/theme`: テーマ取得
- `PUT /api/settings/theme`: テーマ保存

## セットアップ

1. `workers/wrangler.toml` の `database_id`、`ALLOWED_ORIGIN`、`bucket_name` を環境に合わせて確認します。
2. `config.js` の `indexUrl` と `entryBaseUrl` を Worker の URL に合わせます。
3. D1 のマイグレーションを適用します。
4. Worker をデプロイします。
5. ブラウザで `index.html` を開きます。

必要な場合は、Cloudflare Access 側でアプリのアクセス制御を行います。

## マイグレーション

- `workers/migrations/0001_init.sql`: notes テーブル作成
- `workers/migrations/0002_settings.sql`: settings テーブル作成
- `workers/migrations/0003_pinned_sort.sql`: pinned 列追加と並び替え用インデックス

## メモ

- リアルタイム subscribe は使っていません。D1 前提なので、基本は再取得ベースです。
- ページングは「もっと見る」で追加読み込みする方式です。
- ゴミ箱、履歴、PWA、カレンダービューはまだ未実装です。