# Local AI Proxy

Local AI Proxy lets Codex delegate focused work to an Ollama model running on your machine or on a server you trust. Use it for drafting, structured extraction, data cleanup, test authoring, or file change proposals. Codex defines each task and reviews the result.

- Discover installed Ollama models and set a default or preferences by task type.
- Choose automatic, manual, or paused delegation for each Codex chat.
- Track local requests, review outcomes, token counts, and timing in the Codex status tab.

## Quick start

You need Node.js 22 or later, pnpm, the Codex CLI, and a running Ollama instance with a compatible text model. This preview installs from a local plugin marketplace.

In a fresh checkout, copy `local-ai.config.example.json` to `local-ai.config.json`.

```powershell
Copy-Item local-ai.config.example.json local-ai.config.json
```

Edit your copy before installing.

| Setting | What to configure |
| --- | --- |
| `ollama.url` | Defaults to `http://127.0.0.1:11434`. Use the URL of the Ollama instance you trust. |
| `models.default` | Set the exact installed model name if several compatible models are available. |
| `delegation.defaultMode` | Defaults to `auto` for automatic delegation in new chats. Use `manual` for explicit requests or `off` to pause. |
| `delegation.workspaceFiles` | Use `false` to let Codex handle files across projects. Use `true` to enable scoped file proposals for the configured `workspace`. |
| `limits.minContextTokens` | Requests at least 32,768 context tokens by default, growing when the task needs more, within the model's capacity. See the [sizing rules](docs/configuration.md#context-window-sizing). |

From the checkout root, prepare and install the plugin.

```powershell
node scripts/prepare-marketplace.js
pnpm --dir .local-ai/marketplace/plugins/local-ai-proxy install --frozen-lockfile --prod --ignore-scripts --node-linker=hoisted
codex plugin marketplace add .local-ai/marketplace
codex plugin add local-ai-proxy@local-ai-proxy-dev
```

In Codex, ask to use Local AI Proxy for a task, such as drafting tests from a supplied specification. To see the requests and their verdicts, open **Délégation Ollama** from the chat's new-tab menu.

## Privacy and documentation

The plugin sends selected task context to the configured Ollama instance. The private configuration and the workspace's `.local-ai/` history should stay out of version control. If you point the plugin at a different Git workspace, exclude its local state there too.

- [Configuration and connection options](docs/configuration.md)
- [Architecture and code walkthrough](docs/architecture.md)

## Licensing

Local AI Proxy uses a custom source-available license permitting free personal and internal professional use, including modifications. Paid client deliverables are permitted under the conditions in [LICENSE](LICENSE). Reselling the plugin, embedding it in a paid product, or offering paid hosted access requires a separate commercial agreement. See the [licensing guide](docs/licensing.md).

Copyright (c) 2026 Ewald Janin. For commercial licensing, contact [ewald.janin@gmail.com](mailto:ewald.janin@gmail.com).
