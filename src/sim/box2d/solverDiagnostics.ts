import type { SolverDiagnostics, ContactDiagnostic, Vector2, SolverEvent } from "../../graph/types";
import type { Box2DModule } from "./bodies";

const MAX_CONTACT_ITERATIONS = 256;

/**
 * Create an empty solver diagnostics object.
 */
export function createEmptySolverDiagnostics(): SolverDiagnostics {
  return {
    contactCount: 0,
    activeConstraintCount: 0,
    maxConstraintError: 0,
    lambdaNorm: 0,
    maxLambdaRatio: 0,
    clampedConstraintCount: 0,
    energyDrift: 0,
    totalNormalImpulse: 0,
    totalFrictionImpulse: 0,
    contacts: [],
    events: []
  };
}

/**
 * Collect solver diagnostics from Box2D contact list.
 */
export function collectBox2DSolverDiagnostics(
  Box2D: Box2DModule,
  world: Box2D.b2World,
  previousContactIds: Set<string>
): SolverDiagnostics {
  const diagnostics = createEmptySolverDiagnostics();

  // Iterate over the contact linked list
  let contact: Box2D.b2Contact | null = world.GetContactList();
  let contactIterations = 0;
  while (contact && contactIterations < MAX_CONTACT_ITERATIONS) {
    contactIterations += 1;
    if (!contact.IsTouching()) {
      contact = getNextContact(contact);
      continue;
    }

    diagnostics.contactCount += 1;
    diagnostics.activeConstraintCount += 1;

    // Extract manifold data
    const manifold = contact.GetManifold();
    const normal = manifold.get_localNormal();
    const normalX = normal.get_x();
    const normalY = normal.get_y();
    const pointCount = manifold.get_pointCount();

    for (let i = 0; i < pointCount; i++) {
      const mp = manifold.get_points(i);
      const normalImpulse = mp.get_normalImpulse();
      const tangentImpulse = mp.get_tangentImpulse();

      diagnostics.totalNormalImpulse += Math.abs(normalImpulse);
      diagnostics.totalFrictionImpulse += Math.abs(tangentImpulse);
    }

    // Get penetration from manifold
    // For circle shapes, penetration is in the manifold type
    const tangent: Vector2 = { x: -normalY, y: normalX };

    // Get bodies from contact
    const fixtureA = contact.GetFixtureA();
    const fixtureB = contact.GetFixtureB();
    const bodyA = fixtureA.GetBody();
    const bodyB = fixtureB.GetBody();

    // Generate contact ID
    const contactId = `contact_${getBodyId(bodyA)}_${getBodyId(bodyB)}`;

    // Contact point from world manifold
    const worldManifold = new Box2D.b2WorldManifold();
    contact.GetWorldManifold(worldManifold);
    const contactPoint: Vector2 = {
      x: worldManifold.get_points(0)?.get_x() ?? 0,
      y: worldManifold.get_points(0)?.get_y() ?? 0
    };

    diagnostics.contacts.push({
      id: contactId,
      bodyA: getBodyId(bodyA),
      bodyB: getBodyId(bodyB),
      point: contactPoint,
      normal: { x: normalX, y: normalY },
      tangent,
      penetration: 0, // Box2D keeps penetration internal
      normalImpulse: pointCount > 0 ? manifold.get_points(0).get_normalImpulse() : 0,
      tangentImpulse: pointCount > 0 ? manifold.get_points(0).get_tangentImpulse() : 0
    });

    // Event: contact created or persisted
    const eventType: SolverEvent["type"] = previousContactIds.has(contactId)
      ? "contact_persisted"
      : "contact_created";
    diagnostics.events.push({
      id: `${eventType}_${contactId}`,
      type: eventType,
      contactId
    });

    worldManifold.__destroy__();
    contact = getNextContact(contact);
  }

  return diagnostics;
}

function getNextContact(contact: Box2D.b2Contact): Box2D.b2Contact | null {
  const next = contact.GetNext();
  if (!next) return null;
  const currentPtr = (contact as unknown as { ptr?: number }).ptr;
  const nextPtr = (next as unknown as { ptr?: number }).ptr;
  return currentPtr != null && currentPtr === nextPtr ? null : next;
}

/**
 * Helper to get body ID. Uses the body object identity.
 * Since Box2D doesn't store user data easily, we use a workaround.
 */
function getBodyId(body: Box2D.b2Body): string {
  // Try to get position as a unique-ish identifier
  const pos = body.GetPosition();
  return `body_${pos.get_x().toFixed(4)}_${pos.get_y().toFixed(4)}`;
}
