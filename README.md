<div align="center">
  <img src="assets/logo.svg" width="120" alt="Ephemera" />
  <h1>Ephemera</h1>
  <p><strong>A privacy-first, leave-no-trace desktop browser.</strong></p>
  <p><em>Search freely. Then wipe to a clean slate in one click.</em></p>
</div>

---

## What it is

Ephemera is a desktop browser built around a single promise: **leave no trace.**

Most browsers treat privacy as a mode you switch on. Ephemera treats it as the
default and the *only* state. Every byte of browsing storage lives in memory and
is discarded on quit — and a single red button wipes cookies, cache, history and
storage **mid-session**, resetting you to a fresh start without restarting the app.

Think *incognito, but stronger and prettier, with a panic button.*

When a tradeoff had to be made, it was made in this order: **(1) privacy,
(2) visual polish, (3) simplicity.**

## Why it's stronger than standard incognito

| | Standard incognito | Ephemera |
|---|---|---|
| Storage location | Disk (cleared on window close) | **In-memory only — never written to disk** |
| Ad / tracker blocking | None (you bring your own) | **Built in, at the network layer** |
| DNT / Global Privacy Control | Usually off | **`DNT: 1` + `Sec-GPC: 1` on every request** |
| Permission prompts | Asked | **Denied by default** (geo, camera, mic, notifications) |
| Mid-session reset | Close the whole window | **One click / `Ctrl+Shift+K` — instant Clean Slate** |
| HTTP-auth / NTLM creds | May persist | **Never persisted** |

The core of the model is one **non-persistent Electron session partition**.
Because the partition name carries no `persist:` prefix, Chromium keeps all of
its storage in RAM and throws it away when the process exits. The Clean Slate
button is for the moments in between: it calls `clearStorageData` +
`clearCache` + `clearHostResolverCache` + `clearAuthCache`, resets the blocked
counter, closes every tab and drops you on a fresh new-tab page.

## Features

- **Tabs** — open / close / switch, middle-click to close, `Ctrl+T` / `Ctrl+W`,
  `Ctrl+Tab` to cycle. Always keeps at least one tab open.
- **Smart omnibox** — looks like a URL → navigates; otherwise → DuckDuckGo
  search (the privacy default). `Ctrl+L` focuses it.
- **Navigation** — back / forward / reload with correct disabled states.
- **Ad & tracker blocking** — [`@ghostery/adblocker-electron`](https://github.com/ghostery/adblocker)
  with the prebuilt ads-and-tracking filter lists, enabled on the browsing
  session. A **live counter** increments as requests are blocked.
- **Clean Slate** — the headline feature. Red panic button + `Ctrl+Shift+K`,
  a brief wipe animation and a confirming toast.
- **Designed new-tab page** — logo hero, the Kali "dragon wallpaper" gradient,
  a private search box and a live "trackers blocked this session" stat.

## Design

The look is **Kali Linux (Kali-Dark)** — frameless window, custom titlebar with
circular xfwm4-style controls, squarish 6px radii, and the verified Kali palette:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#1b1e24` | deepest panel |
| `--surface` | `#21262d` | titlebar + chrome |
| `--surface-2` | `#2a2f38` | toolbar / hover |
| `--border` | `#353b45` | hairlines |
| `--text` | `#d6dadf` | soft off-white (never pure `#fff`) |
| `--muted` | `#8b93a1` | secondary text |
| `--accent` | `#5ca7fb` | **verified Kali blue** — the signature |
| `--danger` | `#fa4b4b` | **verified Kali red** — the panic button |
| `--green` | `#18b218` | **verified Kali green** — confirmations |

Typography is the single biggest "this is Kali" tell: **Cantarell** for UI chrome
and **Fira Code** for every URL, the tracker counter and the toast. Both fonts are
OFL-licensed and **bundled locally** — a privacy browser must never phone home to
render its own interface, and it must work offline.

## Architecture

```
ephemera/
├── main.js            # main process: ephemeral session, privacy, adblock, IPC
├── preload.js         # contextBridge → window.ephemera (wipe + window controls)
├── assets/logo.svg    # the beetle mark; source for the app icon
├── renderer/
│   ├── index.html     # chrome: titlebar, tabs, toolbar, <webview> host
│   ├── styles.css     # the Kali-Dark design system
│   ├── renderer.js    # tabs, navigation, omnibox, counter, Clean Slate
│   ├── newtab.html    # the home page (the portfolio screenshot)
│   ├── newtab.css
│   ├── newtab.js
│   └── fonts/         # Cantarell + Fira Code (woff2)
└── scripts/gen-icons.js   # rasterizes the logo into the packaging icon
```

Page content is hosted in `<webview>` tags. That's a deliberate, documented
tradeoff (see the comment at the top of `main.js`): `<webview>` keeps the
renderer a single self-contained document, which is the pragmatic choice for a
focused portfolio app. A production product would migrate the tab host to
`WebContentsView`.

Security hardening: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`; guest `<webview>` preferences are re-enforced on attach; the
renderer reaches main only through the small audited `window.ephemera` bridge.

## Run

```bash
npm install
npm start
```

## Build installers

```bash
npm run dist          # current platform
npm run dist:win      # Windows  (NSIS .exe)
npm run dist:mac      # macOS    (.dmg)
npm run dist:linux    # Linux    (AppImage)
```

`npm run dist` first runs `scripts/gen-icons.js`, which composites the beetle
logo onto a Kali-gradient squircle and rasterizes it to `build/icon.png`;
electron-builder derives the platform icon formats from there. Output lands in
`release/`.

## Privacy guarantees, precisely

- One shared **non-persistent** session — storage is in RAM and gone on quit.
- `DNT: 1` and `Sec-GPC: 1` injected on every outgoing request.
- All permission prompts denied by default.
- No NTLM / HTTP-auth credential persistence.
- **No telemetry, no analytics, no external calls** — the only network traffic
  is the page content you ask for and the adblock filter lists.

---

<div align="center"><sub>Ephemeral by design. Nothing is written to disk.</sub></div>
