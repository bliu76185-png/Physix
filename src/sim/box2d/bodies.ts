import type { CompiledGraph } from "../compiler";
import type { PhysicsObject, DSLVector } from "../../graph/types";
import { getInitialPosition, getInitialVelocity, getMass, isFixed } from "../forceBackend";
import { fromDSLVector, zero } from "../vector";

/**
 * Create Box2D bodies for all objects in the compiled graph.
 * Returns a map from object ID to b2Body.
 */
export function createBox2DBodies(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  compiled: CompiledGraph
): Map<string, Box2D.b2Body> {
  const bodyById = new Map<string, Box2D.b2Body>();

  for (const object of compiled.graph.objects) {
    const body = createBody(Box2D, world, object, compiled.graph.initial_state);
    bodyById.set(object.id, body);
  }

  return bodyById;
}

function createBody(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  object: PhysicsObject,
  initialState: Record<string, { position?: unknown; velocity?: unknown; rotation?: number; angular_velocity?: number }>
): Box2D.b2Body {
  const position = getInitialPosition(object, initialState);
  const velocity = getInitialVelocity(object, initialState);
  const fixed = isFixed(object);
  const initialAngle = initialState[object.id]?.rotation ?? 0;

  const bodyDef = new Box2D.b2BodyDef();
  bodyDef.set_type(fixed ? Box2D.b2_staticBody : Box2D.b2_dynamicBody);
  bodyDef.get_position().Set(position.x, position.y);
  bodyDef.set_angle(initialAngle);

  if (!fixed) {
    const vel = velocity;
    bodyDef.get_linearVelocity().Set(vel.x, vel.y);
    bodyDef.set_angularVelocity(
      initialState[object.id]?.angular_velocity ?? 0
    );
    // Box2D built-in damping
    bodyDef.set_linearDamping(object.properties.linear_damping ?? 0);
    bodyDef.set_angularDamping(object.properties.angular_damping ?? 0);
    // Allow sleep for better performance
    bodyDef.set_allowSleep(true);
    bodyDef.set_awake(true);
  }

  // Fixed rotation for particles (no rotation DOF)
  if (object.degrees_of_freedom?.rotation === false) {
    bodyDef.set_fixedRotation(true);
  }

  const body = world.CreateBody(bodyDef);
  bodyDef.__destroy__();

  // Create fixture with shape
  createFixture(Box2D, body, object);

  if (!fixed) {
    // Set mass explicitly (Box2D computes from fixture density by default)
    const mass = getMass(object);
    if (Number.isFinite(mass) && mass > 0) {
      const massData = new Box2D.b2MassData();
      body.GetMassData(massData);
      massData.set_mass(mass);
      body.SetMassData(massData);
      massData.__destroy__();
    }
  }

  return body;
}

function createFixture(
  Box2D: Box2DModule,
  body: Box2D.b2Body,
  object: PhysicsObject
): void {
  const geometry = object.geometry;
  if (!geometry) {
    // Default: small circle
    const shape = new Box2D.b2CircleShape();
    shape.set_m_radius(object.properties.radius ?? 0.25);
    createFixtureFromShape(Box2D, body, shape, object);
    return;
  }

  if (geometry.type === "circle") {
    const shape = new Box2D.b2CircleShape();
    shape.set_m_radius(geometry.radius);
    createFixtureFromShape(Box2D, body, shape, object);
  } else if (geometry.type === "box") {
    const shape = new Box2D.b2PolygonShape();
    const hw = geometry.size[0] / 2;
    const hh = geometry.size[1] / 2;
    shape.SetAsBox(hw, hh);
    createFixtureFromShape(Box2D, body, shape, object);
  } else if (geometry.type === "polygon") {
    const [vertices, destroy] = Box2D.tuplesToVec2Array(
      geometry.points.map(p => [p[0], p[1]] as [number, number])
    );
    const shape = new Box2D.b2PolygonShape();
    shape.Set(vertices, geometry.points.length);
    createFixtureFromShape(Box2D, body, shape, object);
    shape.__destroy__();
    destroy();
  }
}

function createFixtureFromShape(
  Box2D: Box2DModule,
  body: Box2D.b2Body,
  shape: Box2D.b2Shape,
  object: PhysicsObject
): void {
  const props = object.properties;
  const fixtureDef = new Box2D.b2FixtureDef();
  fixtureDef.set_shape(shape);
  fixtureDef.set_density(props.mass != null ? 1.0 : 0.001);
  fixtureDef.set_friction(props.friction ?? props.dynamic_friction ?? 0.3);
  fixtureDef.set_restitution(props.restitution ?? 0.3);

  body.CreateFixture(fixtureDef);
  fixtureDef.__destroy__();
}

/** Type for the Box2D module after factory() */
export type Box2DModule = typeof Box2D;
