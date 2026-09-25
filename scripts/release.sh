#!/bin/bash
# 署名・公証済みの dmg / zip を dist/ に作る。
#
#   APPLE_KEYCHAIN_PROFILE=mxdeck-notary ./scripts/release.sh
#
# 前提:
#   - キーチェーンに "Developer ID Application" 証明書がある（electron-builder が自動で選ぶ）
#   - 公証用の認証情報をキーチェーンに登録済み（初回だけ）:
#       xcrun notarytool store-credentials mxdeck-notary --apple-id <Apple ID> --team-id <Team ID>
#     （アプリ用パスワードを聞かれる。https://account.apple.com で発行する）
#
# electron-builder は認証情報が無いと警告だけ出して公証を飛ばすので、前後でここが止める。
# notarytool のキーチェーンプロファイルは、エージェント等の別プロセスから読めないことがある。
# その場合は自分のターミナルで実行する。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  echo "APPLE_KEYCHAIN_PROFILE が未設定。公証用のキーチェーンプロファイル名を渡す（例: mxdeck-notary）" >&2
  exit 1
fi
xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" >/dev/null ||
  { echo "キーチェーンプロファイル $APPLE_KEYCHAIN_PROFILE が使えない（store-credentials を先に）" >&2; exit 1; }
security find-identity -v -p codesigning | grep -q "Developer ID Application" ||
  { echo "Developer ID Application 証明書がキーチェーンに無い" >&2; exit 1; }

rm -rf dist
pnpm exec electron-builder --mac dmg zip --arm64 --x64 --publish never

# 出来たものを検証する。公証を飛ばされていればここで落ちる
for app in dist/mac*/mxdeck.app; do
  codesign --verify --deep --strict "$app"
  spctl --assess --type execute --verbose=2 "$app"
  xcrun stapler validate "$app"
done
# electron-builder が公証するのは .app だけなので、dmg も署名・公証・staple する
# （ダウンロードした dmg を開くときの Gatekeeper の確認がオフラインでも通るように）
identity=$(security find-identity -v -p codesigning | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)
for dmg in dist/*.dmg; do
  codesign --force --sign "$identity" --timestamp "$dmg"
  xcrun notarytool submit "$dmg" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
done
ls -lh dist/*.dmg dist/*.zip
