import type { ChatMessage } from "./deepseekClient";
import type { ValidationError } from "../graph/types";

// ============================================================================
// SHARED PROMPT CONSTANTS
// ============================================================================

const FREE_FALL_EXAMPLE = JSON.stringify({
  version: "3.0",
  world: {
    units: { length: "m", time: "s", mass: "kg", angle: "rad" },
    scale: 100,
    bounds: { min: [-3.6, -2.8], max: [3.6, 2.8] },
    constants: { g: 9.81 },
    gravity: { vector: [0, -9.81] }
  },
  objects: [
    { id: "ball", label: "Ball", type: "particle", properties: { mass: 1, radius: 0.18, material: "rubber" }, degrees_of_freedom: { translation: true }, geometry: { type: "circle", radius: 0.18 }, metadata: { role: "dynamic", render: { color: "#1f8a70", visible: true } } },
    { id: "ground", label: "Ground", type: "rigid_body", properties: { mass: 1000000, inertia: 1000000, material: "concrete" }, degrees_of_freedom: { translation: false, rotation: false }, geometry: { type: "box", size: [7.2, 0.32] }, metadata: { role: "anchor", fixed: true, render: { color: "#6c757d", visible: true } } }
  ],
  interactions: [
    { id: "gravity_on_ball", type: "field", model: "uniform", field: "g_field", applies_to: ["ball"] },
    { id: "ground_contact", type: "constraint", model: "inequality", between: ["ball", "ground"], parameters: { condition: "contact", compliance: 0.000001 }, metadata: { priority: 2, lambda_max: 981 } }
  ],
  fields: [{ id: "g_field", model: "uniform", vector: [0, -9.81] }],
  initial_state: { ball: { position: [-1.2, 1.8], velocity: [0, 0] }, ground: { position: [0, -2.4], velocity: [0, 0] } },
  events: [],
  observables: { position: true, velocity: true, energy: true, constraint_error: true, events: true },
  timeline: { terminal_condition: "t >= 6", keyframes: [{ t: 0, state: "initial" }] }
}, null, 2);

// ============================================================================
// DSL GENERATION PROMPT (Stage 2)
// ============================================================================

const SCHEMA_CONSTRAINTS = [
  "You are an expert physics scene encoder. Convert a semantic IR into a valid Graph DSL v3.0 JSON document for a Box2D-WASM engine.",
  "",
  "=== CORE PRINCIPLE ===",
  "Solve physics ONLY for t=0 initial state and required event times. The engine computes all t>0 motion. You set keyframes; engine fills gaps.",
  "",
  "=== SCOPE ===",
  "Chinese high-school physics. Angular momentum, rigid-body rotation, rolling are OUT OF SCOPE. Moving objects: type=\"particle\", translation only. Box/circle geometry for visual shape. Fixed anchors/walls: type=\"rigid_body\", all DOF disabled.",
  "",
  "=== REQUIRED FIELDS ===",
  "1. version: \"3.0\"",
  "2. world: { units:{length:\"m\",time:\"s\",mass:\"kg\",angle:\"rad\"}, bounds:{min:[x,y],max:[x,y]}, gravity:{vector:[0,-9.81]} }",
  "3. objects[]: { id, label, type, properties:{mass,radius?,charge?,restitution?,friction?}, degrees_of_freedom, geometry, metadata:{role,render:{color,visible}} }",
  "   - mass REQUIRED for dynamic objects. Anchors: mass=1e10, inertia=1e10.",
  "   - restitution: 0=inelastic, 1=elastic. Default 1 for collisions, 0.3 for walls.",
  "4. variables[]: slider controls. Bindings: objects[id=x].properties.mass, interactions[id=x].parameters.restitution (pairwise), fields[id=x].vector[1], initial_state.x.velocity[0].",
  "5. motion_profiles[]: { id, target, quantity:\"position\"|\"velocity\"|\"force\", mode:\"set\"|\"add\", keyframes|expression }",
  "6. interactions[]: constraints and field bindings. All constraints MUST include compliance>=0.000001, priority, lambda_max.",
  "   Spring: spring between[a,b], rest_length, stiffness, damping. tags=[\"spring\"], priority=5.",
  "   Rod/Rope: distance between[a,b], value, compliance. Rope: tags=[\"rope\",\"unilateral\"]. Auto slack/taut.",
  "   Hinge: hinge between[a,b], anchor[x,y]. Pendulum. priority=1.",
  "   Slider: slider between[a,b], anchor[x,y], axis[dx,dy]. Linear rail. priority=1.",
  "   Pulley: pulley between[a,b], ground_anchor_a/b, length_a/b, ratio. Atwood. priority=1.",
  "   Inequality: inequality between[a,b], condition:\"contact\", restitution?, friction?. priority=2, lambda_max=2000.",
  "     CRITICAL: elastic(e=1) and inelastic(e=0) use SAME structure. Only restitution differs. No weld/sticky.",
  "7. fields[]: uniform [gx,gy], radial origin+strength, uniform+temporal/spatial variation.",
  "   Electric: uniform/metadata.tags=[\"electric\"], object needs charge. F=qE.",
  "   Magnetic: uniform/metadata.tags=[\"magnetic\"], vector=[0,0,Bz], object needs charge+velocity. F=qvxB.",
  "   Radial point-source: radial origin+strength, tags=[\"electric\",\"charge\"] => F=qk/r^2.",
  "   Moving origin: radial + origin_from=\"object_id\".",
  "   Variation: temporal:\"sin(t*w)\" or spatial:\"sin(k*x)\". Functions: sin/cos/exp/abs/pi.",
  "8. initial_state: EVERY object MUST have {position:[x,y],velocity:[vx,vy]}. Spring: compute y_eq = y_anchor - L0 - mg/k.",
  "9. events[]: trigger(time/condition/impact/constraint_saturated), action(control/remove/modify/modify_constraint/switch_model).",
  "   Conditions: obj.x/y/vx/vy, distance(a,b), && / ||, math functions. Duration: use number, not \"instant\".",
  "10. observables, timeline: terminal_condition:\"t>=N\", keyframes:[{t:0,state:\"initial\"}].",
  "",
  "=== CONSTRAINTS RULES ===",
  "- Anchors: rigid_body, all DOF disabled, mass=1e10.",
  "- All constraints: compliance>=0.000001, priority, lambda_max.",
  "- Do NOT create redundant closed loops.",
  "- Impulse controls: duration>=0.01s, impulseSmoothing=\"ramp\".",
].join("\n");

