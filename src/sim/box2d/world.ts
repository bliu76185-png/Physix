import type { Box2DModule } from "./bodies";

export interface Box2DWorld {
  Box2D: Box2DModule;
  world: Box2D.b2World;
  bodyById: Map<string, Box2D.b2Body>;
  jointById: Map<string, Box2D.b2Joint | Box2D.b2Joint[]>;
}

/**
 * Create a Box2D world.
 * Gravity is set to zero — all forces (gravity/electric/magnetic/drag)
 * are applied uniformly through the field force pipeline in box2dStream.
 */
export function createBox2DWorld(
  Box2D: Box2DModule
): Box2D.b2World {
  // Disable Box2D's built-in gravity — all forces go through JS field pipeline
  const world = new Box2D.b2World(new Box2D.b2Vec2(0, 0));

  // Configure world settings
  world.SetAllowSleeping(true);
  world.SetWarmStarting(true);
  world.SetContinuousPhysics(true);

  return world;
}

/**
 * Destroy all joints and bodies in the world.
 */
export function destroyBox2DWorld(worldData: Box2DWorld): void {
  const { world, jointById, bodyById } = worldData;

  // Destroy all joints first
  for (const entry of jointById.values()) {
    if (Array.isArray(entry)) {
      for (const joint of entry) {
        world.DestroyJoint(joint);
      }
    } else {
      world.DestroyJoint(entry);
    }
  }
  jointById.clear();

  // Destroy all bodies
  for (const body of bodyById.values()) {
    world.DestroyBody(body);
  }
  bodyById.clear();

  world.__destroy__();
}
