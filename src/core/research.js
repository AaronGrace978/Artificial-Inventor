import { randomUUID } from 'node:crypto';

export const DEFAULT_SPEC = Object.freeze({
  title: 'Heat-sink design study',
  objective: 'Minimize predicted base temperature within mass and geometry constraints',
  heatLoadW: 20, ambientC: 25, maxBaseC: 85,
  widthMm: 100, depthMm: 100, maxHeightMm: 45, maxMassG: 300,
  convectionWm2K: 12, conductivityWmK: 205, budget: 120, seed: 42,
});

const ranges = {
  heatLoadW: [0.1, 200], ambientC: [-20, 60], maxBaseC: [0, 180],
  widthMm: [20, 200], depthMm: [20, 200], maxHeightMm: [10, 100],
  maxMassG: [20, 2000], convectionWm2K: [2, 100], conductivityWmK: [10, 450],
  budget: [10, 500], seed: [0, 4294967295],
};
const designKeys = ['finHeightMm', 'finThicknessMm', 'baseThicknessMm', 'finCount'];
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 5) => Number(value.toFixed(digits));

/** Compiles user-entered requirements. Missing fields use explicit, visible defaults. */
export function validateSpec(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Specification must be an object.');
  const spec = { ...DEFAULT_SPEC, ...input };
  const errors = [];
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_SPEC, key)) errors.push(`Unknown specification field: ${key}`);
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!finite(spec[key]) || spec[key] < min || spec[key] > max) errors.push(`${key} must be a number from ${min} to ${max}.`);
  }
  for (const key of ['budget', 'seed']) if (!Number.isInteger(spec[key])) errors.push(`${key} must be an integer.`);
  for (const key of ['title', 'objective']) if (typeof spec[key] !== 'string' || !spec[key].trim() || spec[key].length > 1000) errors.push(`${key} must contain 1–1000 characters.`);
  if (finite(spec.maxBaseC) && finite(spec.ambientC) && spec.maxBaseC <= spec.ambientC) errors.push('Maximum base temperature must exceed ambient temperature.');
  if (errors.length) throw new Error(errors.join(' '));
  return spec;
}

export function validateCandidate(design, spec = DEFAULT_SPEC) {
  const errors = [];
  if (!design || typeof design !== 'object' || Array.isArray(design)) return ['Candidate must be an object.'];
  for (const key of Object.keys(design)) if (![...designKeys, 'rationale'].includes(key)) errors.push(`Unknown candidate field: ${key}`);
  for (const key of designKeys) if (!finite(design[key])) errors.push(`${key} must be a finite number.`);
  if (design.rationale !== undefined && (typeof design.rationale !== 'string' || design.rationale.length > 2000)) errors.push('Rationale must be text of at most 2000 characters.');
  if (errors.length) return errors;
  if (!Number.isInteger(design.finCount) || design.finCount < 2 || design.finCount > 64) errors.push('Fin count must be an integer from 2 to 64.');
  if (design.finHeightMm < 2 || design.finHeightMm > 99) errors.push('Fin height must be from 2 to 99 mm.');
  if (design.finThicknessMm < 0.5 || design.finThicknessMm > 5) errors.push('Fin thickness must be from 0.5 to 5 mm.');
  if (design.baseThicknessMm < 1 || design.baseThicknessMm > 10) errors.push('Base thickness must be from 1 to 10 mm.');
  if (design.finHeightMm + design.baseThicknessMm > spec.maxHeightMm + 1e-9) errors.push('Total height exceeds the specification.');
  const gap = (spec.widthMm - design.finCount * design.finThicknessMm) / (design.finCount - 1);
  if (gap < 1) errors.push('Fins must fit the footprint with at least 1 mm clear spacing.');
  return errors;
}

function geometry(design, spec) {
  const width = spec.widthMm / 1000, depth = spec.depthMm / 1000;
  const length = design.finHeightMm / 1000, thickness = design.finThicknessMm / 1000;
  const base = design.baseThicknessMm / 1000;
  const crossSection = depth * thickness;
  const perimeter = 2 * (depth + thickness);
  return { width, depth, length, thickness, base, crossSection, perimeter,
    exposedBase: depth * (width - design.finCount * thickness),
    massG: 2700 * 1000 * (width * depth * base + design.finCount * crossSection * length),
  };
}

/** Separate finite-volume solution of the 1-D fin ODE, with adiabatic tip.
 * It checks implementation consistency, not the validity of the physical assumptions. */
