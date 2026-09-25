# element-multi

複数の Matrix アカウントを1つのウィンドウで切り替えるデスクトップシェル（試作）。
左端のサイドバーでアカウントを選ぶと、そのアカウントの Element Web が右側に出る。

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
- 未読はページタイトル（`<brand> [3]` / `* <brand>`）から拾ってサイドバーと Dock のバッジに出す。
- 通知をクリックすると Element が `window.focus()` を呼ぶので、preload でそれを拾ってそのアカウントへ切り替える。
- `target=_blank` のリンクは既定ブラウザで開く。

## 使い方

```bash
pnpm install
node node_modules/electron/install.js   # pnpm が postinstall を飛ばした場合だけ
pnpm start
```

アカウントは `~/.config/element-multi/accounts.json`（`ELEMENT_MULTI_ACCOUNTS` で変更可）。
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

## 制限（試作の段階）

- Element Desktop 固有の機能は無い（Seshat による暗号化ルームのローカル検索、トレイ、自動起動、
  キーチェーンでのセッション鍵保護など）。中身はブラウザ版 Element と同じ。
- **パスキー（Touch ID / iCloud キーチェーン）でのログインは使えない。** macOS は Apple が許可した
  ブラウザにしか同期パスキーを渡さない。Google の SSO では「別の方法を試す」からパスワード＋2段階認証で入る。
  UA からは `Electron/` を外してあるので、埋め込みブラウザとして弾かれることは避けている。
- 未読数はタイトル依存。ブランドや Element の版でタイトル形式が変わると拾えなくなる。
- パッケージング（.app 化・署名）はまだ。`pnpm start` で動かす。
