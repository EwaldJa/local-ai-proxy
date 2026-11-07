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
- `delegation.defaultMode` is `manual`, `auto`, or `off`. Ask Codex to enable or pause delegation to change the mode for one chat.
- `delegation.workspaceFiles` enables explicit project file reads, writes, and moves under `workspace`. Set it to `false` to send inline context and let Codex handle project files with its normal tools.

`limits` controls the context and output defaults, context margin, and maximum file and response sizes. `ollama.timeoutMs` controls request timeouts. The [example file](../local-ai.config.example.json) lists the default values.

## Installation paths and private data

`node scripts/prepare-marketplace.js` generates the local marketplace and sets `LOCAL_AI_CONFIG` in its MCP manifests to the absolute path of your private config. You can pass a different config path as the first script argument. Keep the checkout and config available to the installed plugin.

The configured workspace's `.local-ai/` holds prompts, responses, reviews, and generated proposals. Exclude it from version control in that workspace. Also keep your private config, environment files, and any `.local-ai-write-*` temporary files out of the repository. On Windows, use filesystem ACLs to protect private directories.

For local diagnostics, install the checkout's dependencies with `pnpm install --frozen-lockfile --ignore-scripts`. Run `pnpm doctor` to query Ollama and list available models.
