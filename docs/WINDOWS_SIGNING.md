# Windows signing

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

The Windows release workflow builds on a GitHub-hosted Windows runner, sends
the installer to SignPath for Authenticode signing, verifies the returned
signature, and uploads only the verified file to the GitHub release. GitHub
Actions supplies the build machine; it does not supply a trusted Windows
certificate by itself.

## Free OSS route

[SignPath Foundation](https://signpath.org/) is the no-cost route for qualifying
open-source projects. It requires an OSI-approved license for every component,
an already-released and documented project, maintainer ownership, MFA, and
manual approval for each release. The certificate is issued to SignPath
Foundation and the private key remains in its managed signing service.

This repository is public but currently has no declared OSS license. Do not
claim that a Windows artifact is SignPath-signed until the maintainer chooses a
license, the application is approved, and the SignPath project is configured.

## Repository configuration

After approval, install the SignPath GitHub App for this repository and add:

- secret `SIGNPATH_API_TOKEN`;
- variable `SIGNPATH_ORGANIZATION_ID`;
- variable `SIGNPATH_PROJECT_SLUG`;
- variable `SIGNPATH_SIGNING_POLICY_SLUG`.

The workflow at [`.github/workflows/release-desktop.yml`](../.github/workflows/release-desktop.yml)
uses those names. A tag push or a manual run for an existing tag then builds
`Manga-Sub-win-x64.exe`, submits it, checks `Get-AuthenticodeSignature`, writes a
SHA-256 sidecar, and uploads the two verified assets. Missing configuration is
an intentional hard failure.

SignPath's required public policy wording, once the project is approved, is:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation

The public policy must also name the committers/reviewers, approvers, and link
the project's [privacy policy](PRIVACY.md).
