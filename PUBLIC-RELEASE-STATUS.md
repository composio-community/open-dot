# Windows public release status

Updated October 2, 2026. Target: maintainer review of Windows x64 support before a public download.

**Windows prototype prepared for review; public release remains blocked.** No download has been published and no provider account was connected during the offline validation.

## Release requirements

| Requirement | Status | Evidence or next step |
| --- | --- | --- |
| Upstream redistribution permission | Requires maintainer clarification | The base/current upstream repository has no detected license file. Please clarify the intended license and permission for distributing modified Windows builds. This contribution does not add or assume an upstream application license. |
| Windows signing | Pending publisher setup | Final delivered application and installer are both NotSigned. No signing variables or CurrentUser code-signing certificate were configured in this environment. A builder log saying “signing” is not proof of a valid signature. |
| Live provider acceptance | Unverified | Validation used offline/synthetic fixtures. OpenAI Responses, OpenRouter, Realtime voice, Composio sign-in/triggers and E2B provisioning require separate live acceptance with authorized test credentials. |
| Release validation | Passed within offline scope | Packaged executable acceptance, same-version installer reinstall/uninstall and archive checks passed on one Windows 11 x64 machine. The review guide records commands, dates and scope; runnable checks write local evidence under `.windows-check-output/evidence`. This does not cover live providers or other Windows environments. |
| Third-party notices | Prepared, review pending | Windows packages include dependency license texts, pinned supplemental sources, exact bundled Chromium credits, and Geist/JetBrains Mono licenses under resources/notices. Inventory: 308 installed packages; 8 formerly missing texts now supplemented from recorded sources, 6 still lack a preserved text; 46 unresolved optional/peer references. packages.json and PROVENANCE.json record the details. This is an inventory, not a legal clearance. |
| User guide and privacy information | Prepared | START-HERE.md and PRIVACY.md describe setup, data location, provider transfers, credentials, local execution and recovery. |
| Supported platform | Limited verified coverage | Windows 11 x64 on this test machine. Other Windows releases, ARM64, clean virtual machines, screen readers and enterprise lockdown configurations remain unverified. |

The absent upstream license is visible in the [upstream repository](https://github.com/composio-community/open-dot). [GitHub’s licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) explains the distinction between a public repository and a redistribution license. No license for the upstream application has been invented or added.

## Corrections in this candidate

- Full loopback origins, including scheme and port, are checked. Opaque Origin:null uploads and unrelated localhost ports are rejected. Only the OAuth GET callback has a cross-site navigation exception.
- The same guard runs before mutation requests reach Next.js Server Actions, covering untrusted Host and forged forwarded-host requests as well as the API handlers.
- Missing OAuth codes show a sign-in error rather than claiming success.
- Locked attachment deletion reports a retryable UI error and retains the dot, canonical attachment and database row.
- Removing a selected channel lead clears the selection before creating the channel.
- Approval review failures cannot silently allow ruled actions. Never rules block when review is unavailable or malformed; built-in refusals remain refusals.
- Shared rule guidance states the tested precedence: Never allow, then Ask first.
- Saved-login autofill checks the exact saved HTTPS origin in the same synchronous browser evaluation as field filling. HTTP, different sites, lookalike hosts and unlisted subdomains are refused.
- Available third-party notices accompany the packaged runtime. The unused second Chromium headless binary is excluded.
- Supplemental notices include protobuf's BSD attribution and version-specific source provenance; their hashes are checked during preparation and delivery.
- Delivery retains the previous extracted application folder instead of deleting it, preserving any files placed beside the application.

## Offline checks

```powershell
npm run lint
npm exec -- tsc --noEmit
npm run test:approvals
npm run test:logins:win
npm run test:windows -- --bundled
npm run desktop:build:win
npm run test:desktop:win
npm run test:security:win
npm run test:userflows:win
```

The rule-gate check uses synthetic model responses. Browser/security and UI checks use real Windows processes with fresh synthetic profiles. Passing these checks does not establish paid-provider readiness or legal permission to publish.
