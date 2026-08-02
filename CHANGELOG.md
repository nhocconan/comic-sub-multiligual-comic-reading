# Changelog

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

## [0.2.5] - 2026-08-02

### Added

- A GitHub Actions Windows x64 installer build with a SHA-256 sidecar.
- First-launch guidance for the intentionally unsigned Windows installer.

### Fixed

- Windows desktop builds now install Pillow for icon generation and skip the
  macOS-only `iconutil` step.

## [0.2.4] - 2026-08-02

### Added

- A signed macOS desktop download and a fail-closed Windows desktop build
  workflow.
- Non-blocking copyright attribution linking to nhocconan on desktop, browser,
  iOS setup, Android settings, and project documentation.
- A GitHub Actions Windows release job that refused to publish without a
  signing certificate; the public unsigned Windows build arrived in 0.2.5.

### Changed

- The Library heading now stays on one line on desktop and wraps only on narrow
  mobile layouts.
- Desktop package names and scripts now produce stable latest-release asset
  names for macOS and Windows.

### Fixed

- External attribution links in the desktop shell open outside the embedded
  reader instead of navigating the app window.
