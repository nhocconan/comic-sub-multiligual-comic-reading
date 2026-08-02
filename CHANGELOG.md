# Changelog

## [0.2.4] - 2026-08-02

### Added

- Download links for signed macOS and Windows desktop builds.
- Non-blocking copyright attribution linking to nhocconan on desktop, browser,
  iOS setup, Android settings, and project documentation.
- A GitHub Actions Windows release job that refuses to publish without the
  configured signing certificate.

### Changed

- The Library heading now stays on one line on desktop and wraps only on narrow
  mobile layouts.
- Desktop package names and scripts now produce stable latest-release asset
  names for macOS and Windows.

### Fixed

- External attribution links in the desktop shell open outside the embedded
  reader instead of navigating the app window.
