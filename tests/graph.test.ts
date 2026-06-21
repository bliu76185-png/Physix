import { describe, expect, it } from "vitest";
import freeFall from "../examples/free-fall.json";
import springOscillator from "../examples/spring-oscillator.json";
import twoBallPerfectElasticCollision from "../examples/two-ball-perfect-elastic-collision.json";
import { examples } from "../src/examples";
import {
  repairStableConstraintSpec,
  MIN_COMPLIANCE,
  MIN_EVENT_DURATION_SECONDS,
  DEFAULT_CONTACT_ADSORPTION_VELOCITY_THRESHOLD
} from "../src/graph/stableConstraintSpec";
import type { ConstraintInteraction, PhysicsGraph } from "../src/graph/types";
import { materializeGraphVariables } from "../src/graph/variables";
import { validateGraph } from "../src/graph/validateGraph";

describe("validateGraph v3", () => {
  it("accepts all website example graphs", () => {
    for (const example of examples) {
      expect(validateGraph(example.graph).valid, example.id).toBe(true);
    }
  });

  it("rejects object vector objects because v3 schema uses vector arrays", () => {
    const graph = structuredClone(freeFall);
    // @ts-expect-error intentionally corrupting fixture
    graph.initial_state.ball.position = { x: 240, y: 80 };

    const result = validateGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.layer === "schema" && error.path === "initial_state.ball.position")).toBe(true);
  });

  it("requires every object to have explicit initial_state", () => {
    const graph = structuredClone(freeFall);
    // @ts-expect-error intentionally corrupting fixture
    delete graph.initial_state.ball;

    const result = validateGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.layer === "constraint" && error.path === "initial_state.ball")).toBe(true);
  });

  it("reports constraint interactions that reference missing objects", () => {
    const graph = structuredClone(springOscillator) as unknown as PhysicsGraph;
    (graph.interactions[0] as ConstraintInteraction).between[1] = "missing";

    const result = validateGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.layer === "constraint" && error.path === "interactions[0].between[1]")).toBe(true);
  });

  it("reports field interactions that reference missing fields", () => {
    const graph = structuredClone(freeFall);
    graph.interactions[0].field = "missing_field";

    const result = validateGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.layer === "constraint" && error.path === "interactions[0].field")).toBe(true);
  });

  it("rejects hard constraints under the stable constraint spec", () => {
    const graph = structuredClone(springOscillator) as unknown as PhysicsGraph;
    (graph.interactions[0] as ConstraintInteraction).parameters.compliance = 0;
    (graph.interactions[0] as ConstraintInteraction).metadata = {};

    const result = validateGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path === "interactions[0].parameters.compliance")).toBe(true);
    expect(result.errors.some((error) => error.path === "interactions[0].metadata.priority")).toBe(true);
    expect(result.errors.some((error) => error.path === "interactions[0].metadata.lambda_max")).toBe(true);
  });

  it("repairs DSL constraints and instant impulses to the stable spec", () => {
    const graph = structuredClone(springOscillator) as unknown as PhysicsGraph;
    (graph.interactions[0] as ConstraintInteraction).parameters.compliance = 0;
    (graph.interactions[0] as ConstraintInteraction).metadata = {};
    graph.events = [
      {
        id: "kick",
        trigger: "time",
        condition: "t >= 0.5",
        action: {
          type: "control",
          target: "block",
          controls: [{ quantity: "impulse", operation: "add", value: [1, 0], duration: "instant" }]
        }
      }
    ];

    const repaired = repairStableConstraintSpec(graph);
    const constraint = repaired.interactions[0];
    const impulse = repaired.events[0].action.controls![0];

    expect(constraint.type).toBe("constraint");
    if (constraint.type === "constraint") {
      expect(constraint.parameters.compliance).toBeGreaterThanOrEqual(MIN_COMPLIANCE);
      expect(constraint.metadata?.priority).toBe(1);
      expect(constraint.metadata?.lambda_max).toBeGreaterThan(0);
    }
    expect(impulse.duration).toBe(MIN_EVENT_DURATION_SECONDS);
    expect(repaired.events[0].metadata?.impulseSmoothing).toBe("ramp");
    expect(validateGraph(repaired).valid).toBe(true);
  });

  it("requires and repairs contact adsorption for inequality constraints", () => {
    const graph = structuredClone(freeFall) as unknown as PhysicsGraph;
    const contact = graph.interactions.find((interaction): interaction is ConstraintInteraction =>
      interaction.type === "constraint" && interaction.model === "inequality"
    )!;
    contact.metadata = {};

    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith(".metadata.contactAdsorption"))).toBe(true);

    const repaired = repairStableConstraintSpec(graph);
    const repairedContact = repaired.interactions.find((interaction): interaction is ConstraintInteraction =>
      interaction.type === "constraint" && interaction.model === "inequality"
    )!;

    expect(repairedContact.metadata?.contactAdsorption).toEqual({
      enabled: true,
      velocityThreshold: DEFAULT_CONTACT_ADSORPTION_VELOCITY_THRESHOLD
    });
    expect(validateGraph(repaired).valid).toBe(true);
  });

  it("materializes slider variables into bound numeric DSL paths", () => {
    const graph = structuredClone(twoBallPerfectElasticCollision) as unknown as PhysicsGraph;
    graph.variables = [
      {
        id: "restitution",
        label: "Restitution",
        min: 0,
        max: 1,
        step: 0.05,
        default: 1,
        bindings: [
          { path: "objects[id=left_ball].properties.restitution" },
          { path: "objects[id=right_ball].properties.restitution" }
        ]
      },
      {
        id: "initial_speed",
        label: "Initial speed",
        unit: "m/s",
        min: 0,
        max: 4,
        default: 1.6,
        bindings: [{ path: "initial_state.left_ball.velocity[0]" }]
      }
    ];

    const materialized = materializeGraphVariables(graph, { restitution: 0.25, initial_speed: 2.4 });

    expect(materialized.objects.find((object) => object.id === "left_ball")?.properties.restitution).toBe(0.25);
    expect(materialized.objects.find((object) => object.id === "right_ball")?.properties.restitution).toBe(0.25);
    expect(materialized.initial_state.left_ball.velocity[0]).toBe(2.4);
  });

  it("repairs inclined plane and spring semantic components into executable graph shape", () => {
    const graph = structuredClone(freeFall) as unknown as PhysicsGraph;
    graph.objects.push({
      id: "plane",
      label: "Inclined plane",
      type: "rigid_body",
      properties: {},
      degrees_of_freedom: {},
      component: {
        kind: "inclined_plane",
        angle: Math.PI / 6,
        length: 4,
        thickness: 0.2,
        surface: { friction: 0.3 }
      }
    });
    graph.initial_state.plane = { position: [0, -1], velocity: [0, 0] };
    graph.interactions.push({
      id: "spring_link",
      type: "constraint",
      model: "spring",
      between: ["ball", "ground"],
      parameters: { rest_length: 1, stiffness: 50, damping: 1 }
    });

    const repaired = repairStableConstraintSpec(graph);
    const plane = repaired.objects.find((object) => object.id === "plane")!;
    const spring = repaired.interactions.find((interaction): interaction is ConstraintInteraction => interaction.id === "spring_link")!;

    expect(plane.geometry?.type).toBe("polygon");
    expect(plane.metadata?.role).toBe("anchor");
    expect(plane.properties.friction).toBe(0.3);
    expect(spring.parameters.value).toBe(1);
    expect(spring.parameters.compliance).toBeCloseTo(1 / 50);
    expect(validateGraph(repaired).valid).toBe(true);
  });

  it("accepts executable motion profiles targeting existing objects", () => {
    const graph = repairStableConstraintSpec(structuredClone(freeFall) as unknown as PhysicsGraph);
    graph.motion_profiles = [
      {
        id: "drive_ball_vx",
        target: "ball",
        quantity: "velocity",
        axis: "x",
        keyframes: [
          { t: 0, value: 0 },
          { t: 1, value: 2 }
        ]
      }
    ];

    expect(validateGraph(graph).valid).toBe(true);
  });
});
