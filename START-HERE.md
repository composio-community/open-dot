# Open Dot for Windows

Windows prototype based on upstream commit `f838e17cf5c3a88ade5ceea54680a8145d048c1d`. Build commands and validation scope are in `docs/windows-prototype.md` in the source repository.

This is a **release candidate for local evaluation**. Public distribution is blocked pending upstream redistribution permission; signing and live-provider verification are also outstanding. See **PUBLIC-RELEASE-STATUS.md** and **PRIVACY.md** before release.

## Launch

After building, the ZIP and installer are in `dist`. The complete unpacked application is `dist\win-unpacked\Open Dot.exe`. No public Windows download is included in this prototype contribution.

1. Extract **Open Dot-0.1.0-win.zip** completely into a folder.
2. Open **Open Dot.exe** in that extracted folder. Keep its `resources`, `locales`, DLLs and other files together.
3. Create a dot. In Settings add an OpenAI key, or choose your provider under **Model routers** and save its key. OpenRouter defaults to `openrouter/free` for chat, titles and rule review. Previous explicit model selections are retained: if you chose a paid model, select `openrouter/free` under Settings > Default model, then set the dot's model to Default or `openrouter/free`. OpenRouter, TokenRouter, AgentRouter and NaraRouter have separate connections. Do not put keys into chat.

Alternatively, run **Open Dot Setup 0.1.0.exe** to install the application for your Windows user. Both application formats are unsigned. The installer and installed executable were tested on Windows 11 x64; other Windows configurations have not been independently tested.

Node, pnpm and Chrome are not needed to launch the packaged app. Chromium is included; installed Chrome is preferred when available. A particular website may still restrict automated or headless sign-in. Network access and provider accounts are needed for AI, OAuth and cloud features.

Closing the window leaves Open Dot running in the notification-area tray. Double-click its tray icon, choose **Open Open Dot**, or launch the app again to reopen. Choose **Quit Open Dot** in the tray menu to stop the app and its server/browser processes. Agents and routines require the PC to stay awake and the app to remain running, including when an E2B computer is selected.

## Accounts and local execution

**Command Code:** In Settings > Model routers, select Command Code, keep `https://api.commandcode.ai/provider/v1`, and save the API key from Command Code Studio. Select a Command Code model in your bot's header; to use it across bots, choose it in Settings > Default model and leave each bot set to Default. Both Claude and GPT/open chat models are supported. Your plan must include API access; the Go plan does not. Saving lists public models, while a chat checks actual key/model/credit access. This integration was tested with synthetic APIs only. Command Code accepts text/images, rather than direct PDF/file/audio inputs. Voice still requires OpenAI.

OpenAI/model routers: add a key in Settings and choose a model under the matching provider heading. TokenRouter services on `.com`, `.io` and `.me` have separate presets; confirm the issuer and displayed API URL. Router credentials are sent only to that selected endpoint. If `/models` is unavailable, enter exact model IDs from your dashboard. Voice still requires a genuine OpenAI key. See `docs/model-routers.md` in the source repository. Composio apps require account connection; developer triggers may also require Composio configuration. E2B requires an E2B key and an eligible plan. Live provider access and paid requests have not been tested.

Local commands use Windows PowerShell. To reduce repeated prompts, open your dot's **Setup (sliders) > Approval mode & rules**, or use **Approvals** in its chat header on larger screens:

- **Ask when needed:** the bot's selected model reviews each sensitive action/command, allowing clearly routine workspace work and asking for risky or uncertain effects. A failed review still asks. These reviews use your configured provider and may consume tokens.
- **Ask before actions:** preserves the earlier default: local commands and sensitive actions ask first.
- **Auto approve:** commands and actions run without ordinary approval prompts, including changes on your PC and in connected apps. It overrides stored Ask first rules; Never allow rules and built-in safety checks still apply. Choose this only for a dot you trust with those tasks.

The mode persists per dot across chats, routines and restarts. Approve or deny a request that was already waiting once; the new mode applies to following actions. **Never allow** rules and built-in safety checks still apply in every mode. **Ask first** rules are retained and apply again when you leave Auto approve. Auto approve does not depend on a reviewer when no Never allow rules exist, even if you have old Allow/Ask rules. Actual questions and OAuth connections still require your input. Rule matching and balanced risk assessment use a model, rather than an OS security boundary. **Always allow** on a card saves a rule for that particular action; choose a mode to cover changing commands.

A dot's local workspace is a folder, not an operating-system sandbox. The separate access switch controls the user-machine command tool; changing approval mode does not grant that access. Docker mode requires a working Linux Docker engine; E2B uses a Linux cloud desktop. Browser takeover operates the dot's browser, rather than arbitrary Windows applications.

## Data and recovery

If an older chat reports HTTP 400 about missing `tool_calls` results, quit the old app from its tray menu, open the updated executable, and send a new message such as “Continue.” The updated app repairs incomplete router history on the next request while preserving the chat and any recorded results. Missing results are marked as interrupted with an unknown execution outcome; recovery does not execute the old actions again. Ask the bot to check their state before retrying anything that changes data.

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
npm run test:routers
npm run test:tool-history
```

The build downloads the pinned Chromium revision and produces ZIP and NSIS targets in `dist`. It recreates the tray icon and bundles the standalone server/dependencies. For development, run `npm run dev`, then `npm run desktop:dev` in another terminal. `OPEN_DOT_DEV_URL` can select another loopback dev URL. Synthetic acceptance profiles are isolated; no credentials are included in this delivery.

See `docs/windows-prototype.md` in the source repository for test evidence and limitations. All recorded provider tests were offline; configure accounts only when you intend to make live requests.

The application folder includes Electron/Chromium notices and `resources/notices` with available dependency licenses, Chromium credits and font licenses. `THIRD-PARTY-LICENSE-REVIEW.md` in the source repository records remaining notice/provenance gaps.