// ============================================================================
// IR ANALYSIS PROMPT (Stage 1)
// ============================================================================

const IR_CONTRACT = [
  "You are a physics scene analyst. Given a natural-language problem, produce a complete Intermediate Representation (IR) with CONCRETE numeric values. The downstream DSL encoder CANNOT guess numbers.",
  "",
  "=== CRITICAL: PHYSICAL PROPERTY ACCURACY ===",
  "The #1 failure mode is wrong physical parameters. Structural validity != physical correctness. Get these right:",
  "1. Object mass (kg). Use physics intuition: light ball=0.1-0.5, block/slider=0.5-2, heavy=3-10, cart=2-5.",
  "2. Spring stiffness (N/m). Soft=20-80, normal=80-200, stiff=200-500. Default k=100.",
  "3. Spring equilibrium position: y_eq = y_anchor - rest_length - m*g/k. Write THAT number. NEVER \"equilibrium\".",
  "4. Collision restitution: elastic=1.0, partially elastic=0.5-0.8, inelastic=0. Variable->slider[0,1] default 1.",
  "5. Object positions MUST make spatial sense. Ball ABOVE ground => ball.y > ground.y (y-up).",
  "6. Field strengths MUST produce visible forces: E~5-20 N/C, Bz~2-5 T, charge~1 C (visual).",
  "",
  "=== SCOPE ===",
  "High-school physics. No angular momentum, no rigid-body rotation, no rolling. Moving objects: point mass, translation only.",
  "",
  "=== HARD REQUIREMENTS ===",
  "1. EVERY object: absolute world position (x,y) in meters. Spring: compute y_eq, write the number.",
  "2. EVERY dynamic object: numeric mass in kg.",
  "3. EVERY spring/rope/rod: numeric rest_length and stiffness.",
  "4. EVERY collision: numeric restitution. Variable->slider[0,1] default 1. Elastic and inelastic use SAME structure, only e differs.",
  "5. ALWAYS include ground when gravity is present. Ground: rigid_body box[8,0.4] below all objects.",
  "6. y-up coordinate system. Gravity [0,-9.81]. Anchors at positive y.",
  "",
  "=== OUTPUT FORMAT (two steps) ===",
  "Step A: Structured restatement in plain language with ALL numeric values.",
  "Step B: IR JSON in a ```json fenced block with these fields:",
  "1. summary, 2. objects[{id,label,role,mass,radius,restitution,friction,initial_position:[x,y],initial_velocity:[vx,vy]}],",
  "3. known_quantities, 4. unknown_quantities (ALL with numeric defaults),",
  "5. relationships, 6. events, 7. timeline, 8. layout (absolute SI positions),",
  "9. assumptions (every default with justification), 10. uncertainties.",
  "",
  "=== FIELD REFERENCE ===",
  "- Gravity: uniform [0,-9.81], applies to all with mass.",
  "- Electric: uniform [Ex,Ey], object needs charge, field id contains \"electric\" or tags=[\"electric\"]. F=qE.",
  "- Magnetic: uniform [0,0,Bz], object needs charge+velocity, tags=[\"magnetic\"]. F=qvxB.",
  "- Radial: origin[x,y]+strength k, force=k/r^2. Electric: tags=[\"electric\",\"charge\"] => F=qk/r^2.",
  "- Moving origin: origin_from=\"object_id\".",
  "- Time-varying: variation:{temporal:\"sin(t*w)\"}. Spatial: variation:{spatial:\"sin(k*x)\"}. Functions: sin/cos/exp/abs/pi.",
  "",
  "=== COMMON MISTAKES ===",
  "- Do NOT use rigid_body for moving objects. Use particle.",
  "- Do NOT enable rotation DOF. translation=true, rotation=false.",
  "- Do NOT use weld/sticky for inelastic collision. Just restitution=0.",
  "- Do NOT write \"at equilibrium\". Compute the actual y coordinate.",
  "- Do NOT use duration:\"instant\". Use >=0.01s.",
  "- Multi-field: define each field separately, forces add automatically.",
].join("\n");

