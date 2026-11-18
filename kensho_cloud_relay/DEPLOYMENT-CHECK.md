# 稼働中ソース照合・テスト反映記録

2026-11-19 JST。キーの値やクーポンのデータ行は取得していません。

## 本番の読み取り確認

- 対象Worker：kensho-relay、稼働バージョン78ca03ff。
- CloudflareのコードエディターからUI操作で全文を読み取り、Phase 1の保管ソースと比較。CRLF/LFと末尾改行を正規化すると全文一致しました。
- 元ソースのSHA-256：2897b2bed3dcfbe5b741d31d5e6b3bd0b5afcc1fc0b6be2775f1641ffe3f042c。
- DBバインディング：DB → kensho-relay-db。テストDBとは別です。
- ENCRYPTION_KEY・SENDER_KEY・RECEIVER_KEYはSecretsとして存在。値の表示・変更はしていません。ALLOWED_ORIGINSは未設定でした。
- DB内部のスキーマとレコードは照会していません。本番Workerの保存・デプロイも行っていません。

## テスト環境への反映

- 対象Worker：kensho-relay-phase2-test。
- DBバインディング：DB → kensho-relay-phase2-test-db。既存のテスト用バインディングとSecretsを維持しました。
- 反映前バージョン25a508fd、反映後のアクティブバージョン38adf053。
- PR #5のコードcommit 6804bce9d08624017153ffcf5ee8575d7e5dbf0d のrelay-core.jsとworker.jsを、単一ESモジュールに連結して反映しました。importを外し、coreのexport defaultをローカル変数relayに置換したものです。
- 単一ファイルの生成物に対して同じ17件のWorker回帰テストを実行し、17/17合格しました。テスト用コードエディターへ入力後も全文を読み戻し、生成物と改行・末尾改行以外に差がないことを確認してからデプロイしました。
- 元のテスト用ソースはローカルへ退避しました。DB初期化・schema適用・鍵の更新は行っていません。
- デプロイ後のキーなし確認：/healthがok:true、確認サイトのOriginから/api/pendingへのOPTIONSがHTTP 204、Access-Control-Allow-Originが要求元と完全一致。GET、Authorization/Content-Typeだけを許可する応答を確認しました。

## 正式版候補との結合確認

PR #4のHTMLを基に、テスト用Worker固定・別localStorage・専用ダミー表示だけを追加した本人限定の確認画面v5を用意します。受信・再通知の実装は正式版候補を使います。送信前の失敗、成功応答破棄、未知ID拒否を個別に確認できる補助UIを加えます。

画面の追加自動テスト7/7合格。利用者のキー入力が必要な、修正版Workerと実D1を使った送信・登録・復旧・未知ID拒否・応答破棄後の再送確認は、この記録時点では未完了です。以前のv4での成功を修正版v5の確認結果に読み替えていません。

本番DB内部の照合、本番キーでの通信、本番への反映は別途判断が必要です。PR #4と本PRはDraft・未マージを維持します。
