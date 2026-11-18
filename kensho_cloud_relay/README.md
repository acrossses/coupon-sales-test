# Cloud relay：CORSと完了通知の修正候補

PR #4の正式版RC2を接続するためのWorker側候補です。本番環境へは未反映です。

## ソースと対象

リポジトリのmain（27d02dc8eb712c5acce6d2a6e3075dfc476b68c2）の全ツリーにはWorkerソースがないため、このフォルダーを新規追加します。利用者が以前提供したPhase 1ソースのローカル保管物 `upstream/kensho_cloud_relay/worker.js` を基にしています。`relay-core.js` はその既存API・暗号化処理を保持し、confirmだけを修正しました。`worker.js` はCORSと経路別メソッドの検査を行います。既存のreceived APIも維持します。

2026-11-19 JSTに稼働中WorkerのコードをUIから読み取り、改行形式・末尾改行以外は元ソースと全文一致することを確認しました。テスト用Workerへの反映とキーなしの稼働・CORS確認も実施しました。詳細と未完了項目は[DEPLOYMENT-CHECK.md](DEPLOYMENT-CHECK.md)を参照してください。実キーや実データは取得していません。

## 修正

- `ALLOWED_ORIGINS` に明記したHTTPSオリジンだけへCORS応答します。空欄・`*`・`null`・パス・不正な値は許可しません。送信元なしの従来の認証付き非ブラウザクライアントは維持します。
- OPTIONSは既知経路に必要なメソッドとAuthorization・Content-Typeだけを許可します。エラー応答にも許可済みOriginのCORSヘッダーを付けます。CORSは既存の送信・受信キー認可を置き換えません。
- confirmは最大200個のUUIDを重複除去し、全IDが存在して有効な状態の場合だけ更新します。未知IDを混ぜた要求では、既知IDも更新しません。
- 完了済みIDの再試行は成功します。応答を受け取れず再送しても日時を保持し、新着へ復活させません。成功応答の`processed`は確認できた重複除去済みID数、`updated`は今回更新した件数、`alreadyConfirmed`は既に完了していた件数です。
- D1の同一batch内で条件付きUPDATEと最終状態のSELECTを実行します。ID配列はjson_eachへ渡し、200件でも各クエリのパラメータ数を100以下にします。DBエラー時は成功を返さず、例外の内部情報を返しません。
- `schema.sql` は既存形式と同一です。マイグレーション、テーブル再作成、鍵の変更は不要です。

## テスト

Node.js 24以上で `node --test kensho_cloud_relay/tests/*.test.mjs`。

17件：許可・拒否CORS、経路別preflight、認証と役割分離、URL暗号化・クエリ保持、pending/received確認、未知ID、混在IDの非更新、応答消失後の再送、重複、200件、DB障害のロールバック、想定外状態、新着除外・同URL再送、received API互換。

ダミーのキー・URLとメモリSQLiteで、D1のprepare/batchインターフェースを模擬しています。実Cloudflare D1・稼働中Worker・本番キーによる確認ではありません。

## 公開前

1. 稼働中ソースと設定を照合し、既存の正しいDB・Secretsを維持できることを確認します。ENCRYPTION_KEYを作り直すと既存データを復号できなくなるため、変更しません。
2. 独立したテストWorkerとテストD1へ反映して、正式版候補とのダミー通信・再通知・応答消失後の再送を確認します。
3. 正式版を配信する正確なオリジンだけを許可します。本番での初期候補は `https://acrossses.github.io` です。異なる配信先を使う場合は先に確認します。
4. 本番デプロイ・本番DBへの操作は別途承認後に行います。本PRはDraftのままにします。PR #4もこれらの確認が済むまで公開しません。

`wrangler.example.toml` は配置先を未指定の例です。自動デプロイ設定や利用可能なwrangler.tomlは含みません。DB作成・リセット・schema適用・Secret設定を自動実行する処理もありません。

## 設計の参照

- [Cloudflare D1 batch：トランザクションとロールバック](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare D1 JSONとjson_each](https://developers.cloudflare.com/d1/sql-api/query-json/)
- [Cloudflare D1 limits：bound parameters](https://developers.cloudflare.com/d1/platform/limits/)
