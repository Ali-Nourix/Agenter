# Agenter

Agenter brings a tool-using AI assistant into Obsidian. Chat in the right
sidebar, a movable floating window, or a compact popover beside the text you
just selected. It can read and search your notes, look things up on the web,
run your own saved prompts, and ask before it changes anything in the vault.

> **Status:** Desktop-only. Agenter is not an AI service — it talks to a
> provider you configure with your own API key.

## What it looks like

The panel is built entirely from Obsidian's theme variables, so it follows the
vault it is installed in:

<table>
<tr>
<td align="center"><b>Dark</b></td>
<td align="center"><b>Light</b></td>
</tr>
<tr>
<td><img src="docs/images/chat-dark.png" alt="Chat panel in a dark vault" width="380"></td>
<td><img src="docs/images/chat-light.png" alt="The same chat panel in a light vault" width="380"></td>
</tr>
</table>

Selecting text opens the contextual popover — one small card with the selection
collapsed behind its word count, a scrollable row of actions, and a composer:

![The contextual popover beside a text selection](docs/images/contextual-popover-dark.png)

Ask something and the card turns into the conversation, tool activity and
approval cards included, without growing into a second chat window:

![The contextual popover after a question, showing the reply inline](docs/images/contextual-popover-chat.png)

<sub>These are rendered from the plugin's own `styles.css` over Obsidian's
default theme variables (see <a href="#previews">Development → Previews</a>),
not screenshots of a live vault.</sub>

## Contents

