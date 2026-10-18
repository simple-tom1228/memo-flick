# memo-flick 実装ブリーフ（設計: Opus / 実装: Codex）

モバイルファーストのタスク管理Webアプリ。最重要の価値は「開いた瞬間にメモできる」こと。

## 本番環境
- URL: https://memo-flick.simple-tanaka.workers.dev
- Cloudflare Workers（Static Assets 同居。ひな形は create-cloudflare の React + @cloudflare/vite-plugin。そのまま使う）
- D1: binding 名 DB / database_name memo-flick-db / database_id edac9c3f-ce28-4e36-9cd9-cc9921ce47fd
- Workers AI: binding 名 AI。モデルは vars の AI_MODEL（既定 @cf/google/gemma-4-26b-a4b-it）
- 依存は導入済み: react 19, motion (motion/react), hono, vitest, @playwright/test。新しい npm パッケージは追加しない（ネットワークなし）。必要なら自前で書く

## 画面と体験
- UI 文言は日本語。キャッチコピー・説明文・ヒーロー見出しなどは一切置かない。ボタン名・プレースホルダ・空状態の一言（例「メモなし」）だけ
- 最上部に入力欄（composer）。ページを開いた瞬間に入力できること:
  - index.html に素の HTML の textarea を置き autofocus。JS 読み込み前から打てる
  - React は起動時にこの既存 textarea の値を引き継ぐ（同じ DOM を使うか、値を読み取ってから置き換える。打った文字・カーソルを失わない）
  - Enter で追加（Shift+Enter で改行）、送信ボタンもあり。追加後も入力欄にフォーカスを戻す
  - 未ログインでも使える（ローカル保存）
- 全画面スケルトンローディング: index.html 内に純CSSのスケルトン（ヘッダー・タブ・カード数枚の形、シマー）を置き、React がデータを読み終わったらフェードで差し替える。composer はスケルトン中も操作可能。読み込みが速すぎてもちらつかないよう最低表示 350ms 程度
- ステータスは4つ: inbox（メモ）→ todo（やる）→ doing（進行中）→ done（完了）
  - 下部（または上部）にセグメントタブ。選択インジケータは motion の layoutId で移動アニメ。各タブに件数
  - カードを右にフリック = 次のステータスへ、左にフリック = 前のステータスへ。inbox で左フリック = 削除（「元に戻す」付きトースト 4 秒）。done で右フリック = アーカイブ（一覧から消える、元に戻す付き）
  - ドラッグ中は背景に次の行き先の色とラベルが現れ、しきい値（幅の 35% または速い速度）を超えると触覚（navigator.vibrate 10ms、対応時のみ）と色の強調。離すと spring で飛んでいき、一覧は layout アニメで詰まる
  - 縦スクロールを邪魔しない（横方向の移動が優勢なときだけフリック判定。touch-action: pan-y）
  - カードをタップでインライン編集
- デザイン: Liquid Glass、白ベース
  - 背景は白〜ごく淡いグラデーション＋ぼんやり動く淡い色の光（ゆっくり、軽量）
  - ガラス面: 半透明の白、backdrop-filter: blur + saturate、細い白い縁と内側のハイライト、柔らかい影。CSS 変数で一元管理
  - フォントはシステムフォント（-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif）
  - アニメーションはふんだんに: カードの出現（stagger）、追加時に composer からカードへ流れ込む、タブ切替、トースト、ボタンの押し込み、スケルトンからの切替。prefers-reduced-motion では控えめにする
  - 安全領域（env(safe-area-inset-*)）対応、横スクロールなし、最小 360px 幅で崩れない。PC 幅では中央 480px 程度のカラム
- ヘッダー右上にアカウントボタン。未ログイン時は「Googleでログイン」だけ。ログイン後はアバターとログアウト
- AI ボタン（ログイン時のみ有効）: inbox のメモ1件または composer の文章を Workers AI で整理し「タスク候補」（短いタイトルの配列、最大 8 件）を返す。候補はシートで表示し、チェックして追加。追加先は todo。生成中はシマー付きのプレースホルダ
- PWA: manifest.webmanifest とアイコン（SVG で可）、service worker でアプリ本体（HTML/JS/CSS）をキャッシュし、2回目以降はオフラインでも即開く。API はキャッシュしない

## データと同期（ローカルファースト）
- タスク: { id (uuid), text, status, archived (bool), deleted (bool), position (number), createdAt, updatedAt (ms) }
- 端末内は localStorage（または IndexedDB）に保存し、画面は常にローカルから描く
- ログイン中は変更を POST /api/sync に送る: body { since, changes: Task[] } → サーバーは updatedAt が新しい方を採用（last-write-wins）して保存し、since 以降に更新された全タスクを返す。削除は deleted=true の墓標で同期
- 同期のきっかけ: 起動時、変更のたび（500ms まとめ）、オンライン復帰、タブ復帰。失敗しても画面は止めない
- 初回ログイン時は端末内のタスクをそのアカウントへ上げる

