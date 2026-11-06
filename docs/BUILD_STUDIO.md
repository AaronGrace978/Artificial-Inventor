# Build studio

Build studio supports offline browser applications, inspectable code projects and interactive product concept visualizers. It does not provide an unrestricted terminal agent or a general native-code execution sandbox.

## Bounded workflow

1. **Plan:** the selected model specifies one to six portable source paths, their interfaces, and one to three declarative interaction smoke tests for browser projects. The host validates the full plan before requesting source.
2. **Generate:** request each file separately as raw source. A provider must confirm completion. Complete files are size/path checked and checkpointed before proceeding; incomplete streams are rejected.
3. **Check:** trusted worker code independently checks structure, supported JavaScript/JSON syntax, and common local resource references without executing source in Node.
4. **Test:** browser builds that pass static checks load in a separate sandboxed, offline Electron renderer with no preload/Node bridge. Fixed automation checks rendered content, captures console errors, and runs up to three declared tests, each limited to five clicks/inputs and an expected text assertion. Each browser run has a six-second limit. These model-declared tests can miss defects or misunderstand the goal; review the source and manually test important behavior.
5. **Repair:** feed failures and current source back to the same model for at most two file repairs, then rerun checks. Retain unresolved failures visibly; do not replace them with success.
6. **Save:** persist source, artifact hashes, provenance and a bounded check report. Inspect the result, run an isolated preview, and export a project to your own tools.

Each attempt has at most nine provider calls. Output allowance applies separately to each call; reasoning may consume it. A total wall-clock deadline covers generation and verification. Cancellation stops the active call; a failed call is not automatically repeated. Repairs following successful source generation are additional, disclosed paid calls within the request budget.

Completed files survive failure/cancellation. Resume requires the same goal, project type and exact model. It uses saved complete files; it does not claim token-level model resumption. Starting over deliberately discards the active checkpoint, while previously saved projects remain available. No automatic request is sent on startup or reload.

## Product visualization

Product visualizer mode asks for an original SVG/Canvas illustration with working parameter/material/view controls, explanatory labels and suitable assembly views. The offline Forma demo demonstrates a task lamp with proportions, finishes, rotation, exploded assembly, wireframe and reset controls. These are conceptual renderings, not CAD tolerances, photorealism or validated engineering predictions.

The host's **Save illustration** button issues a one-use random token to the current preview. A cooperating visualizer replies with its serialized SVG; the renderer accepts only that frame and token, bounds the payload, and invokes an authorized host save dialog. The preview receives no filesystem path, API key or application bridge. A reply without an active user-initiated export is ignored. Source is exported as inert text and never evaluated in the main process; review exported SVG/code before opening it outside the isolated preview.

Generated visualizers implement the message contract described in their generation prompt. Canvas-only or non-cooperating projects can still be exported as source, but cannot claim host SVG export. Direct in-frame downloads may be blocked by the preview sandbox; the host export is the supported route.

## Development validation

Run `npm run check`, `npm test`, and the real Electron integration suite (`npm run test:ui` with a desktop). Mocked provider tests verify API contracts and deterministic failure/repair/resume behavior. They do not establish that a particular cloud model/account works. A live provider check additionally requires a key, model access and the destination allowed by the cloud environment network policy. Never commit credentials.
