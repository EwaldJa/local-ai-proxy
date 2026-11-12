# Architecture

Local AI Proxy runs an MCP server over standard input and output on the Codex host. Ollama handles inference. A remote Ollama URL changes where inference runs. Project files and plugin state remain on the MCP host.

```text
Codex and the local-delegate skill
    |
    | MCP tools and a read-only status tab
    v
Engine and workspace on the Codex host
    |                         |
    | bounded task context    +-- private state and task artifacts
    v
Configured Ollama instance
```

## Code map

| File | Responsibility |
| --- | --- |
| [`src/mcp.js`](../src/mcp.js) and [`src/schemas.js`](../src/schemas.js) | Register and validate tool calls, route them by chat, and manage engine lifetimes. |
| [`src/engine.js`](../src/engine.js) | Plan steps, queue inference, persist task state, verify proposals, record verdicts, and calculate usage statistics. |
| [`src/ollama.js`](../src/ollama.js) and [`src/config.js`](../src/config.js) | Load local settings, discover models, select one, and handle HTTP requests with time and size limits. |
| [`src/validation.js`](../src/validation.js) | Validate the worker's response format and run declarative text or JSON checks. |
| [`src/workspace.js`](../src/workspace.js) and [`src/atomic-file.js`](../src/atomic-file.js) | Validate workspace paths and file baselines, stage and publish writes, and attempt rollback if an application fails. |
| [`src/status-panel.js`](../src/status-panel.js) and [`src/ui/delegation-status.html`](../src/ui/delegation-status.html) | Serve the chat status view and its read-only snapshots. |
| [`src/settings.js`](../src/settings.js) | Expose UI-only settings, test the selected connection, and save validated settings while detecting stale edits. |
| [`skills/local-delegate/SKILL.md`](../skills/local-delegate/SKILL.md) | Guide Codex on task selection, context, review, and reporting. |

## Task lifecycle

1. **Plan.** Codex assigns bounded steps to itself or Ollama, with acceptance criteria. The skill tells Codex when to delegate in each chat mode. The engine refuses new submissions when delegation is paused.
2. **Submit.** The engine selects a compatible model and assembles the prompt. It requests at least the configured context floor and grows from a conservative UTF-8 byte estimate plus the output reserve and margin, subject to reported model capacity or an explicit fixed profile. An oversized task returns `needs_split` before inference. File-enabled tasks declare an exact output scope and record SHA-256 baselines for inputs and allowed outputs.
3. **Generate.** Ollama receives a single bounded prompt and returns a structured text, file-write, or move proposal. The engine saves the response and proposal separately and records the proposal's SHA-256 digest. Schema and deterministic checks can reject a result before review. The Ollama response cannot execute commands or write project files by itself.
4. **Review.** Codex inspects proposal content and records a verdict with evidence. The engine verifies the proposal bytes when serving them and before accepting. For older tasks without a stored digest, it reconstructs the expected proposal from the saved Ollama response. If verification fails, the task can be rejected and resubmitted.
5. **Apply.** Codex can use accepted text directly. In file mode, a separate apply call verifies the proposal again, rechecks file baselines, and runs the declared checks. New files are published without overwriting an existing destination. For moves, the destination is published before the source is removed.

## State and concurrency

With Codex chat metadata, each chat gets a directory named `chat-<sha256>` under the configured workspace's `.local-ai/`. It contains `state.json`, a writer lock, and directories for the request, response, proposal, checks, and review artifacts. Standalone CLI calls use the state at the root of `.local-ai/`.

Each engine serializes mutating tool calls and queues model calls. Task inspection can wait outside the mutation queue. File application uses the workspace lock so file writes from separate plugin chats do not overlap. State snapshots, preferences, and artifacts use exclusively created temporary files beside their targets. The status panel reads the published state without taking a writer lock.

The engine marks queued or running jobs as interrupted when it next opens the state. An interruption during a move can leave both paths present. A batch can be partly applied if the process stops, and caught failures attempt a rollback. The filesystem must support hard links to publish new files without replacing another writer's destination. Filesystem checks assume the configured workspace and local state are trusted. They do not provide a sandbox against a process racing or rewriting local files.

The settings form reads saved configuration through UI-only tools. Saving validates the merged config and preserves advanced fields. A separate config writer lock and a revision hash protect against concurrent or stale edits. Changes apply on plugin reload, so queued tasks retain the process's original connection. Connection discovery happens only when requested in the form and sends no task prompt.

## Status and metrics

The server instructions and `local-delegate` skill ask Codex to read `local_flow` at the first exchange of each new or resumed chat, before other work, including messages that need no local generation. Its `statusPanel` hint names `local_status_panel` and requests `open` when the mode is not `off` and no successful panel request has been recorded for that chat in this MCP process. Only successful `local_status_panel` calls record that request; background snapshots do not. The hint is scoped using the host's chat ID and resets on MCP restart. Codex is instructed not to repeat failed attempts or reopen a user-closed panel during the session. The server cannot observe tab visibility. Opening remains an instruction-driven model action, so it requires a model turn and host UI support; there is no host-level empty-chat creation or tab-visibility hook.

`local_status_panel` renders the view in a chat, and users can also open it from the chat's app menu. On mounting an inline view, the UI makes one best-effort request for `fullscreen` through the MCP Apps bridge, with an OpenAI runtime fallback if the bridge method is unavailable. The host controls the resulting presentation and may keep it inline. Already expanded views and hosts that explicitly exclude fullscreen are left alone. Display-mode errors do not interrupt polling or controls.

The registered tool and resource titles use the MCP host machine's default locale: “Délégation modèle local” for French, otherwise “Local LLM delegation”. The panel's document title and heading use the UI host's locale when supplied. The remaining panel controls currently use French.

After the initial automatic opening attempt, the server instructions and skill ask Codex to include a short onboarding note in its chat response, even if the UI failed. It explains manual opening from the tab menu, plugin settings, and the chat-scoped mode badge. Conversation history is used to avoid repeating it on subsequent messages or resumes; it is not a global first-install counter and adds no banner to the panel.

The status tab polls for the current chat's mode, review counts, and up to 20 recent requests. It shows measured input and output tokens, local start time, and elapsed time when available. Generation speed uses Ollama's measured generation duration. Context usage divides measured prompt and output tokens by the requested context window. The engine's task weights describe estimated allocation, and Codex token usage and savings are unavailable.

## Development checks

From the checkout root, install the pinned dependencies and run the tests. The tests use temporary workspaces and a simulated Ollama server on loopback.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

`node scripts/check-package.js` validates the canonical plugin and MCP manifests against their public schemas.
