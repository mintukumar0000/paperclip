import { eventBus } from "./eventBus.js";
import type { EventName, EventHandler, EventPayload } from "./eventTypes.js";

/**
 * Convenience wrapper for subscribing to events.
 */
export const eventSubscriber = {
  on<T extends EventPayload>(name: EventName, handler: EventHandler<T>): () => void {
    return eventBus.subscribe(name, handler);
  },

  /** Subscribe across worker processes via Redis */
  async onRemote(names: EventName[], handler: EventHandler): Promise<() => void> {
    return eventBus.subscribeRemote(names, handler);
  },
};
