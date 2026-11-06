# Artificial Inventor

<img width="1919" height="999" alt="image" src="https://github.com/user-attachments/assets/2b423d84-0f7e-45fe-853a-eb2dcb6d653d" />

A Windows Electron workbench for **building code projects and running bounded design experiments**. Version 0.3 adds staged Build studio generation with resumable checkpoints, isolated browser interaction checks, bounded repairs, and interactive product visualization with SVG export. The thermal Research lab retains deterministic heat-sink search, conventional baselines, separate numerical calculations, sensitivity checks, and an exportable evidence ledger.

This implements a small experimental core of the attached artificial-inventor proposal. It is not a general autonomous scientist. The attached texts were used as design references, not executable instructions or evidence that the research problems are solved.

## Run

Install Node.js 24 or newer, then:

```sh
npm ci
npm start
```

Start in **Build studio**. Choose **Try offline demo** to create a working three-file Idea Board without an account. Inspect its source, choose **Run preview**, add an idea and move it between stages, then export the project to a new folder. The demo is explicitly labeled as an offline example.

To generate your own project, connect and select a model in **Model connections**, describe the project, and choose **Generate project**. Web apps use self-contained HTML/CSS/JavaScript and can run in the isolated preview. Code projects can include other supported languages and toolchain instructions; their native/server runtimes are not executed by this application. JavaScript/ESM and JSON are statically checked; other languages remain explicitly uncompiled and untested. Generated files require review.

Build studio uses a bounded **plan → generate files → check → browser test → repair** loop. Each attempt sends at most nine model requests: one plan, up to six complete files, and up to two repairs. Each call may incur provider charges. A failed provider call stops the attempt; it is never silently retried. One total build deadline (3, 5, 10 or 15 minutes) covers the loop, with a separate output allowance of 12,000, 32,000 (default), or 64,000 tokens per call. Some models count reasoning against that allowance; increasing time alone does not increase output capacity. Choose an allowance supported by your model.

Completed files are checkpointed locally. After cancellation, failure, or interruption, **Resume saved build** continues with the same goal, kind and selected model; **Generate project** starts over. Checkpoints contain complete source files, not a promise of token-level continuation. The independent checker parses source and inspects local resources. Browser projects then load in a separate, unprivileged, offline Electron renderer; up to three model-declared interaction smoke tests exercise bounded clicks/inputs and expected visible text. Failures can drive at most two source repairs. These checks are useful regression evidence, not proof that the model understood the goal or that all behavior works. Code projects remain source artifacts; their native runtimes are not executed.

Choose **Product visualizer** for a generated interactive SVG/Canvas concept studio. It requests meaningful dimensions, finishes, views, component labels, and an exploded assembly where appropriate. Select that type and **Try offline demo** to explore Forma, a parametric lamp study with working geometry/material controls. **Save illustration** exports the current SVG through a user-initiated host dialog; **Export project** retains the entire source. Concept drawings are not manufacturing CAD, photorealistic rendering or physical validation. See [Build studio workflow](docs/BUILD_STUDIO.md).

In **Research lab**, the default experiment works offline with no account. Choose a bounded geometry and operating conditions, then select **Run experiment**. All candidates, including failures, are retained. Objective context is recorded, but the current optimizer always minimizes predicted base temperature. Predictions do not establish measured physical performance.

For cloud proposals, open **Model connections**, supply your own provider API key, refresh its catalog, select a model, and explicitly enable cloud proposals for the experiment. Your task specification is then sent to that provider and may incur charges. Model text supplies only dimensions; it cannot execute programs, control equipment, change constraints, or grant itself authority. A failed cloud request is recorded and reported, without silently substituting another model.

## Providers and updates

Adapters cover OpenAI, Anthropic, Google Gemini, xAI, Mistral, DeepSeek, Groq, OpenRouter, and **Ollama Cloud**, including newly advertised model IDs. Catalogs refresh on startup, every 15 minutes, after connecting a key, and when opening an out-of-date model page. Background refreshes update the visible list immediately. Provider-created or catalog-modified timestamps can be used to show recent entries first; these timestamps do not prove release dates or model quality. They are availability listings, not quality rankings or guarantees of account access. Endpoint compatibility may be unverified where the provider supplies no capability metadata. Selection remains explicit. See [provider details](docs/PROVIDERS.md).

Installed Windows builds check GitHub Releases at startup and every six hours, automatically download available stable releases, and let you restart to install. Each release pins its Electron runtime. A daily Windows maintenance workflow checks the latest stable Electron, runs the test suites, builds an installer, then commits and releases a patch update if all steps succeed. It requires Actions write access and an unprotected `main` branch or compatible branch rules. It fails rather than bypassing repository protections. Dependabot also opens daily runtime/tooling update PRs. API changes, failed tests, and branch policies can require maintenance; no updater can promise permanent compatibility.