- [What it looks like](#what-it-looks-like)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Setup](#setup)
- [Usage](#usage)
- [Providers](#providers)
- [Privacy and network access](#privacy-and-network-access)
- [Development](#development)
- [Releasing](#releasing)
- [Security](#security) · [License](#license)

## Features

- **Three chat modes:** docked sidebar, floating window, and a contextual
  popover for the current selection — beside the caret, or pinned to a spot you
  choose once.
- **Multiple providers:** OpenAI, Anthropic, Gemini, OpenRouter, Ollama,
  Cloudflare Workers AI, any OpenAI-compatible service, and custom endpoints.
- **Vault-aware context:** the current note, the current folder, the whole
  vault, or nothing automatic.
- **Tool use:** read and search notes, inspect links and metadata, list
  folders, summarize content, search the web, fetch URLs, and read note images
  when the model supports vision.
- **Guarded note actions:** create, edit, append, move and trash notes only
  after the approval step you configured.
- **Recoverable changes:** note mutations write a safety backup into
  `.agenter-backups`, and deletion goes through Obsidian's recoverable Trash.
- **One conversation:** the main panel and the contextual popover share the
  same history, so you can start in one and continue in the other.
- **Custom prompts:** build reusable prompt actions in settings; they appear in
  the chat and in the popover.
- **Obsidian-native rendering:** replies, note previews, code blocks and
  internal links all go through Obsidian's own Markdown renderer, including
  right-to-left text.
- **Streaming with live status:** watch the answer arrive, stop generation, and
  follow what each tool is doing.

## Requirements

- Obsidian **1.7.2** or newer (this is the plugin's `minAppVersion`).
- Obsidian Desktop — Agenter is marked `isDesktopOnly`.
- An API key for at least one supported provider, or a local Ollama install.

## Installation

### From Community Plugins

Once Agenter is listed in the Obsidian community directory:

1. Open **Settings → Community plugins**.
2. Select **Browse** and search for **Agenter**.
3. Select **Install**, then **Enable**.

### Manual installation

1. From the [latest release](../../releases/latest), download either
   `agenter-<version>.zip` or the three loose files `main.js`,
   `manifest.json`, and `styles.css`.
2. Create this folder inside your vault:

   ```text
   .obsidian/plugins/agenter/
   ```

3. Unzip the archive into that folder, or copy the three files into it.
4. Restart Obsidian, or reload it.
5. Open **Settings → Community plugins** and enable **Agenter**.

For pre-release testing you can also install the repository with
[BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Setup

1. Open **Settings → Agenter**.
2. Add or edit a provider.
3. Enter its base URL, API key, and model — or press **Set up** for Cloudflare
   Workers AI, which discovers both for you.
4. Use **Test connection & fetch models** to confirm it works.
5. Pick a default context scope and review the tool-approval switches.

API keys are stored in Obsidian's plugin data file (`data.json`) in plain text,
like every other Obsidian plugin. Do not commit or share that file.

## Usage

- **Agenter: Open chat in right sidebar** from the Command Palette, or the
  ribbon icon.
- The header control switches between docked and floating.
- Select text in a note to open the contextual popover, or run
  **Agenter: Run AI action on selection**.
- The context chip in the composer switches between note, folder, vault, and no
  context.
- Type `/` or use **AI Actions** for your saved prompts.

### Contextual popover

Placement is yours to choose in **Settings → Agenter → Chat → Contextual
popover**:

| Setting | What it does |
| --- | --- |
| **Show on selection** | Turn it off to keep the popover out of the way, and open it from the Command Palette or the editor menu instead. |
| **Placement → Follow the selection** | Opens beside the caret, flipping above it when there is no room below. |
| **Placement → Fixed spot** | Always opens on one spot, with a button to reset it to the bottom-right corner. |

You rarely need that setting, though: **drag the popover by its header and drop
it somewhere**, and it switches to *Fixed spot* and remembers where it landed.
The pin button in the header toggles the two modes.

Clicking the word count expands the selected text. The panel button hands the
work to the main chat — the selection if you have not asked anything yet, the
whole conversation if you have.

### Tool approvals

Read-only tools run on their own. Tools that change the vault show an approval
card first, inline in whichever surface you are using. Moving a note to Trash
always takes two deliberate clicks.

File tools are restricted to the current vault and refuse protected internal
paths. Network tools are separate and only run when the conversation asks for
them.

## Providers

Every provider implements one adapter contract in `src/api.ts`. Shared model and
multimodal message types live in `src/provider-types.ts`.

| Provider | Notes |
| --- | --- |
| OpenAI, Anthropic, Gemini | Base URL, key, model. |
| OpenRouter | OpenAI-compatible; one key for many models. |
| Ollama | Local models, no key needed. |
| Cloudflare Workers AI | Native client with OAuth or API token — see below. |
| OpenAI-Compatible / Custom | DeepSeek, Qwen, self-hosted gateways, anything that speaks the OpenAI chat API. |

### Cloudflare Workers AI

Agenter ships a first-class Cloudflare Workers AI client. Authentication,
discovery and capability inference live in `src/cloudflare.ts` and
`src/cloudflare-oauth.ts`.

**Connecting**

The settings screen offers two routes:

- **Connect Cloudflare** (OAuth) opens Cloudflare in your browser, shows its
  consent screen, returns through a localhost PKCE callback, discovers your
  accounts, and syncs the model catalog. Tokens refresh on their own, and
  **Disconnect** revokes the authorization.
- **Set up Workers AI** (API token) follows Cloudflare's own REST API
  instructions: create the preconfigured Workers AI token, paste it with your
  Account ID, and Agenter verifies it and downloads the live catalog before
  saving.

No model endpoint has to be typed. The run URL is built from your Account ID
and the selected model.

**What the client does**

- Live model discovery from Cloudflare, with an offline catalog cache and a
  sync timestamp.
- Capability inference for vision, audio, image generation, embeddings,
  reasoning, JSON mode, tool calling, streaming, free/paid tier, latency, and
  experimental or deprecated status.
- Readable errors for bad credentials, rate limits, unavailable models,
  timeouts, and Cloudflare outages.
- Streaming and tool calling through the same pipeline as every other provider,
  including the approval cards.

**Request routing**

| Model kind | Endpoint |
| --- | --- |
| Text generation | `POST /accounts/{account_id}/ai/v1/chat/completions` |
| Model-specific tasks | `POST /accounts/{account_id}/ai/run/@cf/{author}/{model}` |
| Live input/output schema | `GET /accounts/{account_id}/ai/models/schema?model=@cf/{author}/{model}` |

Use the paperclip in the composer to attach an image or audio file; vision and
transcription models receive it in their documented payload, and
image-generation or text-to-speech results render in the conversation.

Workers AI includes 10,000 Neurons per day at no charge on both Free and Paid
Workers plans. Free-plan requests stop once the daily allocation is spent.

**For plugin publishers**

Distributing your own build with OAuth needs one public Cloudflare OAuth client:

- Flow: Authorization Code with PKCE (S256)
- Token authentication: `none` — a public desktop client, so do not bundle a
  secret
- Redirect URL: `http://127.0.0.1:42813/cloudflare/callback`
- Permissions: Workers AI Read, Workers AI Edit, Account Settings Read

Paste the Client ID into the one-time publisher field; users then only press
**Connect Cloudflare**.

## Privacy and network access

Agenter does not provide or proxy an AI service. Depending on the provider and
tools you use, data may be sent to:

- the AI provider or custom endpoint you configured,
- DuckDuckGo, when the `web_search` tool runs,
- whatever URL the `fetch_url` tool is pointed at.

Read your provider's privacy policy before sending sensitive notes, and keep the
context scope no wider than the task needs.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # typecheck + production build
npm test        # the full suite
```

The distributable files are `main.js`, `manifest.json`, and `styles.css`.

### Previews

`test/` holds two offline harnesses that load the real `styles.css` over
Obsidian's default theme variables (`test/obsidian-theme.css`) and reproduce the
DOM the plugin builds:

| File | Shows | Query flags |
| --- | --- | --- |
| `test/ui-preview.html` | The docked chat panel | `?light`, `?floating` |
| `test/ctx-preview.html` | The contextual popover | `?light`, `?chatting`, `?quoting` |

Open either one in a browser to check a style change without reloading
Obsidian, or regenerate the images in this README:

```bash
npm i --no-save playwright && npx playwright install chromium
node test/render-previews.mjs
```

## Releasing

1. Update the version in `manifest.json`, `package.json`, and
   `package-lock.json`.
2. Add the version and its minimum Obsidian version to `versions.json`.
3. Commit and push.
4. Tag the commit with exactly the manifest version, no `v` prefix:

   ```bash
   git tag 1.7.1
   git push origin 1.7.1
   ```

The workflow checks that the tag, manifest, package, lockfile and
`versions.json` all agree, runs the tests, builds, and publishes `main.js`,
`manifest.json`, `styles.css`, and `agenter-<version>.zip` holding the same
three files.

### Releasing without a local tag

The same workflow runs from the **Actions** tab, which helps when you cannot
push a tag from a clone:

| Input | Effect |
| --- | --- |
| *(none)* | Builds and uploads the zip and the three loose files as run artifacts. Nothing is tagged or published. |
| **publish** | Also creates the tag — taken from `manifest.json`, so the metadata check still has to pass — and the release with all four assets. |
| **target** | The commit-ish to build and tag. Defaults to the branch the run was started from; set it to `main` to release from the default branch. |

`gh release create` refuses to overwrite an existing release, so a version can
only be published once.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Security

If you find a security issue, please do not put private vault content, API keys
or credentials in a public issue. Contact the maintainer through the method on
the GitHub profile.

## License

Agenter is released under the [MIT License](LICENSE).