## サーバー（worker/index.ts を Hono で）
- D1 スキーマは migrations/0001_init.sql: users(id, google_sub UNIQUE, email, name, picture, created_at)、sessions(id, user_id, expires_at)、tasks(id, user_id, text, status, archived, deleted, position, created_at, updated_at) とインデックス (user_id, updated_at)
- 認証は Google OAuth 2.0（Authorization Code + PKCE + state）を自前実装。ライブラリは使わない
  - GET /auth/google → state と code_verifier を短命の HttpOnly クッキーに入れて Google へリダイレクト（scope: openid email profile）
  - GET /auth/google/callback → state 照合、トークン交換（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET は secret）、id_token は tokeninfo ではなく userinfo エンドポイントで取得してよい。ユーザー作成/更新、セッション作成、/ へ戻す
  - redirect_uri はリクエストの origin から組み立てる（本番とローカルの両方で動く）
  - セッションクッキー: __Host-sid（ローカル http では sid）、HttpOnly、Secure（https 時）、SameSite=Lax、30 日。セッション ID は crypto.getRandomValues 32byte。D1 にはハッシュ（SHA-256）を保存
  - POST /auth/logout、GET /api/me
  - 状態を変える API は Origin ヘッダが自分のオリジンと一致することを確認（CSRF 対策）
- テスト用ログイン: GET /auth/test-login?email=… は env.E2E_TEST_LOGIN === "1" のときだけ有効。それ以外は 404。この値は .dev.vars（ローカル）にだけ書き、wrangler.jsonc には書かない
- POST /api/ai/suggest { text } → ログイン必須。入力は 2000 文字まで。1 ユーザー 1 分 10 回程度の簡易レート制限（D1 か メモリでよい）。Workers AI に JSON だけ返すよう指示し、壊れた出力でも行分割で救う。日本語で出力
- GOOGLE_CLIENT_ID 未設定時は /auth/google が 503 と分かりやすい JSON を返し、UI はボタンを押したとき「ログイン準備中」とトースト

## 設定ファイル
- wrangler.jsonc に d1_databases（binding DB, migrations_dir "migrations"）、ai（binding AI）、vars { AI_MODEL } を追加。worker-configuration.d.ts は npx wrangler types で再生成
- .dev.vars.example を用意（値は空）。.dev.vars と .wrangler は .gitignore

## テスト（必須・全部通すこと）
- vitest: 同期のマージ規則（新しい方が勝つ・墓標）と AI 出力の救済パーサの単体テスト
- Playwright（playwright.config.ts、webServer で `npm run dev` を使い、ローカル D1 にマイグレーション適用済みで起動。projects は iPhone 14 相当のモバイルと 1280px デスクトップ）e2e/*.spec.ts:
  1. 開いて 1 秒以内に入力欄にフォーカスがあり、JS 読み込み前に打った文字が残る（route でメイン JS を 800ms 遅延させて検証）
  2. スケルトンが最初に見え、その後消えて一覧が出る
  3. メモを追加 → inbox に出る、リロードしても残る
  4. 右フリックで todo → doing → done へ移る（マウスドラッグとタッチ相当の両方でもよい。少なくともポインタードラッグ）、左フリックで戻る
  5. inbox で左フリックで削除 → 元に戻すで復活
  6. キャッチコピーがない: 見出し要素（h1/h2）や説明文がないこと、横スクロールがないこと
  7. テスト用ログイン → 端末のタスクがサーバーへ上がる → 別コンテキストで同じユーザーでログインするとタスクが見える
  8. AI 提案: ローカルでは Workers AI が使えない場合があるので、env.AI_MOCK === "1"（.dev.vars のみ）のとき固定の候補を返すモックで UI を検証
  9. 未ログイン時に AI ボタンが無効、ログインボタンだけが見える
- npm scripts: test（vitest run）、e2e（playwright test）、db:migrate:local、db:migrate:remote

## 品質
- TypeScript strict、`npm run build` と oxlint が通る
- README.md（日本語）: 何か・使い方・技術と選定理由・ローカル起動・デプロイ手順・Google OAuth クライアントの作り方（承認済みリダイレクト URI: https://memo-flick.simple-tanaka.workers.dev/auth/google/callback と http://localhost:5173/auth/google/callback）
- 秘密の値をコードやコミットに入れない
