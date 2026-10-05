# Open Dot for Windows: data and privacy

Prepared for the Windows release candidate on September 30, 2026. Public distribution requires the permission and validation recorded in PUBLIC-RELEASE-STATUS.md.

## Data on this computer

The normal profile is `%APPDATA%\Open Dot`. Its `data` folder holds the SQLite database, dot workspaces, attachments and browser profiles. `server.log` contains server diagnostics. An explicitly configured portable/test profile can use a different location.

Chats, memory, rules, skills, schedules, attachment contents and workspace files are not encrypted by the password vault. Browser profiles may contain active sessions and other sensitive information; they are not covered by the application vault. Protect the complete Windows user profile and its backups.

Saved API keys, OAuth tokens and website passwords use the application’s AES-256-GCM vault. On Windows the vault’s key is protected by CurrentUser DPAPI. Moving a profile to another Windows user or machine may make these secrets unreadable. The application refuses to replace a missing/corrupt key when encrypted records already exist.

Saved-login autofill requires approval and checks the exact HTTPS origin saved in Settings. A login that redirects to a different domain must be completed through browser takeover, or saved for the correct domain. The visited website receives credentials when filled. Credentials are kept out of model tool arguments and results, but an approved website, authorized local command, or a compromised Windows user session can access sensitive information.

## Data sent to services

When you enable a model provider, its requests can include your message, instructions, relevant memory/rules/skills, tool results, selected attachments, and browser screenshots or page content. OpenAI and OpenRouter process the requests routed to them; their policies and account settings govern retention and billing. Voice mode sends microphone audio to the configured OpenAI Realtime service when used.

Selected model routers, including Command Code, receive the same relevant conversation/tool data and the credential for their configured API endpoint. Command Code requests go to its Provider API and may be forwarded to its upstream model providers under its policies and your plan settings. Each router key is stored separately and is not tried against other services. Adding a provider or loading its public model catalog does not verify authenticated inference, credit or retention behavior.

Composio receives sign-in/connection data and the app actions you authorize. Connected services receive the corresponding requests. Trigger configuration is stored locally and registered with the configured Composio project when enabled. App logos and connection metadata can involve requests to Composio services.

Visited websites receive ordinary browser requests, session cookies and any information entered into their pages. E2B receives files, commands, browser activity and credentials used inside its cloud computer when cloud mode is enabled. Local/Docker execution runs on this machine; it is not an encrypted vault or a restriction on arbitrary approved shell commands.

The offline acceptance checks use synthetic local data and blank provider keys. Live provider privacy behavior, sign-in flows and retention settings were not independently verified in this audit.

## Deletion and recovery

Deleting a dot removes its local records, attachments and workspace when cleanup succeeds. A Windows lock produces an error so you can close the program holding the file and retry. Deleting a local dot does not prove that a provider has deleted remote request logs, cloud snapshots, existing OAuth grants or copies already downloaded/shared elsewhere.

Quit Open Dot from its tray before backing up the complete profile. Uninstalling the application may retain user data; inspect the profile after uninstall if you want to remove it. Remove provider grants and keys through the respective provider accounts when appropriate. This release has no cross-account credential export/rekey feature.

Share only the diagnostics needed to reproduce a problem. Review logs, screenshots and workspaces before sending them to anyone, since errors and page content may contain private information.
