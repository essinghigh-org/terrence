import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { EventProvider, useTerrenceEvent, type EventStreamFactory } from "../src/lib/event-provider";
import type { JsonObject } from "../src/lib/json";

/** Controllable SSE stream: records opens/closes and emits on demand. */
function createFakeStream(): {
  factory: EventStreamFactory;
  emit: (name: string, data: Readonly<JsonObject>) => void;
  closeCount: () => number;
} {
  const listeners = new Set<(event: { name: string; data: Readonly<JsonObject> }) => void>();
  let closed = 0;
  return {
    factory: (onEvent): { close: () => void } => {
      listeners.add(onEvent);
      return {
        close: (): void => {
          closed += 1;
          listeners.delete(onEvent);
        },
      };
    },
    emit: (name, data): void => {
      for (const listener of [...listeners]) listener({ name, data });
    },
    closeCount: (): number => closed,
  };
}

function Probe({ eventName, matchId }: Readonly<{ eventName: string; matchId: string }>): React.JSX.Element {
  const [hits, setHits] = useState(0);
  useTerrenceEvent(eventName, (data): boolean => data["run-id"] === matchId, (): void => {
    setHits((value): number => value + 1);
  });
  return <span data-testid={`probe-${eventName}-${matchId}`}>{hits}</span>;
}

afterEach((): void => {
  cleanup();
});

test("opens one stream and fans events out only to matching subscribers", async () => {
  let openCount = 0;
  const stream = createFakeStream();
  const factory: EventStreamFactory = (onEvent) => {
    openCount += 1;
    return stream.factory(onEvent);
  };

  const view = render(
    <EventProvider streamFactory={factory}>
      <Probe eventName="run.status" matchId="run-a" />
      <Probe eventName="run.status" matchId="run-b" />
      <Probe eventName="comment.created" matchId="run-a" />
    </EventProvider>,
  );
  await waitFor((): void => {
    expect(openCount).toBe(1);
  });

  act((): void => {
    stream.emit("run.status", { "run-id": "run-a" });
  });
  expect(view.getByTestId("probe-run.status-run-a").textContent).toBe("1");
  expect(view.getByTestId("probe-run.status-run-b").textContent).toBe("0");
  expect(view.getByTestId("probe-comment.created-run-a").textContent).toBe("0");

  act((): void => {
    stream.emit("run.status", { "run-id": "run-b" });
  });
  act((): void => {
    stream.emit("comment.created", { "run-id": "run-a" });
  });
  expect(view.getByTestId("probe-run.status-run-a").textContent).toBe("1");
  expect(view.getByTestId("probe-run.status-run-b").textContent).toBe("1");
  expect(view.getByTestId("probe-comment.created-run-a").textContent).toBe("1");

  // A single provider means a single connection regardless of subscriber count.
  expect(openCount).toBe(1);
});

test("closes the stream when the provider unmounts", async () => {
  const stream = createFakeStream();
  const view = render(
    <EventProvider streamFactory={stream.factory}>
      <Probe eventName="run.status" matchId="run-a" />
    </EventProvider>,
  );
  view.unmount();
  expect(stream.closeCount()).toBe(1);
});

test("useTerrenceEvent without a provider is a safe no-op", async () => {
  const stream = createFakeStream();
  const factory = mock(stream.factory);
  const view = render(<Probe eventName="run.status" matchId="run-a" />);
  await waitFor((): void => {
    expect(view.getByTestId("probe-run.status-run-a").textContent).toBe("0");
  });
  // No stream was ever attempted.
  expect(factory).not.toHaveBeenCalled();
});
