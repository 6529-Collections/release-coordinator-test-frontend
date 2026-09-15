import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateReleaseOperation,
  verifyReleaseReport,
  releaseProtocol
} from "../src/release-contract.mjs";
import { verifyApplicationBuild } from "./application-build.mjs";

const artifactDigest = (value) =>
  /^(?:sha256:)?[0-9a-f]{64}$/u.test(value ?? "");
const safeError = (error) => {
  const message = String(error?.message ?? "Unknown failure").replace(
    /[\p{Cc}\p{Cf}]/gu,
    " "
  );
  const limit = 500;
  const splitPair =
    /[\uD800-\uDBFF]/u.test(message[limit - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(message[limit] ?? "");
  return message.slice(0, splitPair ? limit - 1 : limit);
};

export async function closeServers(frontend, backend) {
  try {
    await frontend?.close();
  } finally {
    await backend?.close();
  }
}

export async function runSandboxReleaseOperation(
  input,
  {
    root = process.cwd(),
    runner,
    outcomes = {},
    now = () => new Date().toISOString()
  } = {}
) {
  const operation = validateReleaseOperation(input);
  const requiredRoles =
    operation.operation === "e2e" ? ["backend", "frontend"] : [operation.role];
  const checks = [];
  const builds = {};
  let status = "passed";
  const check = async (name, work) => {
    try {
      const result = await work();
      checks.push({ name, status: "passed" });
      return result;
    } catch (error) {
      status = "failed";
      const message = safeError(error);
      checks.push({ name, status: "failed", message });
      console.error(`${name}: ${message}`);
      return null;
    }
  };

  for (const role of requiredRoles) {
    let manifest;
    if (outcomes[role]?.build === "success")
      manifest = await check(`build:${role}`, () =>
        verifyApplicationBuild(
          path.join(root, "candidates", role),
          role,
          operation[`${role}_commit`]
        )
      );
    else
      await check(`build:${role}`, () => {
        throw new Error(`${role} npm build failed.`);
      });
    if (!manifest) continue;
    const artifact = await check(`artifact:${role}`, () => {
      if (
        outcomes[role]?.artifact !== "success" ||
        !artifactDigest(outcomes[role]?.digest)
      )
        throw new Error(`${role} build artifact upload failed.`);
      return {
        name: `sandbox-build-${operation.operation_id}-${role}`,
        digest: outcomes[role].digest
      };
    });
    if (artifact) builds[role] = { manifest, artifact };
  }

  const load = (role, relative) =>
    import(
      pathToFileURL(path.join(root, "candidates", role, "dist", relative)).href
    );
  if (status === "passed" && operation.operation === "deploy") {
    await check(`${operation.role}:${operation.unit}`, async () => {
      if (operation.role === "frontend") {
        const frontend = await load("frontend", "render.mjs");
        if ((await frontend.run({ payload: { value: 20 } })) !== "Value: 20")
          throw new Error("Built frontend smoke check failed.");
        return;
      }
      if (operation.unit === "dbMigrationsLoop") {
        const base = path.join(root, "candidates", "backend", "dist");
        const schema = JSON.parse(await readFile(path.join(base, "item.json")));
        const change = JSON.parse(
          await readFile(path.join(base, "change.json"))
        );
        if (
          !Number.isSafeInteger(schema.version) ||
          typeof change.id !== "string"
        )
          throw new Error("Built database source is invalid.");
        return;
      }
      const programs = { worker: "worker.mjs", api: "api.mjs" };
      if (!programs[operation.unit])
        throw new Error("Unsupported backend deployment unit.");
      const program = await load("backend", programs[operation.unit]);
      const result = await program.run({ row: { id: 1, value: 10 } });
      if (result?.id !== 1 || !Number.isFinite(result.value))
        throw new Error("Built backend smoke check failed.");
    });
  } else if (status === "passed") {
    await check("matching-built-version-e2e", async () => {
      const backendModule = await load("backend", "server.mjs");
      const frontendModule = await load("frontend", "server.mjs");
      let backend, frontend;
      try {
        backend = await backendModule.start();
        frontend = await frontendModule.start({ backendUrl: backend.url });
        const health = await fetch(`${backend.url}/health`);
        const rendered = await fetch(`${frontend.url}/`);
        if (
          !health.ok ||
          (await health.text()) !== "ok" ||
          !rendered.ok ||
          (await rendered.text()) !== "Value: 20"
        )
          throw new Error(
            "The built applications differ from the baseline contract."
          );
      } finally {
        await closeServers(frontend, backend);
      }
    });
  }

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
    builds,
    versions: {
      backend: operation.backend_commit,
      frontend: operation.frontend_commit
    },
    runner,
    completed_at: now()
  };
  verifyReleaseReport(report, operation);
  return report;
}

const direct =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  const operation = validateReleaseOperation(
    JSON.parse(process.env.OPERATION_JSON ?? "null")
  );
  if (process.env.OPERATION_ID !== operation.operation_id)
    throw new Error("Workflow operation identity does not match its input.");
  const runner = {
    repository: process.env.GITHUB_REPOSITORY,
    run_id: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    commit: process.env.GITHUB_SHA
  };
  const outcomes = Object.fromEntries(
    ["backend", "frontend"].map((role) => [
      role,
      {
        build: process.env[`${role.toUpperCase()}_BUILD_OUTCOME`],
        artifact: process.env[`${role.toUpperCase()}_ARTIFACT_OUTCOME`],
        digest: process.env[`${role.toUpperCase()}_ARTIFACT_DIGEST`]
      }
    ])
  );
  const report = await runSandboxReleaseOperation(operation, {
    runner,
    outcomes
  });
  console.log(
    `COORDINATOR_RELEASE_RESULT:${Buffer.from(JSON.stringify(report)).toString("base64url")}`
  );
  if (report.status !== "passed") process.exitCode = 1;
}
