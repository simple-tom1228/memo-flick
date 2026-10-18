# memo-flick

開いてすぐ書ける、端末保存が基本のメモ・タスク管理アプリです。メモを入力して Enter または「追加」で保存します。Shift+Enter は改行です。カードを右へ動かすと「メモ→やる→進行中→完了」、左へ動かすと逆に進みます。メモで左へ動かすと削除、完了で右へ動かすとアーカイブします。カードを押すと編集できます。ログインすると別の端末と同期し、AIでタスク候補も作れます。

## 技術と選んだ理由

React 19 は画面の更新、Motion はカードとタブの動き、Hono はWorkersのAPI、D1はアカウントごとの保存に使います。入力欄はHTMLに直接置き、JavaScriptの読み込み前から入力できます。端末内の保存を先に行うため、通信が不安定でもメモを続けられます。初回読み込み時にはスケルトンを表示します。公開後はサービスワーカーが画面ファイルを保存し、2回目からオフラインで開けます。APIの結果は保存しません。

## ローカル起動

既存の依存を使い、追加インストールは不要です。

```sh
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`http://localhost:5173` を開きます。Googleログインを使うには `.dev.vars` に `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を設定します。ブラウザ試験では `.dev.vars` に `E2E_TEST_LOGIN=1` と `AI_MOCK=1` を設定します。この2つは本番の設定へ入れないでください。テスト用ログインURLはこの設定のときだけ使えます。

```sh
npm run build
npx oxlint
npm test
npm run e2e
```

## Google OAuthの設定

Google Cloud ConsoleでOAuth同意画面と「ウェブアプリケーション」のOAuthクライアントを作ります。承認済みのリダイレクトURIに次の2つを登録します。

- `https://memo-flick.simple-tanaka.workers.dev/auth/google/callback`
- `http://localhost:5173/auth/google/callback`

作成されたクライアントIDとシークレットは、ローカルでは `.dev.vars`、本番ではWorkersのsecretに登録します。コードやGitには入れません。

## 公開手順

Cloudflare側でD1 `memo-flick-db` が設定済みであることを確認し、Googleの値をsecretとして登録します。`npm run db:migrate:remote` で表を作り、`npm run deploy` で公開します。公開後にGoogleログイン、同期、AIの動作を実際の環境で確認してください。AIのモデルは `wrangler.jsonc` の `AI_MODEL` で指定しています。
