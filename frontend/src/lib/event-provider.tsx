import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { subscribeEvents, type EventStreamHandle, type SseEvent } from "./events";
import type { JsonObject } from "@/lib/json";

type EventListener = (event: SseEvent) => void;

export type EventStreamFactory = (onEvent: (event: SseEvent) => void) => EventStreamHandle;

type EventContextValue = Readonly<{
  /** Register a listener for the lifetime of the owning effect. */
  subscribe: (listener: EventListener) => () => void;
}>;

const EventContext = createContext<EventContextValue | null>(null);

/**
 * App-global SSE connection (one stream per browser session). Every view
 * subscribes through useTerrenceEvent instead of opening its own stream, so
 * the backend connection caps (5/user, 50 total) are never a constraint and
 * reconnects fan out to all listeners at once.
 *
 * The stream is opened once on mount and closed on unmount; subscribeEvents
 * reconnects with exponential backoff after drops and treats auth failures
 * as terminal (a fresh session remounts the provider).
 */
export function EventProvider({
  children,
  streamFactory = subscribeEvents,
}: Readonly<{
  children: ReactNode;
  /** Test seam: replace the real stream with a controllable emitter. */
  streamFactory?: EventStreamFactory;
}>): React.JSX.Element {
  const listenersRef = useRef<Set<EventListener>>(new Set());

  useEffect((): (() => void) => {
    const handle = streamFactory((event: SseEvent): void => {
      // Isolate listener failures: one broken subscriber must never stop
      // the fan-out to the others or break the stream loop.
      for (const listener of [...listenersRef.current]) {
        try {
          listener(event);
        } catch {
          // Swallow per-listener errors; a misbehaving view is not fatal.
        }
      }
    });
    return (): void => {
      handle.close();
    };
  }, [streamFactory]);

  const contextValue = useMemo<EventContextValue>((): EventContextValue => ({
    subscribe: (listener: EventListener): (() => void) => {
      listenersRef.current.add(listener);
      return (): void => {
        listenersRef.current.delete(listener);
      };
    },
  }), []);

  return <EventContext.Provider value={contextValue}>{children}</EventContext.Provider>;
}

/**
 * Subscribe to a named SSE event while the component is mounted. `matches`
 * filters the payload (e.g. by run-id); `handler` runs on match. Without an
 * EventProvider ancestor this is a no-op, so views degrade to their own
 * timers in tests and embedded renderings.
 */
export function useTerrenceEvent(
  eventName: string,
  matches: (data: Readonly<JsonObject>) => boolean,
  handler: (data: Readonly<JsonObject>) => void,
): void {
  const context = useContext(EventContext);
  // Refs keep the latest predicate/handler without re-registering on every
  // render; the subscription itself only tracks the event name.
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect((): (() => void) => {
    if (context === null) return () => {};
    return context.subscribe((event: SseEvent): void => {
      if (event.name !== eventName) return;
      const data = event.data as Readonly<JsonObject>;
      if (!matchesRef.current(data)) return;
      handlerRef.current(data);
    });
  }, [context, eventName]);
}
