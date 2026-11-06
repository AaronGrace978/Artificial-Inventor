# Cloud model connections

Add a provider API key in **Connections**, refresh its catalog, and choose a model. Keys stay in Electron's main process and are encrypted using the operating system credential facilities when those facilities are available. The renderer receives connection status, not stored keys. If OS-backed encryption is unavailable, the application must refuse persistent key storage.

| Provider | Model catalog | Generation endpoint |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/models` | `/v1/responses` |
| Anthropic | `https://api.anthropic.com/v1/models` | `/v1/messages` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/models` | `/v1beta/models/{id}:generateContent` |
| xAI | `https://api.x.ai/v1/models` | `/v1/chat/completions` |
| Mistral | `https://api.mistral.ai/v1/models` | `/v1/chat/completions` |
| DeepSeek | `https://api.deepseek.com/models` | `/chat/completions` |
| Groq | `https://api.groq.com/openai/v1/models` | `/openai/v1/chat/completions` |
| OpenRouter | `https://openrouter.ai/api/v1/models` | `/api/v1/chat/completions` |
| Ollama Cloud | `https://ollama.com/api/tags` | `/api/chat` |

Ollama Cloud connects directly to `ollama.com`; it does not require a local Ollama installation. Use the model identifiers returned by the cloud catalog, which can differ from local `-cloud` tags. Create a key through your own provider account. API charges and availability depend on that account; no provider subscription is bundled with the application.

Catalog refreshes retrieve provider-advertised models rather than a baked-in list. Newly advertised IDs are accepted without a new app release or a hardcoded model allowlist. Catalog requests bypass HTTP caches; connected providers refresh every 15 minutes, after key connection, and on opening the model page when its data is over a minute old. Background results are pushed into the visible list immediately. Provider timestamps are displayed as catalog updates or creation times, not verified release dates or model rankings. Some catalogs, including OpenRouter and Ollama Cloud, are public model listings rather than proof of account authorization or available credits. Availability does not rank quality, establish that a model is the newest, or verify scientific performance. Refreshing a catalog does not silently change the selected research model. If a model disappears, select a replacement deliberately. There is no defensible universal “best model” label without a defined benchmark.

Known embedding, speech, image, moderation, and other non-text models are filtered. Providers that publish text-generation capabilities are filtered using that metadata. Other catalog entries carry `capabilitySource: "unverified"`: endpoint support cannot be inferred reliably from every vendor's `/models` response. A newly introduced or account-restricted model can still reject a request; choose a compatible model rather than treating that failure as evidence about a design.

Generation requests ask for bounded heat-sink dimensions and never grant tool access. Model text is parsed as data. Only numeric design dimensions and a short rationale reach the independent research checks; model-supplied code, verification status, permissions, and scores are discarded. Refused, malformed, oversized, timed-out, and explicitly incomplete responses fail closed. Provider errors omit response bodies and native error details to avoid echoing credentials.

## Generation progress, cancellation, and project files

Heat-sink proposal requests now allow five minutes; project generation allows ten minutes. Catalog requests retain a one-minute limit. These are total request deadlines covering connection, reasoning, and streamed output—not inactivity timers reset by incoming chunks. The operator can cancel a request. Cancellation closes the local request but cannot guarantee that a provider stops remote work or billing immediately. Generation is never automatically retried against a paid API.

Ollama Cloud generation uses streaming NDJSON. OpenAI Responses, Anthropic Messages, Gemini `streamGenerateContent`, and compatible chat providers use their SSE streams. Stream framing is also detected when a gateway labels a streamed body as ordinary JSON or omits its content type. Progress exposes elapsed time and whether the provider is waiting, reasoning, or sending final output. Hidden reasoning is not displayed, persisted as project output, or treated as evidence. Servers returning a complete ordinary JSON response remain supported. A stream must deliver its completion marker; valid-looking partial JSON and output-limit truncation are rejected.

Project generation asks for complete source artifacts with at most 30 files, 100 KiB per file, and 500 KiB total, using an output-token allowance of 12,000. It supports self-contained browser apps, source-code projects, and invention briefs. Generation does not execute programs, install dependencies, run generated tests, or establish that generated software works. The build workspace separately validates file paths, supported syntax, and its preview boundary. Browser projects are requested without external scripts, CDN assets, server dependencies, or module imports so they can be inspected in an isolated local preview.

## Network access and validation

Restricted cloud environments need these HTTPS hosts allowed for the connections you use:

`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.x.ai`, `api.mistral.ai`, `api.deepseek.com`, `api.groq.com`, `openrouter.ai`, `ollama.com`.

No model API keys were present during initial development. Adapter tests cover request URLs, authentication headers, pagination, capability filtering, schema validation, cancellation, timeouts, response limits, and secret redaction using mocked HTTP responses. **Paid authenticated generation has not been validated against live accounts.** Contract references were checked against official SDK source where network policy permitted it. The environment's proxy denied a direct read-only `ollama.com/api/tags` request, so that catalog was not fetched live during development.

Official references:

- [Ollama Python SDK: Cloud API and cloud catalog example](https://github.com/ollama/ollama-python#cloud-api-ollamacom)
- [Ollama JavaScript SDK: Cloud API](https://github.com/ollama/ollama-js#cloud-api-ollamacom)
- [Anthropic model catalog SDK implementation](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts)
- [OpenAI Responses SDK implementation](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts)
- [Google Gen AI SDK](https://github.com/googleapis/js-genai)
- [Groq model catalog and chat SDK routes](https://github.com/groq/groq-python/tree/main/src/groq/resources)

These adapters are an initial set of major text-model services, not support for every commercial provider or every modality. Provider APIs and model support can change independently of this app; application updates can revise adapters without pretending that untested model revisions inherit earlier evidence.

The user-reported name “K3.1 Pro” was not independently verified against a live Ollama catalog because this development environment denies `ollama.com` access. The app forwards the exact identifiers returned by Ollama rather than guessing an API slug from a display name. Regression tests use explicitly synthetic future model IDs to prove discovery, UI updates, explicit selection, and request forwarding.
