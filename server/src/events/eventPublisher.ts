import { eventBus } from "./eventBus.js";
import type { EventName, EventPayload } from "./eventTypes.js";

/**
 * Convenience wrapper for publishing events.
 * Import this in services to emit events without coupling to eventBus internals.
 */
export const eventPublisher = {
  async publish<T extends EventPayload>(name: EventName, payload: T): Promise<void> {
    return eventBus.publish(name, payload);
  },
};

/** Standalone function for convenience */
export async function publishEvent<T extends EventPayload>(name: EventName, payload: T): Promise<void> {
  return eventBus.publish(name, payload);
}
