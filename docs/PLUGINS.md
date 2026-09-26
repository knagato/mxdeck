# Plugins

A plugin is a folder with a `package.json` that mxdeck loads at startup. It runs in mxdeck's main
process and gets a small `ctx` object for the parts of mxdeck it may touch: the menu, the accounts,
a panel window, sign-in windows with their own storage, and frames inside the account views.

> **Plugins are trusted code.** They run with the same rights as mxdeck itself (files, network,
> every site's stored data). mxdeck only loads folders listed in `plugins.json`, and asks before
> adding one from the menu. `ctx` is not a sandbox; it is the supported way to reach into mxdeck.

## Installing

プラグイン (Plugins) → GitHub から追加… (Add from GitHub…) and enter the repository, then restart.
It accepts `owner/repo`, `owner/repo#<branch, tag or commit>` and github.com URLs (including `/tree/<branch>`
and `/releases/tag/<tag>`). Without a ref, the default branch is used.

- mxdeck downloads the repository's archive (no git needed) into `~/.config/mxdeck/plugins/<id>`
  and records where it came from in `plugins.json` (`source`, `commit`).
- Adding the same plugin again replaces it with the newer code; `config` in plugins.json is kept.
- Public repositories only. mxdeck does not run `npm install`, so a plugin with `dependencies` has to
  commit its `node_modules`, or be cloned, installed and added with フォルダから追加… (Add from folder…).

To use a folder you already have (e.g. while writing a plugin), choose フォルダから追加… (Add from folder…).
Or edit `~/.config/mxdeck/plugins.json` (override with `MXDECK_PLUGINS`):

```json
{
  "plugins": [
    { "path": "~/src/mxdeck-plugin-hello", "enabled": true, "config": { "site": "https://example.com/" } },
    { "path": "~/.config/mxdeck/plugins/login-helper", "enabled": true, "source": "github:knagato/mxdeck-plugin-login-helper", "commit": "d9a455e…" }
  ]
}
```

- `enabled: false` keeps the entry but does not load it.
- `config` is handed to the plugin as `ctx.config`. Put paths and settings that differ per machine here.
- Plugins are loaded and unloaded only at startup.

## Writing one

```json
// package.json
{
  "name": "mxdeck-plugin-hello",
  "version": "0.1.0",
  "mxdeck": { "id": "hello", "name": "Hello", "main": "main.js", "api": 1 }
}
```

- `id`: lowercase letters, digits and `-`. It names the plugin's storage, so do not change it.
- `api`: the ctx version the plugin was written for. mxdeck refuses plugins for another version.
- `main` exports `activate(ctx)`. It is called before the window opens; it may be async.
- Dependencies go in the plugin's own `node_modules`. `require("electron")` works as usual.

See [`examples/hello-plugin`](../examples/hello-plugin) for a complete one.

## ctx

| | |
|---|---|
| `ctx.id`, `ctx.dir`, `ctx.config`, `ctx.locale` | The plugin's id, folder, `config` from plugins.json, and the app locale (`en-US`, `ja`, …) |
| `ctx.menu.add(item)` | Add a menu item (`{ label, accelerator?, click }` or `{ type: "separator" }`) to the プラグイン menu |
| `ctx.accounts.list()` / `ctx.accounts.active()` | `{ id, name, url }` of every account / of the visible one (or `null`) |
| `ctx.panel.open({ file, width?, height?, resizable? })` | Open an HTML file from the plugin as a sheet on the main window (or focus it if already open). Returns `{ window, send(channel, payload), close() }` |
| `ctx.panel.handle(channel, fn)` | Answer `window.mxdeck.invoke(channel, ...args)` from the plugin's panels |
| `ctx.sites.session(name)` | The Electron `session` for storage `persist:plugin-<id>-<name>`, separate from every account. Permission requests are denied |
| `ctx.sites.open(name, url, { show? })` | A browser window on that storage, for signing in to a site. Reuses the open one. Links that open a new tab load in the same window; only sized popups (SSO) get their own. Returns `{ window, webContents, session, loaded(), currentPage(), close() }` |
| `ctx.sites.close(name)` | Close that site's window and its popups, and return how many were open. The sign-in stays in the storage |
| `ctx.frames.inject({ origins, preload })` | Run `preload` in the frames of the account views (e.g. a widget iframe inside Element) |
| `ctx.frames.handle(channel, fn)` | Answer `ipcRenderer.invoke("mxdeck:frame", "<id>", channel, payload)` from those frames. `fn(payload, { account, origin })` |
| `ctx.frames.send(channel, payload, { accountId? })` | Send to those frames; the preload listens with `ipcRenderer.on("mxdeck:frame:<id>", (e, channel, payload) => …)` |

### Panels

The panel page gets `window.mxdeck` and nothing else:

```js
const state = await window.mxdeck.invoke("state");   // ctx.panel.handle("state", …)
window.mxdeck.on("progress", (p) => …);              // panel.send("progress", …)
window.mxdeck.close();
```

A panel is a sheet without a title bar. mxdeck closes it on Esc and ⌘W whatever the page does,
but give it a visible close button too — people do not guess the shortcut.

Keep secrets in the main process. If the panel only needs to show a value masked and copy it,
return the masked form and copy it from `main` with Electron's `clipboard`.

### Frames

With a plugin that uses `ctx.frames`, account views run preloads in iframes too
(`nodeIntegrationInSubFrames`). The preload runs in **every** frame of every account, so it should
check `location.origin` first and do nothing elsewhere. mxdeck does its own check as well:
`ctx.frames.handle` is called only when the sender is an account view **and** the sending frame's
origin is one of the `origins` given to `inject`. Everything else is rejected with `forbidden`.

Preloads are sandboxed: `require("electron")` gives `ipcRenderer` and `contextBridge`, not Node.

## Testing

`pnpm test` runs `tests/github.test.mjs` (reading the repository spec and unpacking an archive
from a local server) and `tests/plugins.test.mjs`, which starts mxdeck on a temporary profile with
[`tests/fixture-plugin`](../tests/fixture-plugin) and local servers, and checks panels, sign-in
storage and the frame origin check.