export function numericFinConductance(design, spec, segments = 160) {
  if (!Number.isInteger(segments) || segments < 8 || segments > 1000) throw new Error('Segments must be an integer from 8 to 1000.');
  const { length, crossSection, perimeter } = geometry(design, spec);
  const dx = length / segments;
  const conduction = spec.conductivityWmK * crossSection / dx;
  const loss = spec.convectionWm2K * perimeter * dx;
  const upper = new Float64Array(segments), diagonal = new Float64Array(segments), rhs = new Float64Array(segments);
  for (let i = 0; i < segments; i++) {
    diagonal[i] = i === segments - 1 ? conduction + loss / 2 : 2 * conduction + loss;
    upper[i] = i === segments - 1 ? 0 : -conduction;
  }
  rhs[0] = conduction;
  for (let i = 1; i < segments; i++) {
    const factor = -conduction / diagonal[i - 1];
    diagonal[i] -= factor * upper[i - 1];
    rhs[i] -= factor * rhs[i - 1];
  }
  const theta = new Float64Array(segments);
  theta[segments - 1] = rhs[segments - 1] / diagonal[segments - 1];
  for (let i = segments - 2; i >= 0; i--) theta[i] = (rhs[i] - upper[i] * theta[i + 1]) / diagonal[i];
  const conductance = conduction * (1 - theta[0]) + loss / 2;
  const integratedLoss = loss * (0.5 + theta.slice(0, -1).reduce((sum, v) => sum + v, 0) + theta[segments - 1] / 2);
  return { conductance, energyBalanceRelativeError: Math.abs(conductance - integratedLoss) / conductance };
}

function analytical(design, spec) {
  const g = geometry(design, spec);
  const m = Math.sqrt(spec.convectionWm2K * g.perimeter / (spec.conductivityWmK * g.crossSection));
  const finEfficiency = Math.tanh(m * g.length) / (m * g.length);
  const conductance = spec.convectionWm2K * (g.exposedBase + design.finCount * finEfficiency * g.perimeter * g.length);
  const resistance = g.base / (spec.conductivityWmK * g.width * g.depth) + 1 / conductance;
  return { ...g, finEfficiency, conductance, resistance, temperature: spec.ambientC + spec.heatLoadW * resistance };
}

export function evaluateCandidate(input, inputSpec = {}) {
  const spec = validateSpec(inputSpec);
  const errors = validateCandidate(input, spec);
  // Preserve bounded JSON data only; no model content is ever executable.
  const design = Object.fromEntries(designKeys.map((key) => [key, finite(input?.[key]) ? input[key] : null]));
  const rationale = typeof input?.rationale === 'string' ? input.rationale.slice(0, 2000) : '';
  if (errors.length) return { design, rationale, status: 'rejected', evidenceLevel: 'E0', checks: errors, verification: { passed: false } };
  const result = analytical(design, spec);
  const numeric = numericFinConductance(design, spec);
  const numericFine = numericFinConductance(design, spec, 320);
  const numericTotal = spec.convectionWm2K * result.exposedBase + design.finCount * numericFine.conductance;
  const relativeError = Math.abs(numericTotal - result.conductance) / result.conductance;
  const meshRelativeError = Math.abs(numericFine.conductance - numeric.conductance) / numericFine.conductance;
  const checks = [];
  if (result.massG > spec.maxMassG) checks.push('Mass exceeds the specification.');
  if (result.temperature > spec.maxBaseC) checks.push('Predicted base temperature exceeds the specification.');
  const verified = relativeError < 0.003 && meshRelativeError < 0.003 && numericFine.energyBalanceRelativeError < 1e-6;
  if (!verified) checks.push('Numerical agreement, energy balance, or mesh convergence failed.');
  return {
    design, rationale, status: checks.length ? 'rejected' : 'passed', evidenceLevel: verified ? 'E2' : 'E1',
    predictedBaseC: round(result.temperature), thermalResistanceKPerW: round(result.resistance),
    massG: round(result.massG), finEfficiency: round(result.finEfficiency), checks,
    verification: { passed: verified, analyticConductanceWPerK: round(result.conductance, 8), numericConductanceWPerK: round(numericTotal, 8), relativeError, meshRelativeError, energyBalanceRelativeError: numericFine.energyBalanceRelativeError,
      limitation: 'Distinct numerical implementation of the same idealized 1-D physics; shared assumptions remain unverified.' },
  };
}

