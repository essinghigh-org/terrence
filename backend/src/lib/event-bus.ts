/**
 * In-process event bus for the authenticated SSE stream (10.20).
 * Worker and route code publish typed events; the /api/v2/events route
 * relays them to browser connections. Single-process deployment model,
 * so an in-memory bus is sufficient; a durable outbox would be needed
 * for multi-replica deployments.
 */
type Listener = (payload: Readonly<Record<string, unknown>>) => void;

const topics = new Map<string, Set<Listener>>();

export function subscribe(topic: string, listener: Listener): () => void {
  let listeners = topics.get(topic);
  if (listeners === undefined) {
    listeners = new Set();
    topics.set(topic, listeners);
  }
  listeners.add(listener);
  let disposed = false;
  return (): void => {
    // Idempotent: repeated disposal must never delete a replacement
    // listener set that reuses the same topic key.
    if (disposed) return;
    disposed = true;
    if (topics.get(topic) !== listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) topics.delete(topic);
  };
}

export function publish(topic: string, payload: Readonly<Record<string, unknown>>): void {
  const listeners = topics.get(topic);
  if (listeners === undefined || listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch {
      // A misbehaving listener must never break the publisher.
    }
  }
}
