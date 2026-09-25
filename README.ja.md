# mxdeck

[English](README.md) | 日本語

複数の Matrix アカウントを1つのウィンドウで切り替える macOS 用デスクトップシェル。
左端のサイドバーでアカウントを選ぶと、そのアカウントの Matrix Web クライアント（Element Web・Cinny など）が右側に出る。

![mxdeck](docs/screenshot.jpg)

Element Desktop は 1プロセス1アカウントで、複数使うには `--profile` で別プロセスを立てるしかない。
Element Web の内部（`MatrixClientPeg` などのシングルトン）をマルチアカウント化するのは重いので、
外側のシェルで「アカウントごとに独立したブラウザ環境」を並べる方式にしている。

> mxdeck は個人のプロジェクトで、Element（New Vector Ltd）や The Matrix.org Foundation とは関係ない。

## 特徴

- アカウントごとに Cookie・localStorage・IndexedDB（暗号ストア含む）・Service Worker が独立
- ホストされた Web クライアントをそのまま読む。自前ホストの Element Web なら、そのサーバーの config・テーマ・モジュールが効く
- 裏のアカウントも止めないので、同期と通知が続く。通知をクリックするとそのアカウントへ切り替わる
- 未読バッジ（サイドバーと Dock）。Element はタイトル、Cinny は favicon から拾う
- アプリ上でアカウントの追加・編集・削除・並べ替え（`accounts.json` に書き戻る）
- ⌘1〜⌘9 で切り替え、アカウントごとのメモリ使用量の表示

UI は今のところ日本語のみ。

## インストール

### 公証済みのアプリ

[Releases](https://github.com/knagato/mxdeck/releases) から dmg（Apple Silicon は `arm64`、Intel は `x64`）を落として
Applications へ入れる。Developer ID で署名し、Apple の公証を通してある。

### ソースから

```bash
pnpm install
node node_modules/electron/install.js   # pnpm が postinstall を飛ばした場合だけ
pnpm start
```

自分の Mac 用に .app にして `~/Applications/mxdeck.app` へ入れる（ad-hoc 署名、公証なし）:

```bash
pnpm run install-app
```

起動中の .app は先に終了しておく。保存先は `~/Library/Application Support/mxdeck` に固定してあるので、
`pnpm start` と .app でログイン状態を共有する（同時には起動しない）。

## 使い方

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

- `id` は partition 名（`persist:acct-<id>`）になる。**変えると別の保存領域になり、ログインし直し**になる。
- `icon` が無ければ `name` の1文字目を `color` の丸で出す。
- ⌘1〜⌘9 でアカウント切り替え、⌘R は表示中のアカウントだけ再読み込み、⌥⌘I で開発者ツール。
- 「表示 → メモリ使用量…」でアカウントごとのメモリ（working set、iframe の別プロセスも合算）と Electron 本体側の内訳を出す。

### アプリ上での管理

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

## 仕組み

- アカウントごとに Electron の partition を分けた `WebContentsView` を作り、サイドバーで表示を切り替える。
- 各アカウントは **ホストされた Web クライアントの URL** を読み込む。同梱 Web アプリ + 独自スキーム
  （Element Desktop の `vector://`）方式にしないのは、MAS（OIDC）のログインでリダイレクト先が https でないと登録が通らないため。
- 非表示のアカウントも読み込んだまま（`backgroundThrottling: false`）。
- 未読の拾い方はクライアントごとに違うので、両方から拾って合成する。
  - Element: ページタイトル（`<brand> [3]` は件数、`* <brand>` は未読のみ）
  - Cinny: favicon の差し替え（緑のロゴ = メンションあり → `!`、灰のロゴ = 未読あり → 点。件数は出ない）
  - どちらにも当てはまらないクライアントはバッジが出ないだけで、他は動く。
- 通知のクリックは preload で `Notification` を包んで拾う（Element は `window.focus()`、Cinny は画面内遷移だけで、振る舞いが違うため）。
- `target=_blank` のリンクは既定ブラウザで開く。

## セキュリティ

- 通知・カメラ・マイク・画面共有・クリップボードの許可は、**そのアカウントの URL と同じオリジンを表示している間だけ**出す。
  SSO などで別サイトへ移った画面には出さない。
- アカウントのビューは `contextIsolation` + `sandbox`。ページに公開しているのは「通知がクリックされた」を伝える関数だけ。
  サイドバーや編集シート向けの IPC は送り元を確かめ、アカウントのビューからは叩けない。
- ログイン状態・暗号鍵は各クライアントが partition 内（`~/Library/Application Support/mxdeck/Partitions/`）に保存する。
  ブラウザ版と同じで、Element Desktop のようなキーチェーンでの保護は無い。

## 制限

- Element Desktop 固有の機能は無い（Seshat による暗号化ルームのローカル検索、トレイ、自動起動など）。中身はブラウザ版と同じ。
- **パスキー（Touch ID / iCloud キーチェーン）でのログインは使えない。** macOS は Apple が許可した
  ブラウザにしか同期パスキーを渡さない。Google の SSO では「別の方法を試す」からパスワード＋2段階認証で入る。
  UA からは `Electron/` を外してあるので、埋め込みブラウザとして弾かれることは避けている。
- 未読はタイトル・favicon の形式に依存する。クライアントの版で形式が変わると拾えなくなる。
- 自動更新は無い。
- プロセスを強制終了すると、次の起動で Element が「別のウィンドウで開いています」と出ることがある
  （Element Web のセッションロックが残るため）。他に起動していなければ「続行」してよい。

## 開発

普段使いのログイン状態に触れずに、別の保存先・別の一覧で起動できる:

```bash
MXDECK_USER_DATA=/tmp/mxdeck-test/ud MXDECK_ACCOUNTS=/tmp/mxdeck-test/accounts.json \
  pnpm exec electron . --remote-debugging-port=19222
```

`--remote-debugging-port` を付けると CDP（`http://127.0.0.1:19222/json`）からサイドバーや編集シートを操作できる。

### リリース

署名・公証済みの dmg / zip（arm64・x64）を `dist/` に作る。

```bash
# 初回だけ: 公証用の認証情報をキーチェーンに登録（アプリ用パスワードを聞かれる）
xcrun notarytool store-credentials mxdeck-notary --apple-id <Apple ID> --team-id <Team ID>

APPLE_KEYCHAIN_PROFILE=mxdeck-notary pnpm run release
gh release create v<version> dist/*.dmg dist/*.zip --generate-notes
```

`scripts/release.sh` は、公証の認証情報と Developer ID 証明書があるかを先に確かめ、ビルド後に
`codesign` / `spctl` / `stapler` で検証する（electron-builder は認証情報が無いと警告だけで公証を飛ばすため）。

## ライセンス

[MIT](LICENSE)
