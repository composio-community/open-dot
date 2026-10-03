# Model routers on Windows

Open Dot stores each router's key separately in its existing encrypted Windows credential vault. Choose the service that issued your key; OpenAI, OpenRouter, TokenRouter, AgentRouter and NaraRouter keys are not interchangeable.

1. Quit the old Open Dot from its tray menu, then launch the rebuilt Windows app.
2. Open Settings, then Model routers. Select your provider.
3. Confirm the API base URL, paste that provider's key and click Save.
4. The app loads the provider's models without generating a paid completion. If the gateway does not expose `/models`, enter exact model IDs from its dashboard in the optional field and save again.
5. Select a model under that provider's heading in the dot's model picker, then send a small test message.

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

Offline verification: `npm run test:routers` exercises actual router modules and the installed OpenAI SDK with synthetic HTTP/SSE responses, selected-endpoint/key isolation, legacy OpenRouter keys, model discovery and manual IDs, stream/tool replay, JSON review, rejected credentials/permissions/quota, secret masking, private endpoint refusals, encrypted restart persistence and refusal to replace a missing vault key. No live keys or billable completions are used.

Packaged desktop acceptance also checks each provider selector, default endpoint, documentation link, and clearing an unsubmitted key when switching providers. These checks do not establish live integration success. Keep a small provider-side spending cap when testing your own account.
