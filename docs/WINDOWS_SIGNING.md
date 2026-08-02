# Windows release

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

The public Windows installer is built on a GitHub-hosted Windows runner and
uploaded with a SHA-256 sidecar. It is currently unsigned because no Windows
certificate is being purchased. The workflow checks that the installer is
actually unsigned before publishing it, so the release does not make a false
signing claim.

## Download and open

1. Download `Manga-Sub-win-x64.exe` and its matching
   `Manga-Sub-win-x64.exe.sha256` from the [latest release](https://github.com/nhocconan/comic-sub-multiligual-comic-reading/releases/latest).
2. Check the hash in PowerShell:

   ```powershell
   Get-FileHash .\Manga-Sub-win-x64.exe -Algorithm SHA256
   ```

   The result must match the single hash in the `.sha256` file.
3. If the file has a security block, right-click it → **Properties** → tick
   **Unblock** → **Apply**.
4. Open it. For the SmartScreen dialog, select **More info** → **Run anyway**
   only when the hash matches and the file came from the project release page.

Do not disable Defender or SmartScreen globally. A future trusted-signing
service can remove the warning, but it is not required to build from this
public source repository.

## Rebuild it yourself

The same build is reproducible on GitHub Actions or a local Windows machine:

```powershell
npm ci --prefix desktop
npm run dist:win --prefix desktop
```

The release workflow is
[`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml).
It checks out the requested tag, builds `Manga-Sub-win-x64.exe`, asserts
`Get-AuthenticodeSignature` returns `NotSigned`, creates the SHA-256 sidecar,
and uploads both files to the matching GitHub release.
