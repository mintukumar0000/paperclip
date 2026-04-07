import { getRedisClient } from "../redis/index.js";
import type { EventName, EventPayload, EventHandler, PaperclipEvent } from "./eventTypes.js";
import { eventsPublished } from "../observability/metrics.js";
import pino from "pino";

const logger = pino({ name: "event-bus" });
const CHANNEL_PREFIX = "paperclip:events:";

/** In-process subscribers (same process) */
const localSubscribers = new Map<EventName, Set<EventHandler>>();

/**
 * Core event bus backed by Redis Pub/Sub for cross-process events
 * and in-process handlers for same-process subscriptions.
 */
export const eventBus = {
  /**
   * Publish an event to all subscribers (local + remote via Redis).
   */
  async publish<T extends EventPayload>(name: EventName, payload: T): Promise<void> {
    const event: PaperclipEvent<T> = {
      name,
      payload,
      timestamp: new Date().toISOString(),
      source: process.env.WORKER_ID ?? "api-server",
    };

    logger.info({ event: name, payload }, "Event published");
    eventsPublished.inc({ event_type: name });

    // Fire local subscribers
    const handlers = localSubscribers.get(name);
    if (handlers) {
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (err) {
          logger.error({ event: name, err }, "Local event handler error");
        }
      }
    }

    // Publish to Redis for cross-process subscribers
    try {
      const redis = getRedisClient();
      await redis.publish(CHANNEL_PREFIX + name, JSON.stringify(event));
    } catch (err) {
      logger.error({ event: name, err }, "Redis publish error");
    }
  },

  /**
   * Subscribe to events in the current process.
   */
  subscribe<T extends EventPayload>(name: EventName, handler: EventHandler<T>): () => void {
    if (!localSubscribers.has(name)) {
      localSubscribers.set(name, new Set());
    }
    localSubscribers.get(name)!.add(handler as EventHandler);

    logger.info({ event: name }, "Local subscriber registered");

    // Return unsubscribe function
    return () => {
      localSubscribers.get(name)?.delete(handler as EventHandler);
    };
  },

  /**
   * Subscribe to Redis events cross-process.
   * Creates a dedicated subscriber connection.
   */
  async subscribeRemote(names: EventName[], handler: EventHandler): Promise<() => void> {
    const { createRedisConnection } = await import("../redis/index.js");
    const sub = createRedisConnection();
    const channels = names.map((n) => CHANNEL_PREFIX + n);

    await sub.subscribe(...channels);

    sub.on("message", (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as PaperclipEvent;
        const result = handler(event);
        if (result && typeof (result as any).catch === "function") {
          (result as Promise<void>).catch((err: unknown) =>
            logger.error({ event: event.name, err }, "Remote handler error"),
          );
        }
      } catch (err) {
        logger.error({ err }, "Event parse error");
      }
    });

    logger.info({ events: names }, "Remote subscriber registered");

    return async () => {
      await sub.unsubscribe(...channels);
      await sub.quit();
    };
  },
};
