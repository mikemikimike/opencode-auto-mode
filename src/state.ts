import * as fs from "node:fs";
import * as path from "node:path";
import { privateFile, STORAGE_DIR } from "./storage.js";

export type DecisionKind = "reviewing" | "allow" | "deny" | "ask";

export interface DecisionRecord {
  requestID: string;
  sessionID: string;
  decision: DecisionKind;
  reason: string;
  at: number;
  action?: string;
  resources?: string[];
}

export const STATE_FILE = path.join(STORAGE_DIR, "state.json");

const CONFIG_ERROR_FILE = "config-error.json";
const MAX_CONFIG_ERRORS = 32;
const MAX_AGE_MS = 10 * 60 * 1000;

export interface ConfigErrorRecord {
  directory: string;
  message: string;
}

interface ConfigErrorEntry {
  message: string;
  at: number;
}

function canonicalDirectory(directory: string): string {
  try { return fs.realpathSync.native(directory); }
  catch { return path.resolve(directory); }
}

function readConfigErrors(): Record<string, ConfigErrorEntry> {
  let fd: number | undefined;
  try {
    fd = privateFile(CONFIG_ERROR_FILE, false);
    if (fs.fstatSync(fd).size > 65_536) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([directory, entry]) =>
      directory.length > 0 && directory.length <= 4096 && typeof entry === "object" && entry !== null &&
      typeof (entry as ConfigErrorEntry).message === "string" && (entry as ConfigErrorEntry).message.length <= 1024 &&
      typeof (entry as ConfigErrorEntry).at === "number" && Number.isFinite((entry as ConfigErrorEntry).at)));
  } catch {
    return {};
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeConfigErrors(all: Record<string, ConfigErrorEntry>): void {
  let fd: number | undefined;
  try {
    const data = JSON.stringify(all);
    if (Buffer.byteLength(data) > 65_536) return;
    fd = privateFile(CONFIG_ERROR_FILE, true);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, data, 0);
  } catch {
    // Badge state is best effort and must not interrupt permission review.
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Records that the plugin options for a location are unusable, so the TUI can show it. */
export function recordConfigError(directory: string, message: string): void {
  const all = readConfigErrors();
  all[canonicalDirectory(directory)] = { message: message.slice(0, 1024), at: Date.now() };
  const recent = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CONFIG_ERRORS);
  writeConfigErrors(Object.fromEntries(recent));
}

export function readConfigError(directory: string | undefined): ConfigErrorRecord | undefined {
  if (directory === undefined) return undefined;
  const key = canonicalDirectory(directory);
  const entry = readConfigErrors()[key];
  return entry === undefined ? undefined : { directory: key, message: entry.message };
}

export function clearConfigError(directory: string): void {
  const all = readConfigErrors();
  const key = canonicalDirectory(directory);
  if (all[key] === undefined) return;
  delete all[key];
  if (Object.keys(all).length === 0) {
    try { fs.rmSync(path.join(STORAGE_DIR, CONFIG_ERROR_FILE), { force: true }); }
    catch { /* best effort */ }
    return;
  }
  writeConfigErrors(all);
}

export function readDecisions(): Record<string, DecisionRecord> {
  let fd: number | undefined;
  try {
    fd = privateFile("state.json", false);
    if (fs.fstatSync(fd).size > 65_536) return {};
    const raw = fs.readFileSync(fd, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, value]) =>
      id.length < 256 && typeof value === "object" && value !== null &&
      value.requestID === id && typeof value.sessionID === "string" && value.sessionID.length < 256 &&
      typeof value.reason === "string" && value.reason.length <= 4096 &&
      typeof value.at === "number" && Number.isFinite(value.at) &&
      (value.action === undefined || typeof value.action === "string") &&
      (value.resources === undefined || (Array.isArray(value.resources) && value.resources.length <= 256 &&
        value.resources.every((resource: unknown) => typeof resource === "string"))) &&
      ["reviewing", "allow", "deny", "ask"].includes(value.decision))) as Record<string, DecisionRecord>;
  } catch {
    return {};
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function recordDecision(record: DecisionRecord): void {
  const all = readDecisions();
  Object.defineProperty(all, record.requestID, { value: record, enumerable: true, configurable: true });
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, rec] of Object.entries(all)) {
    if (rec.at < cutoff || Object.keys(all).length > 128) delete all[id];
  }
  let fd: number | undefined;
  try {
    const data = JSON.stringify(all);
    if (Buffer.byteLength(data) > 65_536) return;
    fd = privateFile("state.json", true);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, data, 0);
  } catch {
    // Badge state is best effort and must not interrupt permission review.
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
