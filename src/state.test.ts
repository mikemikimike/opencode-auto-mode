import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearConfigError, readConfigError, recordConfigError } from "./state.js";

const first = `/tmp/auto-mode-config-a-${process.pid}`;
const second = `/tmp/auto-mode-config-b-${process.pid}`;

describe("config error badge state", () => {
  it("keeps per-location errors and clears only the matching location", () => {
    clearConfigError(first);
    clearConfigError(second);
    recordConfigError(first, "Invalid auto-mode configuration");
    recordConfigError(second, "Invalid auto-mode configuration");
    assert.equal(readConfigError(first)?.message, "Invalid auto-mode configuration");
    assert.equal(readConfigError(second)?.message, "Invalid auto-mode configuration");
    clearConfigError(first);
    assert.equal(readConfigError(first), undefined);
    assert.equal(readConfigError(second)?.message, "Invalid auto-mode configuration");
    clearConfigError(second);
    assert.equal(readConfigError(second), undefined);
    assert.equal(readConfigError(undefined), undefined);
  });
});
