# Changelog

## 1.7.1 - Scrollable chip row, and previews of the real UI

- The contextual popover's action row read as clipped rather than scrollable;
  the trailing-edge fade is back.
- Added `test/ctx-preview.html` and `test/render-previews.mjs`, offline
  harnesses that render the real `styles.css` over Obsidian's theme variables,
  and moved the theme variables into a shared `test/obsidian-theme.css`.
- Rewrote the README around those renders: corrected the required Obsidian
  version (1.7.2, not 1.4.0), completed the provider list, and moved the
  Cloudflare section out from under the License heading.


## 1.7.0 - Pinnable contextual popover and theme-aware chat

- Redesigned the selection popover: one header row, a collapsed quote of the selection, scrollable action chips, and a single composer, all built from Obsidian's own theme variables.
- Added a placement choice for the popover — follow the selection, or keep it on one fixed spot. Dragging it by its header pins that spot and remembers it.
- Added a "Show on selection" toggle so the popover can be opened from the command or editor menu only.
- Fixed the chat panel in light themes: surfaces, borders, and shadows now derive from theme-aware tokens instead of hardcoded white/black tints.
- Moved the popover into `src/selection-popover.ts` with a scoped `Component` lifecycle instead of a `document.body` MutationObserver.
- Removed ~30 KB of superseded popover CSS that had accumulated across five redesign layers.
- Switched vault tool calls to `getFileByPath` / `getFolderByPath`, `cachedRead` for read-only reads, and `process` for atomic edits.
- Moved static styling out of TypeScript into `styles.css`.
- Release builds now also publish a zip containing `main.js`, `manifest.json`, and `styles.css`.

## 1.6.3 - Reliable GitHub release metadata

- Fixed the reasoning brain icon and circular orbit animation.
- Synchronized manifest, package, lockfile, and versions metadata.
- Simplified the GitHub release workflow around Node.js 20 without cache or attestations.
- Added tests before production build and release creation.

## 1.2.0 - Cloudflare Workers AI native client

- Added native Cloudflare Workers AI provider with Account ID + API Token authentication.
- Added automatic Workers AI model catalog sync using Cloudflare's live model search endpoint.
- Added cached model metadata, capability inference, connection status, manual sync, and diagnostics.
- Added shared provider/model typing for future providers and multimodal message parts.
- Added OpenRouter and Ollama as first-class provider types while preserving OpenAI-compatible behavior.
- Added Cloudflare streaming adapter with human-readable authentication, rate-limit, timeout, and outage errors.
- Added capability badges and model metadata foundation for smart UI controls.
- Added Cloudflare model explorer / capability matrix in settings.

## 1.1.14

- Original attached release.

## 1.2.1 - Cloudflare OAuth connection

- Added a prominent **Connect Cloudflare** action to provider settings.
- Added Cloudflare OAuth Authorization Code flow with PKCE for desktop clients.
- Added browser-based consent, CSRF state validation, localhost callback, token exchange, refresh, revocation, and disconnect.
- Added automatic account discovery and account selection when more than one account is authorized.
- Added automatic access-token refresh before model sync and chat requests.
- Hid manual Cloudflare token fields by default while retaining them in Developer Mode for backward compatibility.

## 1.3.0 - Settings redesign and simplified Cloudflare consent

- Rebuilt the settings experience as a responsive control center with Providers, Chat, Tools, and Advanced tabs.
- Added a compact status hero, clearer provider cards, accessible focus states, responsive layout, and reduced-motion support.
- Simplified Cloudflare setup to one primary **Connect Cloudflare** action.
- Cloudflare consent now always opens explicitly and requests every scope configured on the registered OAuth client; Cloudflare remains the source of truth and displays the complete permission list before approval.
- Moved publisher OAuth Client ID configuration and diagnostics into Advanced settings.
- Preserved API-token fallback behind Developer Mode.

## 1.3.1 - OAuth permission diagnostics

- Fixed the misleading callback success message; approval is now distinguished from a completed connection.
- Added explicit detection for zero-scope OAuth tokens.
- Added actionable errors for `invalid_client`, incorrect callback URLs, missing account permissions, and unusable OAuth tokens.
- Added a Cloudflare OAuth configuration checklist in Advanced settings.
- Required OAuth permissions are now documented as Account Settings Read, Workers AI Read, and Workers AI Edit.

## 1.3.2 - Minimal settings layout

- Reduced the settings UI to a compact header and four simple categories.
- Removed decorative tab icons, subtitles, oversized surfaces, and the long inline model matrix.
- Provider settings now show only the active provider; switching the active provider updates the configuration card.
- Cloudflare displays only Connect, model, account, and status controls by default.
- Raw provider fields, manual Account ID, token fallback, headers, and capability overrides remain available only in Developer Mode.

## 1.4.0 - Official Workers AI connection flow

