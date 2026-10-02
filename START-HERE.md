# Open Dot for Windows

Windows prototype based on upstream commit `f838e17cf5c3a88ade5ceea54680a8145d048c1d`. Build commands and validation scope are in `docs/windows-prototype.md` in the source repository.

This is a **release candidate for local evaluation**. Public distribution is blocked pending upstream redistribution permission; signing and live-provider verification are also outstanding. See **PUBLIC-RELEASE-STATUS.md** and **PRIVACY.md** before release.

## Launch

After building, the ZIP and installer are in `dist`. The complete unpacked application is `dist\win-unpacked\Open Dot.exe`. No public Windows download is included in this prototype contribution.

1. Extract **Open Dot-0.1.0-win.zip** completely into a folder.
2. Open **Open Dot.exe** in that extracted folder. Keep its `resources`, `locales`, DLLs and other files together.
3. Create a dot. Open Settings and add your OpenAI or OpenRouter key there to enable AI tasks. Do not put keys into chat.

Alternatively, run **Open Dot Setup 0.1.0.exe** to install the application for your Windows user. Both application formats are unsigned. The installer and installed executable were tested on Windows 11 x64; other Windows configurations have not been independently tested.

Node, pnpm and Chrome are not needed to launch the packaged app. Chromium is included; installed Chrome is preferred when available. A particular website may still restrict automated or headless sign-in. Network access and provider accounts are needed for AI, OAuth and cloud features.

Closing the window leaves Open Dot running in the notification-area tray. Double-click its tray icon, choose **Open Open Dot**, or launch the app again to reopen. Choose **Quit Open Dot** in the tray menu to stop the app and its server/browser processes. Agents and routines require the PC to stay awake and the app to remain running, including when an E2B computer is selected.

## Accounts and local execution

OpenAI/OpenRouter: add a key in Settings and choose the model using the existing controls. Composio apps require account connection; developer triggers may also require Composio configuration. E2B requires an E2B key and an eligible plan. These paid/account integrations were retained but were not exercised with your accounts or credits.

Local commands use Windows PowerShell and ask for approval by default. A dot's local workspace is a folder, not an operating-system sandbox. The separate access switch controls the user-machine command tool. Docker mode requires a working Linux Docker engine; E2B uses a Linux cloud desktop. Browser takeover operates the dot's browser, rather than arbitrary Windows applications.

## Data and recovery

Normal app data is stored beneath `%APPDATA%\Open Dot` (`data` and `server.log`). The ZIP makes the program portable; its saved credentials are bound to your Windows user through DPAPI. Copying the app or data to a different user or machine does not guarantee credential recovery. Keep the complete data folder and a recoverable Windows-user/profile backup. On another account, start with a fresh app profile and re-enter credentials through Settings; this delivery has no cross-account credential export/rekey tool. Never delete or replace a vault key to repair an existing vault.

Existing valid plaintext Windows `vault.key` files migrate to DPAPI only after successful verification. Corrupt, conflicting or missing keys with existing encrypted records cause an error and retain data instead of generating a replacement. Credentials remain AES-256-GCM encrypted in SQLite; chats, workspaces and browser profiles are not all encrypted by this vault.

The server binds only to `127.0.0.1`, normally port 3100. If another app occupies the port, quit that app and reopen Open Dot. Startup errors name the log location. Do not expose this local application through public port forwarding.

## Source and rebuild

**Open Dot Windows Source.zip** contains the source, frozen lockfile and runnable checks, without dependencies or user data. Run the commands below from the extracted source folder.

On a development machine with Node 24 and npm, run these commands in the extracted source folder:

```powershell
npm exec --yes --package=pnpm@12.5.1 -- pnpm install --frozen-lockfile
npm run desktop:build:win
npm run test:windows
npm run test:desktop:win
npm run test:security:win
npm run test:userflows:win
npm run test:approvals
npm run test:logins:win
```

The build downloads the pinned Chromium revision and produces ZIP and NSIS targets in `dist`. It recreates the tray icon and bundles the standalone server/dependencies. For development, run `npm run dev`, then `npm run desktop:dev` in another terminal. `OPEN_DOT_DEV_URL` can select another loopback dev URL. Synthetic acceptance profiles are isolated; no credentials are included in this delivery.

See `docs/windows-prototype.md` in the source repository for test evidence and limitations. All recorded provider tests were offline; configure accounts only when you intend to make live requests.

The application folder includes Electron/Chromium notices and `resources/notices` with available dependency licenses, Chromium credits and font licenses. `THIRD-PARTY-LICENSE-REVIEW.md` in the source repository records remaining notice/provenance gaps.
