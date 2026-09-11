import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateReleaseOperation,
  verifyReleaseReport,
  releaseProtocol
} from "../src/release-contract.mjs";

const operation = validateReleaseOperation(
  JSON.parse(process.env.OPERATION_JSON ?? "null")
);
if (process.env.OPERATION_ID !== operation.operation_id)
  throw new Error("Workflow operation identity does not match its input.");

const root = process.cwd();
const load = async (relative) =>
  import(pathToFileURL(path.join(root, relative)).href);
const checks = [];
let status = "passed";
const safeError = (error) =>
  String(error?.message ?? "Unknown failure")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .slice(0, 500);

async function check(name, work) {
  try {
    await work();
    checks.push({ name, status: "passed" });
  } catch (error) {
    status = "failed";
    const message = safeError(error);
    checks.push({ name, status: "failed", message });
    console.error(`${name}: ${message}`);
  }
}

if (operation.operation === "deploy") {
  await check(`${operation.role}:${operation.unit}`, async () => {
    if (operation.role === "frontend") {
      const frontend = await load("candidates/frontend/src/render.mjs");
      if ((await frontend.run({ payload: { value: 20 } })) !== "Value: 20")
        throw new Error("Frontend smoke check failed.");
      return;
    }
    if (operation.unit === "dbMigrationsLoop") {
      const schema = JSON.parse(
        await readFile("candidates/backend/src/entities/item.json", "utf8")
      );
      const change = JSON.parse(
        await readFile("candidates/backend/src/data/change.json", "utf8")
      );
      if (!Number.isSafeInteger(schema.version) || typeof change.id !== "string")
        throw new Error("Database source is invalid.");
      return;
    }
    const programs = {
      worker: "candidates/backend/src/worker.mjs",
      api: "candidates/backend/src/api.mjs"
    };
    if (!programs[operation.unit])
      throw new Error("Unsupported backend deployment unit.");
    const program = await load(programs[operation.unit]);
    const result = await program.run({ row: { id: 1, value: 10 } });
    if (result?.id !== 1 || !Number.isFinite(result.value))
      throw new Error("Backend smoke check failed.");
  });
} else {
  await check("matching-version-e2e", async () => {
    const worker = await load("candidates/backend/src/worker.mjs");
    const api = await load("candidates/backend/src/api.mjs");
    const frontend = await load("candidates/frontend/src/render.mjs");
    const row = await worker.run({ row: { id: 1, value: 10 } });
    const payload = await api.run({ row });
    const rendered = await frontend.run({ payload });
    if (payload?.value !== 20 || rendered !== "Value: 20")
      throw new Error("The combined application result differs from the baseline contract.");
  });
}

const runner = {
  repository: process.env.GITHUB_REPOSITORY,
  run_id: Number(process.env.GITHUB_RUN_ID),
  attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  commit: process.env.GITHUB_SHA
};
if (!Number.isSafeInteger(runner.run_id) || runner.run_id < 1)
  throw new Error("GitHub runner ID is missing or invalid.");
if (!Number.isSafeInteger(runner.attempt) || runner.attempt < 1)
  throw new Error("GitHub workflow attempt is missing or invalid.");

const report = {
  protocol: releaseProtocol,
  profile: "sandbox",
  release_id: operation.release_id,
  operation_id: operation.operation_id,
  operation_hash: operation.fingerprint,
  operation: operation.operation,
  environment: operation.environment,
  role: operation.role,
  unit: operation.unit,
  status,
  checks,
  versions: {
    backend: operation.backend_commit,
    frontend: operation.frontend_commit
  },
  runner,
  completed_at: new Date().toISOString()
};
verifyReleaseReport(report, operation);
console.log(
  `COORDINATOR_RELEASE_RESULT:${Buffer.from(JSON.stringify(report)).toString("base64url")}`
);
if (status !== "passed") process.exitCode = 1;
