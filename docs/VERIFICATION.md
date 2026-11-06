# Verification and scientific limits

Artificial Inventor is a bounded heat-sink design workbench. It is not a general artificial scientist, a physical experiment controller, a proof assistant, or a system qualified for consequential autonomous deployment. Its cloud models propose numbers and explanatory text. Trusted local code validates and evaluates those numbers. Model output cannot provide executable tools, alter checks, award evidence levels, choose permissions, or deploy improvements.

## What a research run establishes

The present domain is a rectangular aluminum straight-fin heat sink with prescribed heat load, ambient temperature, thermal conductivity, and a **fixed convection coefficient**. The optimizer varies fin count, fin height, fin thickness, and base thickness within explicit bounds. Density is assumed to be 2700 kg/m³. Conductivity and convection are user assumptions, not measured material or airflow properties.

The analytical model assumes steady state, an isothermal base, constant conductivity, one-dimensional fin conduction, and adiabatic fin tips. It adds through-thickness base conduction and parallel base/fin convection. It omits spreading resistance, contact resistance, radiation, airflow coupling, tolerances, and transient behavior. In particular, the design does not calculate whether closely spaced fins could physically sustain the supplied convection coefficient. A design that performs well in this model may perform poorly in hardware.

Each geometrically valid design is checked with a separate finite-volume implementation of the same fin equation. Agreement, energy balance, and grid refinement detect some implementation mistakes. These methods share physical assumptions; they do not independently establish that the model describes reality. Exploratory heat-load, convection, and ambient shifts reveal some sensitivity, but are not held-out measurements or broad robustness certification.

Search has a fixed candidate budget and deterministic seed. Both accepted and rejected candidate evaluations are retained. A conventional baseline uses the same user constraints; a percentage improvement is reported only when that baseline is feasible. This is a comparison with one fixed baseline and a finite search, not a claim of global optimality, novelty, superiority to human engineering, or fair comparison against every available optimizer.

## Evidence states

| State | Meaning | Current implementation |
| --- | --- | --- |
| E0 | Proposed or rejected before computational validation | Cloud proposals and invalid designs |
| E1 | Structural checks only, or computational verification incomplete | Available for failed numerical agreement |
| E2 | Checked computation under explicit model assumptions | Highest level produced by this application |
| E3 | Preregistered prospective physical experiment | Not implemented or awarded |
| E4 | Independent replication within a stated operating envelope | Not implemented or awarded |

A candidate can have E2 computational evidence and still be rejected for exceeding mass or temperature limits. Passing numerical verification is separate from satisfying the design specification. A completed run never means that a physical invention was validated.

## The six requested guarantees

| Requested property | Practical control here | Remaining limit |
| --- | --- | --- |
| Correctness outside tested conditions | Explicit assumptions, scope, sensitivity calculations, and warnings on failed temperature limits | Finite observations cannot establish unrestricted correctness. Untested regimes remain unqualified. |
| Detection of every model error | Separate numerical solver, balance checks, refinement, constraint checks, and recorded failures | Shared assumptions and unknown physical effects can defeat all these checks. |
| Verification of every claim | Typed design format, provenance, recorded predictions, and a proposed falsification plan | Arbitrary scientific claims, model rationales, and human assertions are not verified. |
| Elimination of specification loopholes | Models cannot change constraints, evaluation code, evidence status, or actions | Humans can still specify the wrong goal, and software can contain defects. |
| Technical determination of human values | Humans supply goals, constraints, budgets, and decisions | Optimization cannot establish moral authority, representation, consent, or legitimate trade-offs. |
| Safe unlimited recursive improvement | Improvements remain proposed offline studies requiring external evaluation and authorization | There is no self-rewriting or automatic research-system deployment, and no claim of safe unlimited improvement. |

The application never fabricates, controls instruments, launches model-generated code, or grants a model filesystem or shell access. Numerical evaluation runs in a worker thread with memory and wall-clock limits. A worker thread is a responsiveness/resource control for trusted numerical code, not an isolation boundary suitable for executing hostile code.

## Evidence integrity and external anchoring

The local evidence store is a JSON-lines hash chain. Each row covers its payload, sequence, timestamp, event type, and previous hash. A separate head checkpoint detects missing final rows and interrupted writes. Integrity failures prevent normal reads and further appends. Do not delete or recreate the store to conceal a failed check; preserve it for investigation.

This store is **tamper evident under a limited local threat model**, not immutable or independently witnessed. An attacker or administrator able to rewrite both the ledger and its checkpoint can replace its entire history. Deleting both files is indistinguishable from a new empty store unless an external record exists. Local timestamps are not trusted timestamps, and local hashes do not establish authorship or scientific truth.

For stronger provenance, export the complete evidence package and record the ledger's `headHash` and `count` in a separate independently controlled location before a decisive experiment. Examples include a versioned institutional archive or independent timestamp service. That external anchoring is a manual research procedure; the application does not implement or claim it. Compare later exports against the independently retained head and preserved earlier records. Restrict access to both local evidence and archives.

## Before making a physical claim

Preregister a candidate, predictions, uncertainty, operating envelope, stopping criteria, and analysis procedure before measurement. Use calibrated equipment, baseline controls, retained failed trials, and explicit tolerances. Record mismatch without silently changing the prediction. Have separate operators and equipment replicate important results. The current application exports the computational package and a suggested plan; these physical steps remain outside its implemented workflow.
