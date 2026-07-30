# Manga Sub Desktop

An Electron prototype for the embedded comic reader described in
`docs/EMBEDDED_READER_PRODUCT_PLAN.md`. It intentionally lives independently of
the extension and mobile projects.

## Run

```bash
cd desktop
npm install
npm run dev
```

Use the included licensed sample first, or paste an `http(s)` chapter URL. The
remote reader runs in a sandboxed, context-isolated `WebContentsView`. Popup
windows and all web permissions are denied; the app does not import cookies
from other browsers.

## Commands

```bash
npm test       # domain and migration checks
npm run dev    # Electron development app
npm run build  # unpacked macOS/Windows Electron artifact for the host platform
npm run dist   # installable artifact
```

## Prototype boundary

The reader discovers image candidates, freezes the exact snapshot with the
broker, fetches only the registered image through the reader's own session
(cookies + referrer), checks redirect/MIME/32 MiB/SHA-256 bounds, then uploads
it to the immutable broker job. It polls to `SETTLED` and renders only broker
supplied overlay regions with a matched model receipt. Set the broker endpoint
in Settings (the local default is `http://127.0.0.1:4100`). Tokens use Electron
`safeStorage` when available.

The included `file:` chapter is explicitly **sample mode**: it never uploads
assets and cannot pretend to be a translation result. Start the broker (and
the configured Manga Sub Cloud or local route before translating a real HTTP(S) chapter.