function randomSource(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** A finite deterministic workflow: propose -> constrain -> compute -> verify -> record.
 * Cloud text may supply designs, never tools, permissions, or evidence promotions. */
export function createResearchRun(inputSpec = {}, { proposals = [] } = {}) {
  const spec = validateSpec(inputSpec);
  if (!Array.isArray(proposals) || proposals.length > 30) throw new Error('At most 30 model proposals are allowed.');
  if (proposals.length >= spec.budget) throw new Error('Candidate budget must include every supplied proposal and one conventional baseline.');
  const rng = randomSource(spec.seed);
  const candidates = [];
  const add = (design, source) => {
    const candidate = evaluateCandidate(design, spec);
    candidates.push({ id: `candidate-${candidates.length + 1}`, source, ...candidate });
    return candidates.at(-1);
  };
  const baseline = add({ finHeightMm: Math.min(25, spec.maxHeightMm - 5), finThicknessMm: 1,
    baseThicknessMm: 5, finCount: Math.min(20, Math.floor((spec.widthMm + 1) / 2)) }, 'conventional-baseline');
  for (const proposal of proposals) {
    add(proposal, 'cloud-model-proposal');
  }
  while (candidates.length < spec.budget) {
    const baseThicknessMm = round(1 + 7 * rng(), 2);
    const finThicknessMm = round(0.5 + 2.5 * rng(), 2);
    const finHeightMm = round(2 + (spec.maxHeightMm - baseThicknessMm - 2) * rng(), 2);
    const maxFins = Math.max(2, Math.min(64, Math.floor((spec.widthMm + 1) / (finThicknessMm + 1))));
    const finCount = 2 + Math.floor(rng() * (maxFins - 1));
    add({ baseThicknessMm, finThicknessMm, finHeightMm, finCount }, 'seeded-bounded-search');
  }
  const feasible = candidates.filter((candidate) => candidate.status === 'passed').sort((a, b) => a.predictedBaseC - b.predictedBaseC || a.massG - b.massG);
  const best = feasible[0] ?? null;
  const improvementPercent = best && baseline.status === 'passed' && finite(baseline.thermalResistanceKPerW)
    ? round(100 * (baseline.thermalResistanceKPerW - best.thermalResistanceKPerW) / baseline.thermalResistanceKPerW, 2) : null;
  const sensitivity = best ? [
    ['30% lower convection', { ...spec, convectionWm2K: spec.convectionWm2K * 0.7 }],
    ['20% higher heat load', { ...spec, heatLoadW: spec.heatLoadW * 1.2 }],
    ['10°C hotter surroundings', { ...spec, ambientC: spec.ambientC + 10 }],
  ].map(([scenario, shifted]) => {
    const prediction = analytical(best.design, shifted);
    return { scenario, predictedBaseC: round(prediction.temperature), withinTemperatureLimit: prediction.temperature <= spec.maxBaseC,
      evidence: 'Exploratory sensitivity calculation; not a held-out physical validation.' };
  }) : [];
  return {
    id: randomUUID(), createdAt: new Date().toISOString(), version: 1, status: best ? 'completed' : 'no-feasible-design',
    spec, baseline, best, candidates,
    summary: { evaluated: candidates.length, passed: feasible.length, rejected: candidates.length - feasible.length, improvementPercent, budgetUsed: candidates.length,
      baselineFeasible: baseline.status === 'passed', baselineComparison: baseline.status === 'passed' ? 'Compared with a fixed conventional design under the same stated constraints.' : 'The conventional baseline violates constraints; no percentage improvement claim is made.',
      claim: best ? 'A feasible design was found under the stated analytical assumptions.' : 'No feasible design was found within this finite search budget.' },
    verification: { evidenceLevel: best ? 'E2' : 'E0', numericalAgreement: best?.verification.passed ?? false, sensitivity,
      discrepancyFlags: sensitivity.filter((item) => !item.withinTemperatureLimit).map((item) => `${item.scenario} exceeds the temperature limit; do not extend the operating envelope.`),
      physicalValidation: 'not-performed', independentReplication: 'not-performed' },
    scope: {
      domain: 'Rectangular aluminum straight-fin heat sinks; uniform prescribed convection.',
      assumptions: ['Steady state; uniform base temperature; constant isotropic conductivity.', '1-D fin conduction, adiabatic fin tips, fixed heat transfer coefficient.', 'Aluminum density assumed 2700 kg/m³, independent of chosen conductivity.', 'No radiation, airflow coupling, contact resistance, spreading resistance, or manufacturing tolerance model.'],
      operatingEnvelope: { heatLoadW: spec.heatLoadW, ambientC: spec.ambientC, convectionWm2K: spec.convectionWm2K, conductivityWmK: spec.conductivityWmK },
      limits: ['E2 means computational consistency in this model, not measured thermal performance.', 'Finite tests cannot guarantee correctness outside tested conditions or detect every model error.', 'A model prediction is not authorization to fabricate, deploy, or self-modify.'],
    },
    falsificationPlan: [
      'Before fabrication, register the chosen design, heat load, convection estimate, ambient, and temperature prediction.',
      'Measure contact resistance and airflow using calibrated equipment; retain failed and successful trials.',
      'Predeclare acceptable prediction error and include conventional baseline controls under the same conditions.',
      'Use a separate operator and equipment for replication. Requalify after changing geometry, materials, or operating conditions.',
    ],
    improvementProposals: [{ kind: 'offline-study', status: 'proposed-only', title: 'Test a richer airflow and spreading-resistance model',
      rationale: 'The current simplified model cannot determine convection from geometry. Compare against withheld measured cases before accepting a replacement.',
      authorization: 'No automatic code changes or deployment. External review and requalification required.' }],
  };
}
