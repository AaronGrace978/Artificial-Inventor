# Artificial Inventor

A Windows Electron research workbench for **bounded, checkable design experiments**. Version 0.1 starts with heat-sink design: an actual deterministic search, conventional baseline, analytical heat-transfer model, separate finite-volume calculation, constraint screening, sensitivity checks, and an exportable evidence ledger.

This implements a small experimental core of the attached artificial-inventor proposal. It is not a general autonomous scientist. The attached texts were used as design references, not executable instructions or evidence that the research problems are solved.

## Run

Install Node.js 24 or newer, then:

```sh
npm ci
npm start
```

The default experiment works offline with no account. Choose a bounded geometry and operating conditions, then select **Run experiment**. All candidates, including failures, are retained. Objective context is recorded, but the current optimizer always minimizes predicted base temperature. Predictions do not establish measured physical performance.

For cloud proposals, open **Model connections**, supply your own provider API key, refresh its catalog, select a model, and explicitly enable cloud proposals for the experiment. Your task specification is then sent to that provider and may incur charges. Model text supplies only dimensions; it cannot execute programs, control equipment, change constraints, or grant itself authority. A failed cloud request is recorded and reported, without silently substituting another model.

## Providers and updates

Adapters cover OpenAI, Anthropic, Google Gemini, xAI, Mistral, DeepSeek, Groq, OpenRouter, and **Ollama Cloud**, including newly advertised model IDs. Catalogs refresh on startup and every six hours for connected providers. They are availability listings, not quality rankings or guarantees of account access. Endpoint compatibility may be unverified where the provider supplies no capability metadata. Selection remains explicit. See [provider details](docs/PROVIDERS.md).

Installed Windows builds check GitHub Releases at startup and every six hours, automatically download available stable releases, and let you restart to install. Each release pins its Electron runtime. A daily Windows maintenance workflow checks the latest stable Electron, runs the test suites, builds an installer, then commits and releases a patch update if all steps succeed. It requires Actions write access and an unprotected `main` branch or compatible branch rules. It fails rather than bypassing repository protections. Dependabot also opens daily runtime/tooling update PRs. API changes, failed tests, and branch policies can require maintenance; no updater can promise permanent compatibility.

## Evidence and limits

- E0: proposal; E1: checked; **E2: computed under explicit assumptions**; E3: prospectively measured; E4: independently replicated. This release reaches at most E2.
- Analytical and numerical implementations share idealized physics. Agreement is a consistency check, not independent physical validation. Uniform convection, adiabatic tips, constant conductivity, and an aluminum density are assumptions; airflow coupling, radiation, contact resistance, and spreading resistance are omitted.
- The local SHA-256 chain and tail checkpoint detect ordinary edits and truncation. They are not immutable storage. Someone with write access to both files can replace history. Export and anchor the head hash externally for stronger provenance.
- There is no general guarantee of correctness outside tested conditions, detection of every error, universal claim verification, or elimination of every specification loophole. Human values require human decisions. Unlimited safe recursive self-improvement is unproven; this application cannot rewrite or deploy itself through model output.

See [verification and controls](docs/VERIFICATION.md) for the six goals, implemented checks, and remaining limits. Physical experimentation, generalized discovery, arbitrary code execution, and automatic self-improvement are outside this version's capabilities.

## Local data and security

API keys are held in the Electron main process. Persistent keys use Electron `safeStorage` (Windows DPAPI). If secure OS encryption is unavailable or the Linux backend is `basic_text`, keys stay in memory for the session and are never saved as plaintext. No key-read API is exposed to the renderer. OS encryption does not protect against a compromised operating-system account.

Settings and evidence are stored under Electron's application user-data directory (normally `%APPDATA%/artificial-inventor` on Windows). Evidence exports include task context, model proposals, all run outcomes, versions, and hashes; review them before sharing. Back up the **entire evidence directory**, including `evidence.jsonl` and `evidence-head.json`. Interrupted writes or a stale lock fail closed; preserve files before manual recovery. No automated repair discards evidence.

The renderer has context isolation, sandboxing, no Node integration, a restrictive content security policy, no remote content or navigation, denied permission requests, and restricted top-frame IPC. Provider adapters have fixed hosts, deadlines, response-size and output-token caps. Numerical workers run fixed trusted code with bounded candidates, memory, and time; they are not a sandbox for arbitrary generated programs.

## Development checks

```sh
npm run check
npm test
npm run test:ui                  # Windows/macOS with a desktop
xvfb-run -a npm run test:ui      # Linux virtual display
npm run dist:win                # Windows x64 NSIS installer
```

The Electron integration test exercises real UI → IPC → worker → evidence, unauthorized IPC rejection, session-only credential handling, and evidence after restart. Unit tests cover numerical invariants, constraint violations, seeded failures, ledger tampering, mocked provider contracts, and update controls. Live authenticated provider calls require keys and are separate from mocked contract tests.

## Windows releases

Pushing a version tag matching `package.json` (for example `v0.1.0`) runs the Windows workflow: install from lockfile, check, test, exercise Electron, build NSIS x64, and publish the installer, blockmap, and `latest.yml` to GitHub Releases. `workflow_dispatch` supports retrying publication. Publishing requires GitHub Actions to be enabled with contents-write permission.

Configure the optional Actions secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` for Authenticode signing. **Without a signing certificate the installer is unsigned**, and Windows may display an unknown-publisher/SmartScreen warning. Download integrity checks are not a substitute for publisher identity. No certificate or live provider key is bundled in the app.

On Linux, cross-packaging the Windows installer additionally requires Wine; the authoritative release build runs on Windows. Windows 10/11 x64 is the selected target; ARM64/native ARM installers are not included.
