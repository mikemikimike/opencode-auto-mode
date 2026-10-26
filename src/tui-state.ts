import type { DecisionRecord } from "./state.js";

export function reviewingRecord(records: Record<string, DecisionRecord>, sessionID: string | undefined, now = Date.now()): DecisionRecord | undefined {
  if (!sessionID) return undefined;
  let latest: DecisionRecord | undefined;
  for (const record of Object.values(records)) {
    if (record.sessionID === sessionID && record.decision === "reviewing" &&
      now - record.at >= 0 && now - record.at < 90_000 && (!latest || record.at > latest.at))
      latest = record;
  }
  return latest;
}

export function isReviewing(records: Record<string, DecisionRecord>, sessionID: string | undefined, now = Date.now()): boolean {
  return reviewingRecord(records, sessionID, now) !== undefined;
}
