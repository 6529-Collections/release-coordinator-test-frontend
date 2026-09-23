import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  monitoringTemplate,
  releaseBuildRoles,
  releaseBuildSourceRole,
  validateReleaseOperation,
  verifyReleaseReport,
  releaseProtocol
} from "../src/release-contract.mjs";
import {
  validateMonitoringDeploy,
  validateMonitoringInventory,
  verifyApplicationBuild
} from "./application-build.mjs";

const artifactDigest = (value) =>
  /^(?:sha256:)?[0-9a-f]{64}$/u.test(value ?? "");
async function sampleRowValue(root) {
  // The service-check workflow applies this fixture change to temporary MySQL.
  // Release jobs have no persistent database; built-output E2E uses the same
  // resulting row value and the fixture's fixed worker contract (double it).
  const backend = path.join(root, "candidates", "backend");
  const schema = JSON.parse(
    await readFile(path.join(backend, "dist", "item.json"), "utf8")
  );
  const change = JSON.parse(
    await readFile(path.join(backend, "dist", "change.json"), "utf8")
  );
  if (
    Object.keys(schema).length !== 1 ||
    ![1, 2].includes(schema.version) ||
    Object.keys(change).some(
      (key) => !["id", "increment", "fail_after_schema"].includes(key)
    ) ||
    !/^[a-z][a-z0-9-]{0,60}$/u.test(change.id ?? "") ||
    !Number.isSafeInteger(change.increment) ||
    change.increment < 0 ||
    change.increment > 100 ||
    change.fail_after_schema !== false
  )
    throw new Error(
      "Built database change cannot produce a verified sample row."
    );
  return 10 + change.increment;
}
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
// Monitoring builds live inside the exact backend checkout, like the real
// backend's separate ops/monitoring package.
const buildRoot = (root, role) =>
  role === "monitoring"
    ? path.join(root, "candidates", "backend", "ops", "monitoring")
    : path.join(root, "candidates", role);

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
    ref = null,
    now = () => new Date().toISOString()
  } = {}
) {
  const operation = validateReleaseOperation(input);
  const requiredRoles = releaseBuildRoles(operation);
  const checks = [];
  const builds = {};
  let status = "passed";
  let installed = null;
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

  if (operation.operation === "monitoring")
    // The dispatch branch follows the release environment. Version 1 saved
    // operations keep their prod-stage source for journal compatibility.
    await check("monitoring:source", () => {
      const expectedRef =
        operation.environment === "staging"
          ? "refs/heads/1a-staging"
          : "refs/heads/main";
      if (ref !== expectedRef)
        throw new Error(
          `Sample monitoring for ${operation.environment} deploys only from ${expectedRef}.`
        );
    });

  for (const role of requiredRoles) {
    let manifest;
    const buildOutcome = outcomes[role]?.build;
    if (buildOutcome === "success")
      manifest = await check(`build:${role}`, () =>
        verifyApplicationBuild(
          buildRoot(root, role),
          role,
          operation[`${releaseBuildSourceRole(role)}_commit`]
        )
      );
    else
      await check(`build:${role}`, () => {
        const outcome = !buildOutcome
          ? "has no reported outcome"
          : buildOutcome === "skipped"
            ? "was skipped"
            : "failed";
        throw new Error(`${role} npm build ${outcome}.`);
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
  if (status === "passed" && operation.operation === "monitoring") {
    const environment = operation.monitoring_environment;
    await check(`monitoring:${environment}`, async () => {
      const dist = path.join(buildRoot(root, "monitoring"), "dist");
      const deploy = validateMonitoringDeploy(
        JSON.parse(await readFile(path.join(dist, "deploy.json"), "utf8"))
      );
      const template = monitoringTemplate(environment);
      const text = await readFile(path.join(dist, template));
      validateMonitoringInventory(
        JSON.parse(text.toString("utf8")),
        environment
      );
      const file = builds.monitoring.manifest.files.find(
        (value) => value.path === template
      );
      const sha256 = createHash("sha256").update(text).digest("hex");
      if (!file || file.sha256 !== sha256)
        throw new Error("Built monitoring template differs from its manifest.");
      if (deploy.fail_environment === environment)
        throw new Error(
          `Controlled monitoring deployment failure for ${environment}.`
        );
      installed = {
        environment,
        source_commit: operation.backend_commit,
        template,
        sha256
      };
    });
  } else if (status === "passed" && operation.operation === "deploy") {
    await check(`${operation.role}:${operation.unit}`, async () => {
      if (operation.role === "frontend") {
        const frontend = await load("frontend", "render.mjs");
        if ((await frontend.run({ payload: { value: 20 } })) !== "Value: 20")
          throw new Error("Built frontend smoke check failed.");
        return;
      }
      const rowValue = await sampleRowValue(root);
      if (operation.unit === "dbMigrationsLoop") {
        // The earlier isolated MySQL run proves the database effect. This
        // stateless release check verifies the built files used afterward.
        if (!Number.isSafeInteger(rowValue))
          throw new Error("Built database source is invalid.");
        return;
      }
      if (!["worker", "api"].includes(operation.unit))
        throw new Error("Unsupported backend deployment unit.");
      const worker = await load("backend", "worker.mjs");
      const processed = await worker.run({ row: { id: 1, value: rowValue } });
      const result =
        operation.unit === "worker"
          ? processed
          : await (await load("backend", "api.mjs")).run({ row: processed });
      if (result?.id !== 1 || result.value !== 2 * rowValue)
        throw new Error("Built backend smoke check failed.");
    });
  } else if (status === "passed") {
    await check("matching-built-version-e2e", async () => {
      const rowValue = await sampleRowValue(root);
      const backendModule = await load("backend", "server.mjs");
      const frontendModule = await load("frontend", "server.mjs");
      let backend, frontend;
      try {
        backend = await backendModule.start({ rowValue });
        frontend = await frontendModule.start({ backendUrl: backend.url });
        const health = await fetch(`${backend.url}/health`, {
          signal: AbortSignal.timeout(10_000)
        });
        const rendered = await fetch(`${frontend.url}/`, {
          signal: AbortSignal.timeout(10_000)
        });
        if (
          !health.ok ||
          (await health.text()) !== "ok" ||
          !rendered.ok ||
          (await rendered.text()) !== `Value: ${2 * rowValue}`
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
    ...(operation.operation === "monitoring"
      ? { installed: status === "passed" ? installed : null }
      : {}),
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
    ["backend", "frontend", "monitoring"].map((role) => [
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
    outcomes,
    ref: process.env.GITHUB_REF ?? null
  });
  console.log(
    `COORDINATOR_RELEASE_RESULT:${Buffer.from(JSON.stringify(report)).toString("base64url")}`
  );
  if (report.status !== "passed") process.exitCode = 1;
}