- Replaced the default experimental OAuth button with Cloudflare's documented Workers AI REST API setup.
- Added a focused setup dialog that opens Workers AI → Use REST API, accepts Account ID and the generated Workers AI API token, verifies both, and loads the live model catalog before saving.
- Added explicit Free-plan messaging for the 10,000 Neurons/day allocation.
- Kept OAuth only as an Advanced experimental publisher option because Cloudflare OAuth requires a pre-registered client with scopes; it is not the documented Workers AI onboarding flow.
- Direct inference continues to use `POST /accounts/{account_id}/ai/run/{model}` with Bearer authentication.

## 1.4.1 - Model labels and settings polish

- Fixed Workers AI catalog parsing to use canonical model names instead of Cloudflare internal UUIDs.
- Deduplicated models and rejected UUID-only catalog records.
- Model dropdowns now use friendly cached model labels while preserving canonical `@cf/...` IDs for API calls.
- Removed the Extra Headers setting from the UI.
- Removed experimental OAuth, OAuth Client ID, OAuth checklist, and Developer Mode controls from Advanced settings.
- Fixed action alignment, inline-start padding, provider-card spacing, section gaps, mobile stacking, and Add Provider button layout.

## 1.5.0 - Schema-aware Workers AI multimodal requests

- Fixed Cloudflare error 7000 by preserving the `@cf/vendor/model` path hierarchy instead of URL-encoding slashes into one route segment.
- Text-generation models now use Cloudflare's official OpenAI-compatible `/ai/v1/chat/completions` endpoint with the model in the JSON body.
- Added on-demand model schema discovery through `/ai/models/schema?model=...`, cached per account/model.
- Added schema-aware direct `/ai/run/@cf/...` payloads for image generation, vision, speech recognition, text-to-speech, embeddings, and other non-chat tasks.
- Added base64 and byte-array fallbacks for image/audio inputs where model schemas differ.
- Added image/audio attachment selection to the chat composer with compact removable attachment chips.
- Added in-chat rendering for generated images and audio players/download links.
- Added clearer errors when a selected model requires an image or audio attachment, rejects its input schema, or has a stale route.

## 1.5.1 - Correct task routing and adaptive model settings

- Fixed text models such as Gemma being misclassified as speech models because nested output schema fields were treated as the model's primary task.
- Persisted Cloudflare's catalog task for the selected model and now route primarily by that authoritative task.
- Added Phoenix and other binary image responses with JPEG, PNG, and WebP magic-byte detection before JSON parsing.
- Added WAV and MP3 binary detection for speech models.
- Added model-specific inference overrides stored separately for each provider/model pair.
- Rebuilt the in-chat model settings popover from the selected model's live Cloudflare input schema.
- Only supported controls are shown, including temperature, output tokens, Top P/K, steps, seed, dimensions, penalties, beam size, VAD, language, audio task, and response format.
- Corrected footer icons for model controls, attachments, prompt actions, and selected-note text.

## 1.5.2 - Reliable tool follow-ups and semantic icons

- Fixed Cloudflare/OpenAI-compatible tool follow-up requests after access or action approval.
- Normalized every message content value to a strict string; assistant tool-call messages now send an empty string instead of null/array content.
- Preserved the model-issued tool call ID when returning approved tool results.
- Added one shared request normalizer for all OpenAI-compatible providers so tool, assistant, user, and legacy content shapes are valid before sending.
- Added deterministic SVG icons for model settings, attachments, prompt actions, selected-note text, audio, and embeddings instead of identical dot fallbacks.
- The model-settings icon now changes by the selected model task: image, audio, embeddings, or text controls.

## 1.6.0 - Unlimited workflows, streamed reasoning, and selection capsule

- Removed the fixed six-round tool-call limit. Runs continue until the model gives a final answer or the user presses Stop.
- Added streaming support for `reasoning_content`, `reasoning`, and `thinking` SSE fields.
- Added a live reasoning card with an animated brain-circuit visual, streaming text, completion state, and collapsible history.
- Added compact streamed reasoning inside the selection-anchored contextual chat.
- Expanded the selection capsule with built-in Summarize, Explain, Rewrite, Translate, Fix writing, and Make tasks actions.
- Improved selection statistics, capsule sizing, pill actions, and Send to main chat / Ask here flows.
- Sorted Cloudflare catalog models deterministically by task, grouped author, recommendation, and natural model name.
- Preferred author groups are Meta, OpenAI, Qwen, Mistral, and Google so a vendor's models stay together instead of appearing scattered.

## 1.6.1 - Integrated Thinking and automatic 400 fallback

- Moved streamed reasoning into the existing Thinking bubble instead of rendering a separate card.
- Thinking expands in place while reasoning streams, then becomes a compact `Thought for …s` row after the final answer starts.
- The completed reasoning can still be expanded or collapsed from the same row.
- Added automatic retry for Cloudflare HTTP 400 responses: OpenAI-compatible streaming first, then schema-filtered native `messages`, then native `prompt` when supported.
- Native fallback removes unsupported options and flattens tool-result messages into valid text roles.
- Added concise errors for models requiring license acceptance or models disabled for the current account.
- Added a dedicated reasoning-stream regression test.
