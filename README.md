# Agenter

Agenter brings a tool-using AI assistant into Obsidian. Chat in the right sidebar, a movable floating panel, or a compact contextual panel beside selected text. The assistant can work with notes, search the web, use saved prompts, and request approval before changing vault content.

> **Status:** Desktop-only community plugin. Agenter requires your own API key for a supported AI provider.

## Features

- **Three chat modes:** docked sidebar, floating panel, and contextual chat beside selected text.
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

1. Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release.
2. Create this folder inside your vault:

   ```text
   .obsidian/plugins/agenter/
   ```

3. Copy the three release files into that folder.
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
- Select text in a note to open the contextual AI panel.
- Choose the context chip in the composer to switch between note, folder, vault, and no context.
- Type `/` or select **AI Actions** to use saved prompts.
- Open **Settings → Agenter → Custom prompts** to create, rename, edit, or remove prompt actions.

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

5. The included GitHub Actions workflow builds the plugin and creates a GitHub release containing `main.js`, `manifest.json`, and `styles.css`.

## Security

If you discover a security issue, do not include private vault content, API keys, or credentials in a public issue. Contact the maintainer privately through the contact method listed on the GitHub profile.

## License

Agenter is released under the [MIT License](LICENSE).
