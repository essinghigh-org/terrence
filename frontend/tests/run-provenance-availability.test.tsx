import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useProvenanceManifest } from "../src/lib/use-run-aux-data";

const originalFetch = globalThis.fetch;

function Probe({ hasProvenance }: Readonly<{ hasProvenance: boolean }>) {
  const result = useProvenanceManifest("run-test", hasProvenance);
  return (
    <div data-testid="result">
      {result.provenanceError === ""
        ? (result.provenanceManifest?.engine.binary ?? "not captured")
        : result.provenanceError}
    </div>
  );
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("does not request provenance or display a 404 for a legacy run without a capsule", () => {
  const fetchMock = mock(async (): Promise<Response> => {
    return Response.json({ errors: [{ title: "Not Found" }] }, { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const view = render(<Probe hasProvenance={false} />);
  expect(view.getByTestId("result").textContent).toBe("not captured");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("fetches and renders provenance when the run advertises a capsule", async () => {
  const fetchMock = mock(async (): Promise<Response> => {
    return Response.json({
      data: {
        attributes: {
          manifest: {
            engine: { binary: "terraform", version: "1.16.5", digest: null },
            configuration: { digest: "example" },
            inputState: {},
            variables: [],
            sandbox: {},
          },
        },
      },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const view = render(<Probe hasProvenance={true} />);
  await waitFor((): void => {
    expect(view.getByTestId("result").textContent).toBe("terraform");
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