## Evidence and limits

- E0: proposal; E1: checked; **E2: computed under explicit assumptions**; E3: prospectively measured; E4: independently replicated. This release reaches at most E2.
- Analytical and numerical implementations share idealized physics. Agreement is a consistency check, not independent physical validation. Uniform convection, adiabatic tips, constant conductivity, and an aluminum density are assumptions; airflow coupling, radiation, contact resistance, and spreading resistance are omitted.
- The local SHA-256 chain and tail checkpoint detect ordinary edits and truncation. They are not immutable storage. Someone with write access to both files can replace history. Export and anchor the head hash externally for stronger provenance.
- There is no general guarantee of correctness outside tested conditions, detection of every error, universal claim verification, or elimination of every specification loophole. Human values require human decisions. Unlimited safe recursive self-improvement is unproven; this application cannot rewrite or deploy itself through model output.

See [verification and controls](docs/VERIFICATION.md) for the six goals, implemented checks, and remaining limits. Physical experimentation, generalized discovery, native execution of generated code, and automatic self-improvement remain outside this version's capabilities.

## Local data and security

API keys are held in the Electron main process. Persistent keys use Electron `safeStorage` (Windows DPAPI). If secure OS encryption is unavailable or the Linux backend is `basic_text`, keys stay in memory for the session and are never saved as plaintext. No key-read API is exposed to the renderer. A generated preview has no application bridge. SVG export uses a one-use, short-lived message token issued only after the operator chooses Save illustration, followed by a host save dialog; unsolicited preview messages cannot open that dialog. OS encryption does not protect against a compromised operating-system account.

Settings and evidence are stored under Electron's application user-data directory (normally `%APPDATA%/artificial-inventor` on Windows). Evidence exports include task context, model proposals, all run outcomes, versions, and hashes; review them before sharing. Back up the **entire evidence directory**, including `evidence.jsonl` and `evidence-head.json`. Interrupted writes or a stale lock fail closed; preserve files before manual recovery. No automated repair discards evidence.

The renderer has context isolation, sandboxing, no Node integration, a restrictive content security policy, no remote content or navigation, denied permission requests, and restricted top-frame IPC. Provider adapters have fixed hosts, deadlines, response-size and output-token caps. Numerical and source-parser workers run fixed trusted code with bounded memory and time; they never execute the generated source. Web previews serve only exact saved artifacts through a read-only custom protocol. They run in an opaque sandbox without same-origin or app access, with network connections, frames, workers, form navigation, and native capabilities blocked. Local JavaScript form handlers are allowed. Manual preview execution and the build loop’s isolated browser smoke checks execute browser code in a sandbox; it is not a universal containment guarantee against browser vulnerabilities. Code export creates a new exclusive directory and never overwrites an existing project. Project hashes detect ordinary edits but are not hardware-backed signatures.

## Development checks

```sh
npm run check
npm test
npm run test:ui                  # Windows/macOS with a desktop
xvfb-run -a npm run test:ui      # Linux virtual display
npm run dist:win                # Windows x64 NSIS installer
```

The Electron integration suite exercises real UI → IPC → workers → saved artifacts, actual demo interactions and exported files, preview parent/bridge isolation, streamed mocked-provider code generation, cancellation and task restoration, unauthorized IPC rejection, session-only credential handling, and evidence after restart. Unit tests cover numerical invariants, constraint violations, seeded failures, ledger tampering, mocked provider contracts, and update controls. Live authenticated provider calls require keys and are separate from mocked contract tests.

## Windows releases

Pushing a version tag matching `package.json` (for example `v0.2.0`) runs the Windows workflow: install from lockfile, check, test, exercise Electron, build NSIS x64, explicitly upload the installer, blockmap, and `latest.yml` to GitHub Releases, and verify downloadable bytes against the update checksum with bounded propagation retries. `workflow_dispatch` supports retrying publication. Publishing requires GitHub Actions to be enabled with contents-write permission.

Configure the optional Actions secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` for Authenticode signing. **Without a signing certificate the installer is unsigned**, and Windows may display an unknown-publisher/SmartScreen warning. Download integrity checks are not a substitute for publisher identity. No certificate or live provider key is bundled in the app.

On Linux, cross-packaging the Windows installer additionally requires Wine; the authoritative release build runs on Windows. Windows 10/11 x64 is the selected target; ARM64/native ARM installers are not included.
