import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compositeDecision } from "./classifier.js";
import { parseOptions, stagesFor, type ClassifierStage } from "./config.js";

const request = { action: "shell", resources: ["touch a", "touch b"] };
const unused = async () => { throw new Error("unexpected reviewer call"); };

describe("composite classifiers", () => {
  it("requires coverage of every resource", async () => {
    const stages: ClassifierStage[] = [{ type: "rules", rules: [{ expression: 'action == "shell" && resource == "touch a"', decision: "allow" }] }];
    assert.equal((await compositeDecision(stages, request, unused)).decision, "ask");
    stages[0] = { type: "rules", rules: [{ expression: 'action == "shell" && resource.startsWith("touch ")', decision: "allow" }] };
    assert.equal((await compositeDecision(stages, request, unused)).decision, "allow");
  });
  it("applies all user denies before asks or static allows", async () => {
    const stages: ClassifierStage[] = [
      { type: "static" },
      { type: "rules", rules: [{ expression: 'action == "shell"', decision: "ask" }] },
      { type: "rules", rules: [{ expression: 'action == "shell" && resource == "pwd"', decision: "deny" }] },
    ];
    assert.equal((await compositeDecision(stages, { action: "shell", resources: ["pwd"] }, unused)).decision, "deny");
    assert.equal((await compositeDecision(stages, { action: "shell", resources: ["sudo rm -rf /"] }, unused)).decision, "deny");
    assert.equal((await compositeDecision(stages, { action: "shell", resources: [] }, unused)).decision, "ask");
    stages.push({ type: "rules", rules: [{ expression: 'action == "shell"', decision: "deny" }] });
    assert.equal((await compositeDecision(stages, { action: "shell", resources: [] }, unused)).decision, "deny");
  });
  it("falls through on abstention and stops on terminal outcomes", async () => {
    const stages: ClassifierStage[] = [{ type: "jev" }, { type: "llm" }];
    const seen: string[] = [];
    const result = await compositeDecision(stages, request, async (stage) => {
      seen.push(stage.type);
      return stage.type === "jev" ? { decision: "abstain", reason: "no confident answer" } : { decision: "allow", reason: "authorized" };
    });
    assert.equal(result.decision, "allow");
    assert.deepEqual(seen, ["jev", "llm"]);
    for (const decision of ["allow", "deny", "ask"] as const) {
      seen.length = 0;
      const terminal = await compositeDecision(stages, request, async (stage) => {
        seen.push(stage.type);
        return { decision, reason: "terminal" };
      });
      assert.equal(terminal.decision, decision);
      assert.deepEqual(seen, ["jev"]);
    }
  });
  it("asks when every stage abstains", async () => {
    const stages: ClassifierStage[] = [{ type: "jev" }, { type: "llm" }];
    const result = await compositeDecision(stages, request, async () => ({ decision: "abstain", reason: "no answer" }));
    assert.equal(result.decision, "ask");
    assert.equal(result.stage, "none");
    assert.match(result.reason, /no answer/);
  });
  it("rejects malformed config and unsafe local endpoints", () => {
    for (const value of [null, { classifer: {} }, { classifier: { stages: [] } },
      { classifier: { stages: [{ type: "llm", model: { id: "x" } }] } },
      { classifier: { stages: [{ type: "jev", minConfidence: NaN }] } },
      { classifier: { stages: [{ type: "laya", endpoint: "http://example.com/v1/systemone" }] } },
      { classifier: { stages: [{ type: "laya", endpoint: "http://127.0.0.1/v1/systemone?x=y" }] } },
      { classifier: { stages: [{ type: "static", allowInProjectEdits: "true" }] } }])
      assert.throws(() => parseOptions(value));
    assert.deepEqual(stagesFor(parseOptions({})).map((stage) => stage.type), ["static", "llm"]);
    assert.equal(parseOptions({ classifier: { stages: [{ type: "laya" }] } }).classifier?.stages[0].type, "laya");
    assert.throws(() => parseOptions({ classifier: { stages: [{ type: "rules", rules: [{ expression: 'action == "shell"', decision: ["allow"] }] }] } }));
  });
});
