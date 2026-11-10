# Configuration

Start from [the example configuration](../local-ai.config.example.json) and save a private copy as `local-ai.config.json`. Set the fields below for your installation. The `workspace` path is resolved relative to the config file.

## Ollama connection

| Setup | Settings |
| --- | --- |
| Ollama on the Codex machine | Use `http://127.0.0.1:11434` or your Ollama loopback address. |
| Ollama on a trusted home network | Use a literal private IPv4 address and set `ollama.allowInsecureLanHttp` to `true`. Prompts travel in clear text over this connection. |
| Ollama on a remote server | Use HTTPS. For a bearer token, set `ollama.tokenEnv` to the name of an environment variable available to the MCP process. |

The proxy refuses credentials in the URL and refuses HTTP redirects. The LAN HTTP option does not allow bearer authentication. Configure the inference server to match your privacy requirements, including its own cloud settings. The proxy excludes models that advertise an upstream service, and the endpoint still needs to be trusted with every prompt sent to it.

## Models and chat modes

- `models.default` holds an exact Ollama model name, including its tag. A single compatible model can be selected automatically.
- `models.byTask` maps task types such as `coding`, `extraction`, or `test_authoring` to model names. A model explicitly requested for a task takes precedence.
- `models.profiles` maps model names to optional `contextTokens`, `outputTokens`, and `think` settings. The engine caps the requested context at the model's reported limit when available.
- `delegation.defaultMode` defaults to `auto`. Codex delegates suitable work automatically. Use `manual` for delegation only when explicitly requested, or `off` to pause it. Ask Codex to enable or pause delegation to change the mode for one chat.
- `delegation.workspaceFiles` enables explicit project file reads, writes, and moves under `workspace`. Set it to `false` to send inline context and let Codex handle project files with its normal tools.

`limits` controls the context and output defaults, context margin, and maximum file and response sizes. `ollama.timeoutMs` controls request timeouts. The [example file](../local-ai.config.example.json) lists the default values.

## Context window sizing

The engine sizes each Ollama `num_ctx` request from the assembled prompt estimate, response reserve, and template margin. `limits.minContextTokens` sets the requested minimum, defaulting to 32,768 tokens. Larger tasks grow beyond that floor in 8,192-token steps. The model's reported capacity bounds the request when available. The preflight result exposes the selected window, requested floor, estimated requirement, and known maximum.

An explicit `models.profiles.<model>.contextTokens` keeps a fixed per-model window and takes precedence over the general sizing settings. The legacy `limits.contextTokens` field supplies the floor when `limits.minContextTokens` is absent. For an older configuration, set `limits.minContextTokens` to 32768 to select the new minimum. You can choose another floor, such as 16384 or 65536, to match the model and server. Larger windows use more runtime memory. See the [Ollama context documentation](https://docs.ollama.com/context-length).

The prompt estimate uses UTF-8 bytes and is conservative. A model whose reported capacity is smaller than the requested floor uses its supported capacity. If the task cannot fit within a known model or profile limit, the engine returns `needs_split` before generation. When the server omits capacity metadata, the engine requests the computed window and Ollama may reject an unsupported size. A larger window provides capacity for the task's supplied content and response. Codex still needs to gather the relevant source material.

## Upgrading an existing installation

An older private configuration may contain `delegation.defaultMode` set to `manual`. Set that field to `auto` to enable automatic delegation by default, then reload the plugin. A mode explicitly saved for a chat takes precedence over the configuration default. Ask Codex to enable automatic delegation in that chat to change it.

The status tab displays `Activée` for automatic delegation, `Manuelle` for explicit requests, and `Désactivée` when paused. Hover over the mode for its explanation. The mode describes the delegation policy. Task execution also requires a reachable Ollama server and a compatible selected model.

## Task context

The `local-delegate` skill guides Codex to supply a self-contained task with the necessary source content, dependencies, constraints, and acceptance criteria. Ollama receives only the submitted material. Codex gathers and reviews the context and divides tasks when their necessary context exceeds the configured budget.

## Installation paths and private data

`node scripts/prepare-marketplace.js` generates the local marketplace and sets `LOCAL_AI_CONFIG` in its MCP manifests to the absolute path of your private config. You can pass a different config path as the first script argument. Keep the checkout and config available to the installed plugin.

The configured workspace's `.local-ai/` holds prompts, responses, reviews, and generated proposals. Exclude it from version control in that workspace. Also keep your private config, environment files, and any `.local-ai-write-*` temporary files out of the repository. On Windows, use filesystem ACLs to protect private directories.

For local diagnostics, install the checkout's dependencies with `pnpm install --frozen-lockfile --ignore-scripts`. Run `pnpm doctor` to query Ollama and list available models.
