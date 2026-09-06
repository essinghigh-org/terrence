import { expect, test } from "bun:test";
import { buildExplainSource, forEachUpstreamDelta, parseCompletionBody, splitInlineThinking } from "../../src/lib/run-explanations";

test("removes inline think tags from the returned explanation", () => {
  const parts = parseCompletionBody({
    choices: [{ message: { reasoning_content: "separate reasoning", content: "<think>private reasoning</think>Brief answer.<reasoning>more reasoning</reasoning>" } }],
  });

  expect(parts.content).toBe("Brief answer.");
  expect(parts.thinking).toBe("separate reasoning\nprivate reasoningmore reasoning");
  expect(splitInlineThinking("<think>unfinished reasoning")).toEqual({
    content: "",
    thinking: "unfinished reasoning",
  });
});

test("keeps inline thinking out of streamed content across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    `<think`,
    `>private reasoning</think>Brief answer.`,
  ].map((content) => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const events: Readonly<{ channel: "thinking" | "content"; text: string }>[] = [];
  await forEachUpstreamDelta(new Response(stream), (channel, text): void => {
    events.push({ channel, text });
  });

  expect(events.filter(({ channel }) => channel === "thinking").map(({ text }) => text).join(""))
    .toBe("private reasoning");
  expect(events.filter(({ channel }) => channel === "content").map(({ text }) => text).join(""))
    .toBe("Brief answer.");
  expect(events.some(({ channel, text }) => channel === "content" && text.includes("<think"))).toBeFalse();
});


test("plan explanation prompts use the public projection", async () => {
  const { writePlanJsonArtifact, deletePlanJsonArtifact } = await import("../../src/lib/plan-json");
  const runId = `explain-${crypto.randomUUID()}`;
  try {
    await writePlanJsonArtifact(runId, { variables: { password: { value: "REVIEW_SYNTHETIC_SECRET" } }, resource_changes: [{ address: "test.example", change: { actions: ["create"], after: "REVIEW_SYNTHETIC_SECRET", after_sensitive: true } }] });
    const source = await buildExplainSource(runId, "plan");
    expect(source?.prompt).toContain("test.example");
    expect(source?.prompt).not.toContain("REVIEW_SYNTHETIC_SECRET");
  } finally {
    await deletePlanJsonArtifact(runId);
  }
});
