# Windows desktop prototype

This contribution proposes Windows x64 support for maintainer review. It keeps the existing application interface and adds Windows startup, packaging, command execution and credential protection. It includes source and runnable checks; packaged application downloads are not part of the contribution.

![Packaged Open Dot on Windows with a synthetic dot and no provider key](windows-prototype.png)

The screenshot comes from a real packaged Electron launch on Windows 11 x64. The dot, profile and all test credentials are synthetic; it does not demonstrate a live model response.

## Build and run

Use Node.js 24 and npm from the repository root:

```powershell
npm exec --yes --package=pnpm@12.5.1 -- pnpm install --frozen-lockfile
npm run desktop:build:win
```

Build preparation downloads the pinned full Chromium revision. Outputs are `dist/Open Dot-0.1.0-win.zip`, `dist/Open Dot Setup 0.1.0.exe` and `dist/win-unpacked/Open Dot.exe`. Keep the unpacked executable with its adjacent runtime files. The packaged app needs no separate Node, pnpm or Chrome installation.

For development, run `npm run dev`, then `npm run desktop:dev` in another terminal. Quit Open Dot completely before running packaged acceptance checks, since its loopback server normally uses port 3100. Closing the window hides it to the tray; **Quit Open Dot** stops its owned server/browser process tree.

## Changes to review

- ZIP/NSIS x64 targets, portable Node filesystem operations, relocatable standalone dependencies and bundled Chromium fallback.
- Windows tray reopen/quit, single-instance behavior, loopback startup identity and diagnostics.
- PowerShell for local commands; Linux/cloud/Docker retain Bash. Forced Docker/cloud execution does not silently fall back to the local machine.
- CurrentUser DPAPI protects the AES-256-GCM vault key. Valid legacy Windows keys migrate after verification; missing/corrupt/conflicting keys retain existing data.
- Workspace traversal/junction/alternate-stream checks, browser-origin guards for API mutations and Server Actions, and exact saved HTTPS-origin autofill.
- Retryable locked-file deletion, channel lead deselection, conservative approval-review failure handling and platform-aware UI descriptions.
- Available dependency/font notices, pinned supplemental notice hashes and credits from the exact bundled Chromium.

## Validation and reproduction

The implementation and packaged candidate were tested locally on September 30 and October 1, 2026, on Windows 11 x64. These are scoped local results, not CI results or a claim of complete product readiness. The October 1 repack changed notices/documents; all 10,224 other runtime files matched the preceding accepted candidate by SHA256.

For this contribution on October 2, lint, TypeScript, the synthetic approval check, intercepted-browser login check and bundled-mode Windows acceptance were rerun and passed. All nine cached supplemental notice hashes were rechecked. The earlier packaged desktop/UI/security/installer results below are retained as dated evidence; they were not rerun for the documentation/test-output-path edits.

| Command | Recorded coverage/result |
| --- | --- |
| `npm run lint` | Passed, zero errors/warnings. |
| `npm exec -- tsc --noEmit` | Passed; production build also compiled the source. |
| `npm run test:windows` and `npm run test:windows -- --bundled` | Passed: actual PowerShell, path boundaries/junctions/alternate streams, DPAPI/AES and migration/refusal, CRUD/persistence and installed Chrome/bundled Chromium fallback. |
| `npm run test:approvals` | Passed: actual review function with synthetic provider responses, conflict precedence, malformed responses and outages. |
| `npm run test:logins:win` | Passed: actual local browser autofill with intercepted HTTPS fixtures and synthetic credentials; cross-origin/HTTP refusals. |
| `npm run desktop:build:win` | Passed: standalone server, bundled browser, portable ZIP and NSIS installer. |
| `npm run test:desktop:win` | Passed against the delivered executable: startup, DPAPI save, uploads/downloads, real browser frames/takeover input, tray close, second process, full quit and restart persistence. |
| `npm run test:security:win` | Passed against the delivered executable: API/Server Action request boundaries and actual browser form/fetch probes. |
| `npm run test:userflows:win` | Passed against the delivered executable: dots/Unicode rename, memory/rules/routines, offline chats, channels, uploads/downloads and a real Windows file-lock failure/retry. |
| `npm run test:installer:win` | Passed: isolated spaces/Unicode install, executable/notice hashes, versioned registration/shortcut targets, installed launch, same-version reinstall persistence and uninstall cleanup. |

`test:desktop:win`, `test:security:win` and `test:userflows:win` use the current `dist/win-unpacked` build by default. Their underlying scripts also accept `--exe "path/to/Open Dot.exe"`. Checks use fresh profiles and blank provider keys. Desktop/security/UI/installer checks must run sequentially, with port 3100 free. Evidence is written inside the clone to `.windows-check-output/evidence` and is ignored by Git.

The installer check refuses an existing Open Dot installation or its shortcuts. Use a clean test Windows account or VM. It installs only into an owned temporary directory and uses a separate synthetic data profile; uninstall preserves that profile during the assertion. This is a same-version reinstall check, not proof of cross-version upgrades or genuine user-profile migration.

## Remaining work and maintainer questions

- Would Windows support be welcome upstream, and would maintainers prefer the compatibility and shared reliability fixes in separate PRs?
- What is the intended application license and permission for distributing modified Windows builds? No application license is added here.
- Both locally produced executables are unsigned; publisher signing remains to be configured.
- Live OpenAI/OpenRouter requests, voice, Composio OAuth/triggers and E2B provisioning were not exercised. Synthetic fixtures cannot establish provider integration success.
- macOS regression testing, a clean Windows VM, Windows 10/ARM64, accessibility acceptance, enterprise restrictions, cross-version upgrades and long-running stability remain unverified.
- Browser takeover controls the dot's browser. Native automation of arbitrary Windows applications is not implemented.
- Local PowerShell runs in a workspace folder, not an OS sandbox. Origin guards are browser-request protection, not authentication against other local processes.
- Third-party notice preparation still needs review; see [the exact provenance/gaps](../THIRD-PARTY-LICENSE-REVIEW.md) and [cached supplemental sources](../scripts/licenses/packages/PROVENANCE.json).

See [START-HERE.md](../START-HERE.md), [PRIVACY.md](../PRIVACY.md) and [PUBLIC-RELEASE-STATUS.md](../PUBLIC-RELEASE-STATUS.md) for setup, recovery and release requirements.
