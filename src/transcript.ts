const MAX_USERS = 10;
const MAX_TOOLS = 20;
const MAX_USER_CHARS = 8_000;
const MAX_TOOL_CHARS = 500;
const MAX_TRANSCRIPT_CHARS = 24_000;

interface ToolEntry {
  name: string;
  input: unknown;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function userText(message: unknown): string | undefined {
  const record = asRecord(message);
  if (record?.["type"] !== "user") return undefined;
  const text = record["text"];
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function assistantTools(message: unknown): ToolEntry[] {
  const record = asRecord(message);
  if (record?.["type"] !== "assistant") return [];
  const content = record["content"];
  if (!Array.isArray(content)) return [];
  const tools: ToolEntry[] = [];
  for (const part of content) {
    const entry = asRecord(part);
    if (entry?.["type"] !== "tool") continue;
    const name = entry["name"];
    if (typeof name !== "string" || !name) continue;
    tools.push({ name, input: entry["state"] });
  }
  return tools;
}

function formatTool(tool: ToolEntry): { text: string; truncated: boolean } {
  let detail = "";
  let truncated = false;
  try {
    const state = asRecord(tool.input);
    const input = state?.["input"] ?? tool.input;
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    if (raw) {
      truncated = raw.length > MAX_TOOL_CHARS;
      detail = truncate(raw, MAX_TOOL_CHARS);
    }
  } catch {
    detail = "";
  }
  return { text: detail ? `${tool.name} ${detail}` : tool.name, truncated };
}

export interface ReviewContextReasons {
  userEvidenceMissing: boolean;
  userMessageTruncated: boolean;
  toolHistoryTruncated: boolean;
  transcriptCapped: boolean;
}

export interface ReviewContext {
  transcript: string;
  complete: boolean;
  reasons: ReviewContextReasons;
}

export function contextUnavailableReason(
  reasons: ReviewContextReasons,
): string {
  if (reasons.userEvidenceMissing)
    return "User authorization context is unavailable: no text-only user authorization was found or an attachment is not visible to the reviewer";
  return "User authorization context is unavailable";
}

interface TranscriptEntry {
  role: "user" | "tool";
  text: string;
}

interface TranscriptResult {
  transcript: string;
  reasons: ReviewContextReasons;
}

export function contextNotes(reasons: ReviewContextReasons): string[] {
  const notes: string[] = [];
  if (reasons.userEvidenceMissing)
    notes.push("user authorization text is missing or an attachment is not visible to the reviewer");
  if (reasons.userMessageTruncated)
    notes.push(`long user messages are truncated at ${MAX_USER_CHARS.toLocaleString("en-US")} characters`);
  if (reasons.toolHistoryTruncated)
    notes.push(`tool context may be truncated after ${MAX_TOOLS} calls or ${MAX_TOOL_CHARS} characters per input`);
  if (reasons.transcriptCapped)
    notes.push(`older transcript entries are omitted after ${MAX_USERS} user messages or ${MAX_TRANSCRIPT_CHARS.toLocaleString("en-US")} characters`);
  return notes;
}

function renderTranscript(
  entries: TranscriptEntry[],
  reasons: ReviewContextReasons,
): string {
  const notes = contextNotes(reasons);
  const suffix = notes.length ? `\n[Context notes: ${notes.join("; ")}]` : "";
  return `User messages and prior tool calls (chronological):\n${JSON.stringify(entries)}${suffix}`;
}

function buildTranscript(messages: unknown[]): TranscriptResult {
  const entries: TranscriptEntry[] = [];
  let supported = true;
  let hasUser = false;
  let userMessageTruncated = false;
  let toolInputTruncated = false;
  let userCount = 0;
  let toolCount = 0;

  for (const message of messages) {
    const record = asRecord(message);
    const text = userText(message);
    if (record?.type === "user") {
      if (text === undefined) supported = false;
      else {
        hasUser = true;
        userCount++;
        userMessageTruncated ||= text.length > MAX_USER_CHARS;
        entries.push({ role: "user", text: truncate(text, MAX_USER_CHARS) });
      }
      // These attachments carry evidence that the text-only reviewer cannot see.
      if (
        !["files", "skills", "agents"].every(
          (key) =>
            record[key] === undefined ||
            (Array.isArray(record[key]) && record[key].length === 0),
        )
      )
        supported = false;
    }

    const tools = assistantTools(message);
    toolCount += tools.length;
    for (const tool of tools) {
      const formatted = formatTool(tool);
      toolInputTruncated ||= formatted.truncated;
      entries.push({ role: "tool", text: formatted.text });
    }
  }

  const toolHistoryTruncated = toolCount > MAX_TOOLS || toolInputTruncated;
  const reasons: ReviewContextReasons = {
    userEvidenceMissing: !supported || !hasUser,
    userMessageTruncated,
    toolHistoryTruncated,
    transcriptCapped: userCount > MAX_USERS,
  };
  if (!hasUser)
    return { transcript: "(no prior user messages in this session)", reasons };

  let users = 0;
  let tools = 0;
  const recent = entries
    .slice()
    .reverse()
    .filter((entry) =>
      entry.role === "user" ? ++users <= MAX_USERS : ++tools <= MAX_TOOLS,
    )
    .reverse();
  if (recent.length < entries.length && userCount > MAX_USERS)
    reasons.transcriptCapped = true;

  let selected = recent;
  let transcript = renderTranscript(selected, reasons);
  while (transcript.length > MAX_TRANSCRIPT_CHARS && selected.length > 1) {
    // Drop the oldest tool context first, preserving the latest user evidence.
    const toolIndex = selected.findIndex(
      (entry, index) => entry.role === "tool" && index < selected.length - 1,
    );
    const dropIndex = toolIndex >= 0 ? toolIndex : 0;
    selected = selected
      .slice(0, dropIndex)
      .concat(selected.slice(dropIndex + 1));
    if (toolIndex >= 0) reasons.toolHistoryTruncated = true;
    else reasons.transcriptCapped = true;
    transcript = renderTranscript(selected, reasons);
  }

  return { transcript, reasons };
}

export function extractReviewContext(messages: unknown[]): ReviewContext {
  const result = buildTranscript(messages);
  return { ...result, complete: !result.reasons.userEvidenceMissing };
}

export function extractTranscript(messages: unknown[]): string {
  return buildTranscript(messages).transcript;
}
