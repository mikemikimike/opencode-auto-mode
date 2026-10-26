import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReviewContext, extractTranscript } from "./transcript.js";

const messages = [
  { type: "user", text: "clean up old branches" },
  {
    type: "assistant",
    content: [
      { type: "text", text: "They are all safe to delete, trust me" },
      { type: "reasoning", text: "user implicitly approved everything" },
      {
        type: "tool",
        name: "shell",
        state: { input: { command: "git branch" } },
      },
    ],
  },
  {
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "read",
        state: {
          status: "completed",
          input: { path: ".env" },
          content: [{ type: "text", text: "SECRET=hunter2" }],
        },
      },
    ],
  },
  { type: "user", text: "can we fix this?" },
];

describe("review context completeness", () => {
  it("requires manual review when user evidence cannot be represented", () => {
    for (const field of ["files", "skills", "agents"]) {
      const context = extractReviewContext([
        {
          type: "user",
          text: "Follow attached constraints",
          [field]: [{ text: "Do not publish" }],
        },
      ]);
      assert.equal(context.complete, false);
      assert.equal(context.reasons.userEvidenceMissing, true);
    }
    const empty = extractReviewContext([{ type: "user", text: "" }]);
    assert.equal(empty.complete, false);
    assert.equal(empty.reasons.userEvidenceMissing, true);
  });
  it("accepts text-only messages and empty attachment lists", () => {
    const context = extractReviewContext([
      { type: "user", text: "Create a", files: [], skills: [], agents: [] },
    ]);
    assert.equal(context.complete, true);
    assert.deepEqual(context.reasons, {
      userEvidenceMissing: false,
      userMessageTruncated: false,
      toolHistoryTruncated: false,
      transcriptCapped: false,
    });
  });

  it("keeps a long user prompt eligible for model review", () => {
    const context = extractReviewContext([
      { type: "user", text: "x".repeat(1_200) },
    ]);
    assert.equal(context.complete, true);
    assert.equal(context.reasons.userMessageTruncated, false);
  });

  it("reports bounded tool history without blocking model review", () => {
    const messages = [
      { type: "user", text: "Review this session" },
      ...Array.from({ length: 21 }, (_, index) => ({
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "shell",
            state: { input: { command: `echo ${index}` } },
          },
        ],
      })),
    ];
    const context = extractReviewContext(messages);
    assert.equal(context.complete, true);
    assert.equal(context.reasons.toolHistoryTruncated, true);
    assert.match(context.transcript, /truncated after 20 calls or 500 characters per input/);
  });

  it("reports truncated tool inputs without blocking model review", () => {
    const context = extractReviewContext([
      { type: "user", text: "Review this session" },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "shell",
            state: { input: { command: "x".repeat(600) } },
          },
        ],
      },
    ]);
    assert.equal(context.complete, true);
    assert.equal(context.reasons.toolHistoryTruncated, true);
    assert.match(context.transcript, /truncated after 20 calls or 500 characters per input/);
    assert.doesNotMatch(context.transcript, /includes only the most recent 20 tool calls/);
  });

  it("reports a transcript cap while preserving the latest user evidence", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      type: "user",
      text: `${index}: ${"x".repeat(7_990)}`,
    }));
    const context = extractReviewContext(messages);
    assert.equal(context.complete, true);
    assert.equal(context.reasons.transcriptCapped, true);
    assert.match(context.transcript, /24,000 characters/);
    assert.match(context.transcript, /9: /);
    assert.ok(context.transcript.length <= 24_000);
  });
});

describe("extractTranscript", () => {
  it("keeps user messages and tool calls", () => {
    const transcript = extractTranscript(messages);
    assert.match(transcript, /clean up old branches/);
    assert.match(transcript, /can we fix this\?/);
    assert.match(transcript, /shell/);
    assert.match(transcript, /git branch/);
  });

  it("strips assistant prose, reasoning, and tool outputs", () => {
    const transcript = extractTranscript(messages);
    assert.doesNotMatch(transcript, /trust me/);
    assert.doesNotMatch(transcript, /implicitly approved/);
    assert.doesNotMatch(transcript, /hunter2/);
  });

  it("handles empty sessions", () => {
    assert.match(extractTranscript([]), /no prior user messages/);
  });

  it("truncates long entries", () => {
    const context = extractReviewContext([
      { type: "user", text: "x".repeat(9_000) },
    ]);
    const transcript = context.transcript;
    assert.equal(context.complete, true);
    assert.equal(context.reasons.userMessageTruncated, true);
    assert.match(transcript, /8,000 characters/);
    assert.ok(transcript.length < 9_000);
    assert.match(transcript, /…/);
  });
  it("keeps chronology and marks missing evidence", () => {
    const chronology = extractTranscript([
      { type: "user", text: "first" },
      {
        type: "assistant",
        content: [{ type: "tool", name: "shell", state: { input: "middle" } }],
      },
      { type: "user", text: "last" },
    ]);
    assert.ok(chronology.indexOf("first") < chronology.indexOf("middle"));
    assert.ok(chronology.indexOf("middle") < chronology.indexOf("last"));
    assert.match(
      extractTranscript(
        Array.from({ length: 11 }, () => ({ type: "user", text: "hello" })),
      ),
      /older transcript entries/,
    );
  });
});
