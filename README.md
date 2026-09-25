# mxdeck

複数の Matrix アカウントを1つのウィンドウで切り替えるデスクトップシェル（試作）。
左端のサイドバーでアカウントを選ぶと、そのアカウントの Matrix Web クライアント（Element Web・Cinny など）が右側に出る。

Element Desktop は 1プロセス1アカウントで、複数使うには `--profile` で別プロセスを立てるしかない。
Element Web の内部（`MatrixClientPeg` などのシングルトン）をマルチアカウント化するのは重いので、
外側のシェルで「アカウントごとに独立したブラウザ環境」を並べる方式にしている。

## 仕組み

- アカウントごとに Electron の partition（`persist:acct-<id>`）を分ける。Cookie・localStorage・
  IndexedDB（暗号ストア含む）・Service Worker がアカウント単位で独立する。
- 各アカウントは **ホストされた Element Web の URL** を読み込む。自前ホストの Element Web なら
  そのサーバーの config・テーマ・モジュールがそのまま効く。
  - 同梱 Web アプリ + 独自スキーム（Element Desktop の `vector://`）方式にしないのは、MAS（OIDC）の
    ログインでリダイレクト先が https でないと登録が通らないため。
- 非表示のアカウントも読み込んだまま（`backgroundThrottling: false`）なので、同期と通知は続く。
- 中身のクライアントは Element Web に限らない（Cinny Web でも動作確認済み）。未読の拾い方だけクライアントごとに違うので、
  両方から拾って合成し、サイドバーと Dock のバッジに出す。
  - Element: ページタイトル（`<brand> [3]` は件数、`* <brand>` は未読のみ）
  - Cinny: favicon の差し替え（緑のロゴ = メンションあり → `!`、灰のロゴ = 未読あり → 点。件数は出ない）
  - どちらにも当てはまらないクライアントはバッジが出ないだけで、他は動く。
- 通知のクリックは preload で `Notification` を包んで拾い、そのアカウントへ切り替える
  （クリック時の振る舞いがクライアントごとに違うため。Element は `window.focus()`、Cinny は画面内遷移だけ）。
- `target=_blank` のリンクは既定ブラウザで開く。

## 使い方

```bash
pnpm install
node node_modules/electron/install.js   # pnpm が postinstall を飛ばした場合だけ
pnpm start
```

.app にして `~/Applications/mxdeck.app` に入れる（ad-hoc 署名、公証なし。自分の Mac 用）:

```bash
pnpm run install-app   # electron-builder で dist/ に作り、~/Applications へ ditto
```

起動中の .app は先に終了しておく。保存先は開発起動と同じ `~/Library/Application Support/mxdeck`
に固定してあるので、`pnpm start` と .app でログイン状態を共有する（同時には起動しない）。

アカウントは `~/.config/mxdeck/accounts.json`（`MXDECK_ACCOUNTS` で変更可）。
無ければ `accounts.example.json` をコピーして作る。

```json
{
  "accounts": [
    { "id": "work", "name": "Work", "url": "https://element.example.com", "icon": "~/Pictures/work.png" },
    { "id": "personal", "name": "Personal", "url": "https://app.element.io", "color": "#0dbd8b" }
  ]
}
```

- `id` は partition 名になる。**変えると別の保存領域になり、ログインし直し**になる。
- `icon` が無ければ `name` の1文字目を `color` の丸で出す。
- ⌘1〜⌘9 でアカウント切り替え、⌘R は表示中のアカウントだけ再読み込み、⌥⌘I で開発者ツール。
- 「表示 → メモリ使用量…」でアカウントごとのメモリ（working set、iframe の別プロセスも合算）と Electron 本体側の内訳を出す。

### アプリ上での管理

`accounts.json` を手で書かなくても、アプリから追加・編集・削除・並べ替えができる。変更はすぐ `accounts.json` に書き戻る。

| 操作 | やり方 |
| --- | --- |
| 追加 | サイドバー下の「+」、または ⇧⌘N。名前・URL・アイコン（画像か色）を入れる |
| 編集 | アイコンを右クリック →「編集…」。URL を変えるとそのアカウントだけ読み直す |
| 削除 | アイコンを右クリック →「削除…」。保存データ（ログイン状態・暗号鍵）を消すかを選べる |
| 並べ替え | アイコンをドラッグ。⌘1〜9 の割り当ても並び順に付け直る |
| 手で編集した後 | メニュー「アカウント → accounts.json を読み直す」 |

- `id` は追加時に名前（日本語ならホスト名）から自動で作り、以後は変えない。
- 保存データを残して削除したアカウントは、**同じ URL で追加し直すと元の保存領域を引き継ぐ**（ログインし直し不要）。
- アプリから選んだアイコンは `~/.config/mxdeck/icons/` にコピーする。
- 読めない `accounts.json` は `accounts.json.broken-<時刻>` に退避してから空で起動する（上書きで消さない）。

### 動作確認

普段使いのログイン状態に触れずに、別の保存先・別の一覧で起動できる:

```bash
MXDECK_USER_DATA=/tmp/emtest/ud MXDECK_ACCOUNTS=/tmp/emtest/accounts.json \
  pnpm exec electron . --remote-debugging-port=19222
```

`--remote-debugging-port` を付けると CDP（`http://127.0.0.1:19222/json`）からサイドバーや編集シートを操作できる。

## 制限（試作の段階）

- Element Desktop 固有の機能は無い（Seshat による暗号化ルームのローカル検索、トレイ、自動起動、
  キーチェーンでのセッション鍵保護など）。中身はブラウザ版 Element と同じ。
- **パスキー（Touch ID / iCloud キーチェーン）でのログインは使えない。** macOS は Apple が許可した
  ブラウザにしか同期パスキーを渡さない。Google の SSO では「別の方法を試す」からパスワード＋2段階認証で入る。
  UA からは `Electron/` を外してあるので、埋め込みブラウザとして弾かれることは避けている。
- 未読はタイトル・favicon の形式に依存する。クライアントの版で形式が変わると拾えなくなる。
- 自動更新は無い。コードを変えたら `pnpm run install-app` で入れ直す。
- プロセスを強制終了すると、次の起動で Element が「別のウィンドウで開いています」と出ることがある
  （Element Web のセッションロックが残るため）。他に起動していなければ「続行」してよい。