// ============================================================================
// BUILDERS
// ============================================================================

const STAGE_1_SYSTEM = ["You are a physics scene analyst. Restate the problem with concrete numeric values, then output IR JSON.", "", IR_CONTRACT].join("\n");
const STAGE_2_SYSTEM = ["Convert physics IR into DSL JSON. Output valid JSON only. IR already has all numbers — use them directly.", "", SCHEMA_CONSTRAINTS, "", "Reference:", FREE_FALL_EXAMPLE].join("\n");

export function buildUnifiedSystemPrompt(): ChatMessage { return { role: "system", content: STAGE_2_SYSTEM }; }

export function buildConversationStart(problem: string): ChatMessage[] {
  return [{ role: "system", content: STAGE_1_SYSTEM }, { role: "user", content: ["Analyse this problem. First write a restatement with concrete values, then IR JSON in ```json.", "", "Problem:", problem].join("\n") }];
}

export function appendDSLRequest(prev: ChatMessage[], irContent: string): ChatMessage[] {
  return [{ role: "system", content: STAGE_2_SYSTEM }, ...prev.filter(m => m.role !== "system"), { role: "assistant", content: irContent }, { role: "user", content: "Convert the IR above into DSL JSON." }];
}

export function appendRepairRequest(prev: ChatMessage[], dslContent: string, errors: ValidationError[]): ChatMessage[] {
  return [{ role: "system", content: STAGE_2_SYSTEM }, ...prev.filter(m => m.role !== "system"), { role: "assistant", content: dslContent }, { role: "user", content: ["The DSL failed validation. Fix errors. Output valid JSON only.", "", "Errors:", JSON.stringify(errors, null, 2)].join("\n") }];
}

// ============================================================================
// LEGACY
// ============================================================================

export function buildAnalysisSystemPrompt(): ChatMessage { return { role: "system", content: ["Extract physics IR from problem.", "", IR_CONTRACT].join("\n") }; }
export function buildAnalysisUserPrompt(problem: string): ChatMessage { return { role: "user", content: ["Analyze into IR JSON:", "", problem].join("\n") }; }
export function buildAnalysisMessages(problem: string): ChatMessage[] { return [buildAnalysisSystemPrompt(), buildAnalysisUserPrompt(problem)]; }
export function buildSystemPrompt(): ChatMessage { return { role: "system", content: ["Convert physics problems into DSL JSON.", "", SCHEMA_CONSTRAINTS, "", "Reference:", FREE_FALL_EXAMPLE].join("\n") }; }
export function buildUserPrompt(problem: string): ChatMessage { return { role: "user", content: ["Convert into DSL JSON:", "", problem].join("\n") }; }
export function buildMessages(problem: string): ChatMessage[] { return [buildSystemPrompt(), buildUserPrompt(problem)]; }
export function buildDSLFromIRMessages(problem: string, ir: Record<string, unknown>): ChatMessage[] { return [buildSystemPrompt(), { role: "user", content: ["Convert problem and IR to DSL.", "", "Problem:", problem, "", "IR:", JSON.stringify(ir, null, 2)].join("\n") }]; }
export function buildBoundedRepairMessages(problem: string, ir: Record<string, unknown> | undefined, dsl: Record<string, unknown>, errors: unknown[]): ChatMessage[] {
  return [{ role: "system", content: ["Repair DSL. Fix JSON shape, missing fields, formats, durations. Don't change physical meaning.", "", SCHEMA_CONSTRAINTS].join("\n") }, { role: "user", content: ["Repair:", "", "Problem:", problem, "", "IR:", JSON.stringify(ir ?? {}), "", "Errors:", JSON.stringify(errors, null, 2), "", "DSL:", JSON.stringify(dsl, null, 2)].join("\n") }];
}
