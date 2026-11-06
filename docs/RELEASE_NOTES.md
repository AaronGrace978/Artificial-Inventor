# 0.2.1

Fix Build studio project generation failing with "Provider returned an invalid JSON response" when an Ollama Cloud stream is labeled as ordinary JSON or has no content type. Detect Ollama NDJSON and other providers' SSE framing from incoming data while retaining support for complete ordinary JSON responses.

Reasoning remains separate from project files. Completion checks, output limits, cancellation, total deadlines, and response-size bounds remain in place. The selected model is unchanged and paid requests are not retried automatically.

Provider regression tests cover project-file generation from mislabeled streams, multibyte text, reasoning separation, provider errors, and incomplete or truncated responses. Live authenticated Ollama generation has not been independently verified.

# 0.2.0

Build studio now generates and exports real multi-file code projects. Static browser apps can run in an operator-started isolated preview; other supported source languages are exported with explicit validation limits. A working offline Idea Board demonstrates file inspection, preview interaction and export.

Model requests stream progress, distinguish reasoning from final output, support cancellation and use five-minute thermal / ten-minute project deadlines. Tasks are saved before generation and restored after failed, cancelled or interrupted requests, without automatic paid retries. Provider refusals, output limits and incomplete streams remain distinct failures.

Release publishing explicitly uploads required files and verifies the downloaded installer checksum, with bounded retries for propagation. Existing catalog freshness fixes and canonical repository settings are retained.

# 0.1.2

Use the renamed canonical GitHub repository `AaronGrace978/Artificial-Inventor` for publishing and update checks. Includes all 0.1.1 model-catalog fixes below.

# 0.1.1

New cloud model IDs can now appear immediately in the open model list when a provider catalog refreshes. Previously, background updates could remain invisible until the user manually refreshed the page.

- Refresh connected providers every 15 minutes, after connecting a key, and when opening an out-of-date model page.
- Bypass HTTP caches for catalog requests.
- Display and sort provider timestamps as catalog modification/creation dates, without claiming they establish release dates or quality.
- Preserve search text, sort order, and explicit model selection when catalogs update.
- Revalidate missing, malformed, expired, and future cache timestamps before a cloud run.
- Verify discovery of a synthetic future Ollama model through the real desktop UI, exact ID selection, proposal generation adapter, and research worker.

Ollama Cloud model IDs come directly from its API; no guessed slug or fixed model allowlist is added for a user-reported display name. Live Ollama access is blocked in this development environment, so the specific name “K3.1 Pro” is not independently confirmed here. An API key and provider authorization remain necessary for live generation.
