# 0.1.1

New cloud model IDs can now appear immediately in the open model list when a provider catalog refreshes. Previously, background updates could remain invisible until the user manually refreshed the page.

- Refresh connected providers every 15 minutes, after connecting a key, and when opening an out-of-date model page.
- Bypass HTTP caches for catalog requests.
- Display and sort provider timestamps as catalog modification/creation dates, without claiming they establish release dates or quality.
- Preserve search text, sort order, and explicit model selection when catalogs update.
- Revalidate missing, malformed, expired, and future cache timestamps before a cloud run.
- Verify discovery of a synthetic future Ollama model through the real desktop UI, exact ID selection, proposal generation adapter, and research worker.

Ollama Cloud model IDs come directly from its API; no guessed slug or fixed model allowlist is added for a user-reported display name. Live Ollama access is blocked in this development environment, so the specific name “K3.1 Pro” is not independently confirmed here. An API key and provider authorization remain necessary for live generation.
