# Comic Sub for iPhone and iPad

The Apple project is at:

```text
apple/Manga Sub/Manga Sub.xcodeproj
```

The display name uses Unicode, so the folder may appear with decomposed accents
in Terminal. Open the project from Finder or use the quoted path.

## Architecture

The iOS app contains a Safari Web Extension. Its Xcode target references the
same files in `extension/` used by desktop Chrome:

- `background.js`
- `content.js` and `content.css`
- `popup.html`, `popup.js`, and `popup.css`
- `manifest.json`, icons, and `lib/core.js`

There is no forked iOS translation implementation to drift out of sync. Chrome,
iPhone, and iPad all call the same Koharu-compatible backend. On mobile the
endpoint must normally be remote HTTPS because `127.0.0.1` refers to the phone
or tablet itself.

## Build in Simulator

Xcode 26.4 or later:

```bash
xcodebuild \
  -project "apple/Manga Sub/Manga Sub.xcodeproj" \
  -scheme "Manga Sub" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.4" \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Replace the destination with an available iPad simulator to test the tablet
layout. Simulator builds do not require an Apple Developer Program membership.

## Install on a real iPhone or iPad

1. Open the Xcode project.
2. Select the **Manga Sub** project, then both app and extension targets.
3. Under **Signing & Capabilities**, choose the same Apple development team for
   both targets.
4. Keep bundle IDs related:
   - App: `com.tienle.comicsub`
   - Extension: `com.tienle.comicsub.Extension`
5. Select the connected device and press Run.
6. On the device, open **Settings → Apps → Safari → Extensions → Comic Sub**.
7. Enable it and grant access to the comic site.
8. In Safari, open Comic Sub from the extensions button. Under settings, enter
   the remote backend URL and optional auth key.

If the bundle IDs are already owned by another Apple account, change the common
prefix in both targets while keeping the extension ID beneath the app ID.

## TestFlight and App Store

1. Create the app record and matching identifiers in App Store Connect.
2. In Xcode choose **Product → Archive** with a generic iOS device destination.
3. In Organizer choose **Distribute App → App Store Connect → Upload**.
4. Add the uploaded build to an internal TestFlight group first.
5. Verify extension enabling, domain permissions, remote authentication, and a
   full chapter on both iPhone and iPad before external testing or review.

The containing app explains how to enable the extension and warns that mobile
requires a reachable HTTPS backend. Provider keys remain only on the backend;
the mobile extension stores only the backend URL and optional reverse-proxy
Bearer token.

## Release checklist

- Set a unique signing team and production bundle IDs.
- Replace the development icon if desired.
- Use a TLS-valid remote endpoint; never expose Koharu port 4000 publicly.
- Rotate the reverse-proxy auth key before sharing a TestFlight build.
- Test a clean install so Safari permission prompts are covered.
- Complete App Store privacy answers based on the actual server retention
  policy. Comic page images go to the selected backend; OCR text may go to the
  selected translation provider.
