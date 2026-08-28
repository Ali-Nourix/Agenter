# Agenter

Agenter brings a tool-using AI assistant into Obsidian. Chat in the right sidebar, a movable floating panel, or a compact contextual panel beside selected text. The assistant can work with notes, search the web, use saved prompts, and request approval before changing vault content.

> **Status:** Desktop-only community plugin. Agenter requires your own API key for a supported AI provider.

## Features

- **Three chat modes:** docked sidebar, floating panel, and a contextual popover for the current selection — either beside the caret or pinned to a fixed spot you choose.
- **Multiple AI providers:** OpenAI, Anthropic, Gemini, OpenAI-compatible services, and custom endpoints.
- **Vault-aware context:** work with the current note, current folder, the whole vault, or no automatic context.
- **Tool use:** read and search notes, inspect links and metadata, list folders, summarize content, search the web, fetch URLs, and work with note images when the selected model supports vision.
- **Safe note actions:** create, edit, append, move, and trash notes only after the configured approval step.
- **Recoverable changes:** note mutations create safety backups inside `.agenter-backups`; deletion uses Obsidian's recoverable Trash flow.
- **Shared chat history:** continue the same conversation across the main and contextual panels.
- **Custom prompts:** create reusable prompt actions in settings and access them from **AI Actions**.
- **Markdown rendering:** responses, note previews, code blocks, and internal links render using Obsidian's Markdown renderer.
- **Streaming and live status:** see responses as they arrive, stop generation, and inspect tool progress.

## Requirements

- Obsidian **1.4.0** or newer.
- Obsidian Desktop. Agenter is marked `isDesktopOnly`.
- An API key for at least one supported provider.

## Installation

### From Community Plugins

Once Agenter is listed in the Obsidian Community directory:

1. Open **Settings → Community plugins**.
2. Select **Browse** and search for **Agenter**.
3. Select **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release, or the `agenter-<version>.zip` asset that contains all three.
2. Create this folder inside your vault:

   ```text
   .obsidian/plugins/agenter/
   ```

3. Copy the three release files into that folder, or unzip `agenter-<version>.zip` directly inside it.
4. Restart Obsidian or reload the app.
5. Open **Settings → Community plugins** and enable **Agenter**.

