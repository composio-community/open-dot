# Model routers on Windows

Open Dot stores each router's key separately in its existing encrypted Windows credential vault. Choose the service that issued your key; OpenAI, OpenRouter, TokenRouter, AgentRouter and NaraRouter keys are not interchangeable.

1. Quit the old Open Dot from its tray menu, then launch the rebuilt Windows app.
2. Open Settings, then Model routers. Select your provider.
3. Confirm the API base URL, paste that provider's key and click Save.
4. The app loads the provider's models without generating a paid completion. If the gateway does not expose `/models`, enter exact model IDs from its dashboard in the optional field and save again.
5. With OpenRouter configured and no saved model override, leave the dot's model picker on Default to use `openrouter/free`, or select a specific model under its provider heading. Send a small test message.

The automatic OpenRouter default is [`openrouter/free`](https://openrouter.ai/openrouter/free), which selects a free model supporting the request's required tools, images or structured output. Chat titles and rule reviews use the same free dispatcher, including when an OpenAI key is also saved. Explicit dot models, the model selected in Settings, and development `DOTS_MODEL`/`DOTS_REVIEW_MODEL` overrides are preserved. If you previously selected a paid model, choose `openrouter/free` under Settings > Default model, then set the dot's model to Default or `openrouter/free`. Manual model-ID lists are respected; include `openrouter/free` to make the free default available.

The app does not attach OpenRouter's separately billed hosted web-search tool to `openrouter/free` or `:free` models. Existing browser, page-reading and workspace function tools remain available. Free-model quotas and availability still apply; failed free requests are not retried with paid models. A temporary catalog outage on the official OpenRouter endpoint retains the free default. Account-level provider plugins and other explicitly selected paid integrations can still have their own charges. Free routing is not a guarantee about those account settings or model quality.

OpenRouter discovery loads the full `/models` catalog and filters explicit tool capabilities locally. Its server-side `supported_parameters=tools` filter can omit `openrouter/free` even though the full catalog advertises it as supporting tools. The free dispatcher is retained before the picker limit. `node scripts/check-router-picker.mjs` checks the compiled server's visible Settings and dot pickers, selection and persistence with synthetic catalog replies and no model inference; build with `npm run desktop:prepare` first, or pass `--server` and `--browser` paths from the packaged app.

| Selection | Default API base URL | Documentation |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | [Authentication](https://openrouter.ai/docs/api_reference/authentication), [Responses](https://openrouter.ai/docs/api_reference/responses/overview) |
| TokenRouter (tokenrouter.com) | `https://api.tokenrouter.com/v1` | [Connection setup](https://www.tokenrouter.com/docs/zcode-setup/) |
| TokenRouter (tokenrouter.io) | `https://api.tokenrouter.io/v1` | [Chat Completions](https://www.tokenrouter.io/docs/chat-completions) |
| TokenRouter (tokenrouter.me) | `https://tokenrouter.me/v1` | [API documentation](https://docs.tokenrouter.me/) |
| AgentRouter | `https://co.agentrouter.org/v1` | [Official integration guide](https://co.agentrouter.org/portal/guide) |
| NaraRouter | `https://router.bynara.id/v1` | [API documentation](https://router.bynara.id/docs) |

Sources were checked October 2, 2026. Several distinct services use the TokenRouter name. `tokenrouter.ai` could not be verified; it is not silently treated as one of these other domains. The API base URL can be changed to the public HTTPS endpoint specified in your own provider dashboard. Credentials are sent only to that selected endpoint, and redirects are refused.

OpenRouter retains its Responses transport. The other presets use their documented Chat Completions interface, translated into the app's existing conversation/tool flow. Streaming text, function calls/results, image attachments, and structured approval-review responses are supported by the adapter. Actual model capabilities, PDF support and structured-output support depend on the chosen gateway/model. Router models use the app's own conversation history; they do not use OpenAI server-side threads. Provider-hosted OpenAI computer/web-search tools are not sent to these other gateways; the dot's existing page-reading, browser and workspace function tools remain available. Voice still needs a genuine OpenAI key.

Saving verifies an accessible compatible model catalog (and OpenRouter's `/key`). Some gateways expose a public model catalog, so a successful save alone does not prove inference permission, balance or model access. The UI says Saved, and asks you to send a chat to verify that access. A catalog 401/403 is never bypassed using manual model IDs; a missing catalog endpoint can use the explicit IDs you enter.

If Save returns 403, the app shows a shortened provider error and support reference when available, with credentials masked. A website/security response is identified separately from an API permission denial. NaraRouter documents `forbidden` as plan/model access or a suspended account; its authenticated `/models` lists the models the key can access. Check the exact displayed reason in your provider dashboard, or give its support the reference. The documented NaraRouter base URL is `https://router.bynara.id/v1`; changing providers or adding manual model IDs does not fix a denied key. A failed Save retains the previously saved configuration.

Router requests default to at most 2,048 output tokens, rather than relying on the gateway's potentially much larger default. Chat titles use 256 and rule reviews use 512. An explicit caller limit is preserved. The output allowance can include reasoning tokens; it is a per-request limit, not an account spending cap. A 402 means the request exceeds the provider balance or key spending limit: choose an affordable model (including a free model if available on your account), shorten the conversation, or add credits through the provider. An OpenRouter key is sufficient for OpenRouter chat; a separate OpenAI key is only needed for OpenAI-specific features such as voice.

Offline verification: `npm run test:routers` exercises actual router modules and the installed OpenAI SDK with synthetic HTTP/SSE responses, selected-endpoint/key isolation, legacy OpenRouter keys, model discovery and manual IDs, stream/tool replay, JSON review, rejected credentials/permissions/quota, secret masking, private endpoint refusals, encrypted restart persistence and refusal to replace a missing vault key. No live keys or billable completions are used.

Packaged desktop acceptance also checks each provider selector, default endpoint, documentation link, and clearing an unsubmitted key when switching providers. These checks do not establish live integration success. Keep a small provider-side spending cap when testing your own account.
