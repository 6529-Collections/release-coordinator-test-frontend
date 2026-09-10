// The dedicated, pinned Actions workflow calls this trusted entry point.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runDockerServicePlan } from "../src/service-runtime.mjs";
import {
  validateServicePlan,
  serviceAssert
} from "../src/service-contract.mjs";

serviceAssert(
  process.env.GITHUB_REPOSITORY ===
    "6529-Collections/release-coordinator-test-backend" &&
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    typeof process.env.PLAN_JSON === "string" &&
    process.env.PLAN_JSON.length > 0 &&
    typeof process.env.RUNNER_TEMP === "string" &&
    path.isAbsolute(process.env.RUNNER_TEMP) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      process.env.ATTEMPT_ID ?? ""
    ),
  "unsupported-runner",
  "This entry point requires the dedicated sandbox workflow."
);
const plan = validateServicePlan(JSON.parse(process.env.PLAN_JSON));
serviceAssert(
  plan.binding?.repository ===
    "6529-Collections/release-coordinator-test-inbox" &&
    plan.runtime?.commit === process.env.GITHUB_SHA,
  "source-unverified",
  "Workflow source or verified-input binding is wrong."
);
const directory = path.join(
  process.env.RUNNER_TEMP,
  "coordinator-service-evidence"
);
await mkdir(directory, { recursive: true });
const report = await runDockerServicePlan(plan, {
  attemptId: process.env.ATTEMPT_ID,
  save: (value) =>
    writeFile(
      path.join(directory, "checkpoint.json"),
      JSON.stringify(value, null, 2)
    )
});
report.runner = {
  run_id: process.env.GITHUB_RUN_ID,
  attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  commit: process.env.GITHUB_SHA
};
console.log(
  `COORDINATOR_SERVICE_RESULT:${Buffer.from(JSON.stringify(report)).toString("base64")}`
);
process.exitCode = report.status === "passed" ? 0 : 1;