For pre-release testing, you can also install the repository with [BRAT](https://github.com/TfTHacker/obsidian42-brat) after a valid GitHub release exists.

## Setup

1. Open **Settings → Agenter**.
2. Add or edit a provider.
3. Enter the provider's base URL, API key, and model.
4. Use **Test** or **Fetch models** to verify the configuration.
5. Choose a default context scope and review tool approval settings.

API keys are stored locally in Obsidian's plugin data file (`data.json`). They are not encrypted. Do not commit or share that file.

## Usage

- Run **Agenter: Open chat in right sidebar** from the Command Palette, or use the ribbon icon.
- Use the header control to switch between docked and floating modes.
- Select text in a note to open the contextual popover, or run **Agenter: Run AI action on selection**.
- Drag the contextual popover by its header to pin it to one spot; it opens there from then on. The pin button in its header toggles between following the selection and staying put.
- Choose the context chip in the composer to switch between note, folder, vault, and no context.
- Type `/` or select **AI Actions** to use saved prompts.
- Open **Settings → Agenter → Custom prompts** to create, rename, edit, or remove prompt actions.

### Contextual popover

Selecting text opens a compact card with the selected text collapsed behind its word count, a row of quick actions (plus your own custom prompts), and a composer that continues the same conversation as the main panel.

Placement is yours to choose in **Settings → Agenter → Chat → Contextual popover**:

| Setting | What it does |
| --- | --- |
| **Show on selection** | Turn off to keep the popover out of the way; open it from the Command Palette or the editor menu instead. |
| **Placement → Follow the selection** | The popover opens beside the caret, flipping above it when there is no room below. |
| **Placement → Fixed spot** | The popover always opens on one spot. Drag it there once by its header, or reset it to the bottom-right corner. |

Dragging the popover anywhere also switches it to **Fixed spot** and saves where it landed, so "put it here and keep it here" needs no trip to settings.

### Tool approvals

Read-only tools can run automatically. Tools that change vault content can display an approval card before execution. Moving a note to Trash always uses a two-step confirmation.

Agenter's file tools are restricted to the current Obsidian vault and block protected internal paths. Network tools are separate and only run when requested by the conversation.

## Privacy and network access

Agenter does not provide or proxy an AI service. Depending on the tools and provider you use, data may be sent to:

- The configured AI provider or custom API endpoint.
- DuckDuckGo when the `web_search` tool runs.
- A URL requested through the `fetch_url` tool.

Review your provider's privacy policy before sending sensitive notes. Only include the context required for your task.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

Run the included tests:

```bash
npm test
```

The distributable plugin files are:

```text
main.js
manifest.json
styles.css
```

## Releasing

1. Update the version in `manifest.json`, `package.json`, and `package-lock.json`.
2. Add the version and minimum Obsidian version to `versions.json`.
3. Commit and push the changes.
4. Create and push a Git tag that exactly matches the manifest version, without a `v` prefix:

   ```bash
   git tag 1.1.2
   git push origin 1.1.2
   ```

5. The included GitHub Actions workflow validates that the tag, manifest, package, lockfile, and `versions.json` all agree, runs the tests, builds, and creates a GitHub release containing `main.js`, `manifest.json`, `styles.css`, and `agenter-<version>.zip` holding the same three files.

Running the workflow by hand from the Actions tab produces those same files as downloadable artifacts without creating a release.

## Security

If you discover a security issue, do not include private vault content, API keys, or credentials in a public issue. Contact the maintainer privately through the contact method listed on the GitHub profile.

## License

Agenter is released under the [MIT License](LICENSE).

## Cloudflare Workers AI native provider

Agenter now includes a first-class Cloudflare Workers AI provider.

### Setup

1. Open **Settings → Agenter → Providers**.
2. Select **Cloudflare Workers AI** or add a new Cloudflare provider.
3. Enter your **Cloudflare Account ID** and **API Token**.
4. Click **Sync catalog** or **Fetch models**.
5. Pick any available Workers AI model from the live Cloudflare catalog.

No manual model endpoint is required. The plugin builds the Workers AI run URL from your Account ID and selected model.

### Cloudflare features

- Live model discovery from Cloudflare.
- Offline model catalog cache with sync timestamp.
- Capability inference for vision, audio, image generation, embeddings, reasoning, JSON, tool calling, streaming, free/paid, latency, experimental, and deprecated status.
- Human-readable errors for invalid credentials, rate limits, unavailable models, timeouts, and Cloudflare outages.
- Native streaming through the existing Agenter streaming pipeline.
- Tool/function calling routed through the existing approval and execution system.

### Provider architecture

Providers implement a common adapter contract in `src/api.ts`. Shared model and multimodal message types live in `src/provider-types.ts`, and Cloudflare-specific authentication, discovery, and capability inference live in `src/cloudflare.ts`.

### One-click Cloudflare OAuth

The settings screen includes **Connect Cloudflare**. It opens Cloudflare in the default browser, shows Cloudflare's consent screen, returns to Agenter through a localhost PKCE callback, discovers available accounts, and synchronizes Workers AI models. Access tokens refresh automatically and **Disconnect** revokes the authorization.

Plugin publishers must register one public Cloudflare OAuth client before distribution:

- Flow: Authorization Code with PKCE S256
- Token authentication: `none` (public desktop client; do not bundle a client secret)
- Redirect URL: `http://127.0.0.1:42813/cloudflare/callback`
- Permissions: Workers AI Read and Account Settings Read

Paste the resulting Client ID into the one-time publisher field. End users then only need to press **Connect Cloudflare**.

### Official Workers AI setup

Agenter's default Cloudflare setup follows the Workers AI REST API documentation:

1. Click **Set up Workers AI**.
2. Open Cloudflare Workers AI and choose **Use REST API**.
3. Create the preconfigured Workers AI API token.
4. Paste the Account ID and token into Agenter.
5. Agenter verifies credentials and downloads the live model catalog before saving.

Inference is sent directly to `POST /accounts/{account_id}/ai/run/{model}`. Workers AI includes 10,000 Neurons per day at no charge on both Free and Paid Workers plans; Free-plan requests stop after the daily allocation is exhausted.

### Workers AI multimodal routing

Agenter routes requests according to the selected Workers AI model:

- Text generation: `POST /accounts/{account_id}/ai/v1/chat/completions`
- Model-specific tasks: `POST /accounts/{account_id}/ai/run/@cf/{author}/{model}`
- Live input/output schema: `GET /accounts/{account_id}/ai/models/schema?model=@cf/{author}/{model}`

Use the paperclip button in chat to attach an image or audio file. Vision and transcription models receive the attachment in their documented model-specific payload. Image-generation and text-to-speech results render directly in the conversation.
