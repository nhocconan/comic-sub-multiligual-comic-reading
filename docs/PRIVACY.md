# Manga Sub privacy policy

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

Last updated: 2026-08-02

Manga Sub is a reader and translation overlay. It does not crawl a chapter,
export translated pages, or republish comic artwork. This policy describes the
data paths the software can use when the reader explicitly opens a chapter and
chooses a translation route.

## What stays on the device

- The embedded reader URL, browser session, reading position, and local Library
  history remain on the device unless the user uses a configured remote route.
- The desktop and mobile apps keep provider tokens and API keys in the platform
  credential store (macOS Keychain, Android credential storage, or iOS
  Keychain). The browser extension does not store provider keys.
- Local OCR, local Apple Translation, glossary terms, and cached translated
  text/geometry run or remain on the selected device. Comic images are not
  stored in the translated-text cache.
- Private Session is designed not to persist cookies, cache, or reading history
  after the session ends.

## What can leave the device

The user chooses the route before translation starts:

1. **On this device** uses local OCR and Apple/on-device translation. Comic
   pixels and OCR text stay on the device, subject to the operating system and
   language framework behavior.
2. **Manga Sub Cloud or a private broker** may receive selected comic image
   bytes for OCR/rendering, plus bounded page metadata and OCR geometry. The
   broker is configured by its endpoint and should be reached over HTTPS when
   it is not loopback.
3. **Your API key** keeps OCR on the device and sends only bounded recognized
   text, opaque region identifiers, and geometry to the provider selected by
   the user. The provider's own privacy policy and retention rules apply.

The app does not silently switch from a route the user approved to cloud
processing. A job receipt shows the selected route and resolved model when a
translation job runs.

## Third-party services

The project may contact the comic site the user enters, a user-configured
Manga Sub broker, the selected translation provider, and optional approved
series-name research sources when the user enables that setting. Those
services receive only the requests described above and are governed by their
own terms and privacy policies. The project does not sell personal data or use
comic content for advertising.

## Retention and deletion

Local history, glossary data, cached text, credentials, and browser session
data can be cleared from the app's settings or by ending a Private Session.
Remote broker/provider retention is controlled by the operator's configuration
and the selected provider; do not send material to a service unless its
retention policy is acceptable to you.

## Contact

For privacy questions or deletion requests, contact
[nhocconan](https://x.com/nhocconan). Do not send API keys, passwords, or private
comic URLs in a public issue.
