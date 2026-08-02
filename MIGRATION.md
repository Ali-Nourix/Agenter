# Migration notes

This release is backward compatible with existing Agenter settings.

- Existing OpenAI, Anthropic, Gemini, custom, and OpenAI-compatible provider entries are preserved.
- New defaults are added for Cloudflare Workers AI, OpenRouter, and Ollama.
- Cloudflare no longer requires users to paste model endpoints. Enter Cloudflare Account ID and API Token, then sync the catalog.
- Model catalog cache is stored in plugin settings and can be refreshed manually.
- Existing chat sessions, prompts, tool approvals, panel sizes, and provider keys remain unchanged.

Recommended Cloudflare token permissions: Workers AI read/run access for the target account.

## OAuth migration (1.2.1)

Existing Cloudflare API-token configurations continue to work. To switch to OAuth, configure the plugin's public Cloudflare OAuth Client ID once, then click **Connect Cloudflare**. After successful consent, Agenter discovers the account ID and syncs the model catalog automatically.

The OAuth client must use:

- Authorization Code grant
- Public client / token authentication method `none`
- PKCE S256
- Redirect URL: `http://127.0.0.1:42813/cloudflare/callback`
- Minimum permissions: **Workers AI Read** and **Account Settings Read**

For distribution to users outside the publisher's Cloudflare account, the OAuth client must be promoted to public and its client domain verified in Cloudflare.

## Workers AI official authentication (1.4.0)

Cloudflare's Workers AI REST API documentation uses an Account ID and a Workers AI API token. Agenter now uses that documented flow by default. Existing valid Cloudflare token configurations remain compatible. Experimental OAuth is retained in Advanced settings only for publishers who have registered and approved a scoped Cloudflare OAuth client.
