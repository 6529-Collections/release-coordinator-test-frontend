import { createHash } from "node:crypto";

export const serviceProtocol = "sandbox-services-v1";
export const serviceStatuses = [
  "not-run",
  "passed",
  "blocked",
  "unknown",
  "stale"
];
export const serviceFiles = Object.freeze({
  backend: [
    "src/config/deploy-services.json",
    "src/entities/item.json",
    "src/data/change.json",
    "src/worker.mjs",
    "src/api.mjs"
  ],
  frontend: ["src/render.mjs"]
});
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
export const serviceHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const blobHash = (text) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
export class ServiceError extends Error {
  constructor(code, message, status = "unknown") {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function serviceAssert(ok, code, message, status = "unknown") {
  if (!ok) throw new ServiceError(code, message, status);
}
export function fileJson(file) {
  serviceAssert(
    file && typeof file.text === "string" && blobHash(file.text) === file.sha,
    "source-unverified",
    "A sample source file does not match its Git blob."
  );
  try {
    return JSON.parse(file.text);
  } catch {
    throw new ServiceError(
      "source-unverified",
      "A sample configuration is not valid JSON."
    );
  }
}
export function databaseSpec(files) {
  const schema = fileJson(files["src/entities/item.json"]);
  const change = fileJson(files["src/data/change.json"]);
  serviceAssert(
    Object.keys(schema).length === 1 && [1, 2].includes(schema.version),
    "database-unverified",
    "The sample schema version is unsupported."
  );
  serviceAssert(
    Object.keys(change).every((key) =>
      ["id", "increment", "fail_after_schema"].includes(key)
    ) &&
      /^[a-z][a-z0-9-]{0,60}$/u.test(change.id) &&
      Number.isSafeInteger(change.increment) &&
      change.increment >= 0 &&
      change.increment <= 100 &&
      typeof change.fail_after_schema === "boolean",
    "database-unverified",
    "The one-off sample database change is unsupported."
  );
  return { schema, change };
}
export function validateServicePlan(plan) {
  serviceAssert(
    plan?.protocol === serviceProtocol &&
      plan.profile === "sandbox" &&
      plan.target === "staging" &&
      /^[0-9a-f]{64}$/u.test(plan.fingerprint ?? ""),
    "unsupported-plan",
    "Only an exact sandbox service plan is executable."
  );
  const { fingerprint, ...contents } = plan;
  serviceAssert(
    serviceHash(contents) === fingerprint,
    "source-unverified",
    "Service plan fingerprint changed."
  );
  serviceAssert(
    plan.database &&
      ["yes", "no"].includes(plan.database.declared) &&
      plan.database.declared === plan.database.observed,
    "database-unverified",
    "Database execution requires a resolved, matching answer."
  );
  const identities = {
    backend: [1362505082, "6529-Collections/release-coordinator-test-backend"],
    frontend: [1362504370, "6529-Collections/release-coordinator-test-frontend"]
  };
  for (const role of ["backend", "frontend"]) {
    const source = plan.sources?.[role];
    serviceAssert(
      source?.repository.id === identities[role][0] &&
        source.repository.full_name === identities[role][1] &&
        /^[0-9a-f]{40}$/u.test(source.tree) &&
        /^[0-9a-f]{40}$/u.test(source.base_commit),
      "source-unverified",
      "A source is outside the pinned sample repositories."
    );
    for (const kind of ["files", "baseline"]) {
      serviceAssert(
        source[kind] &&
          Object.keys(source[kind]).length === serviceFiles[role].length,
        "source-unverified",
        "The sample source set is incomplete."
      );
      for (const name of serviceFiles[role]) {
        const file = source[kind][name];
        serviceAssert(
          typeof file?.text === "string" &&
            Buffer.byteLength(file.text) <= 12_000 &&
            blobHash(file.text) === file.sha,
          "source-unverified",
          "Sample code differs from its recorded Git object."
        );
      }
    }
  }
  const before = databaseSpec(plan.sources.backend.baseline),
    after = databaseSpec(plan.sources.backend.files);
  serviceAssert(
    after.schema.version >= before.schema.version,
    "database-unverified",
    "Schema downgrades need a separate recovery design."
  );
  serviceAssert(
    (serviceHash(before) === serviceHash(after) ? "no" : "yes") ===
      plan.database.observed,
    "database-unverified",
    "Database classification does not match the saved definitions."
  );
  const seen = new Set();
  serviceAssert(
    Array.isArray(plan.steps) && plan.steps.length === 4,
    "invalid-services",
    "This sample needs its four explicit service steps."
  );
  for (const step of plan.steps) {
    const role = step.unit === "frontend" ? "frontend" : "backend";
    const sourcePath = {
      worker: "src/worker.mjs",
      api: "src/api.mjs",
      frontend: "src/render.mjs"
    }[step.unit];
    const version =
      step.unit === "dbMigrationsLoop"
        ? serviceHash(after)
        : plan.sources[role].files[sourcePath]?.sha;
    serviceAssert(
      ["dbMigrationsLoop", "worker", "api", "frontend"].includes(step.unit) &&
        !seen.has(step.unit) &&
        Array.isArray(step.depends_on) &&
        step.depends_on.every((name) => seen.has(name)) &&
        step.role === role &&
        step.version === version,
      "invalid-services",
      "Services are missing, repeated, or out of dependency order.",
      "blocked"
    );
    const required = {
      dbMigrationsLoop: [],
      worker: ["dbMigrationsLoop"],
      api: ["worker"],
      frontend: ["api"]
    }[step.unit];
    serviceAssert(
      required.every((name) => step.depends_on.includes(name)),
      "invalid-services",
      "The sample application prerequisite was omitted.",
      "blocked"
    );
    seen.add(step.unit);
  }
  serviceAssert(
    Buffer.byteLength(JSON.stringify(plan)) < 55_000,
    "plan-limit",
    "Service input exceeds the workflow size limit."
  );
  return plan;
}

// Shared controller: adapters supply sample effects; no repository or shell
// command can be supplied by a ticket. The same order/stop rules run in CI/tests.
export async function executeServiceSteps(
  plan,
  adapter,
  {
    attemptId,
    save = async () => {},
    now = () => new Date().toISOString()
  } = {}
) {
  validateServicePlan(plan);
  const report = {
    protocol: serviceProtocol,
    profile: "sandbox",
    release_authorized: false,
    plan_hash: plan.fingerprint,
    attempt_id: attemptId,
    status: "unknown",
    started_at: now(),
    baseline: { status: "not-run" },
    steps: plan.steps.map((step) => ({ ...step, status: "not-run" })),
    cleanup: { status: "pending" },
    errors: []
  };
  try {
    await save(report);
    report.baseline = await adapter.prepare(plan);
    serviceAssert(
      report.baseline?.status === "passed",
      "baseline-unverified",
      "The unchanged database/application baseline did not pass."
    );
    await save(report);
    for (const step of report.steps) {
      step.status = "running";
      step.started_at = now();
      await save(report);
      try {
        const result = await adapter.run(step, plan);
        serviceAssert(
          result?.version === step.version,
          "version-unverified",
          "A service returned the wrong source version."
        );
        serviceAssert(
          result.status === "passed",
          "service-failed",
          "A sample service failed its application checks.",
          "blocked"
        );
        step.result = result;
        step.status = "passed";
      } catch (error) {
        step.status = error instanceof ServiceError ? error.status : "unknown";
        throw error;
      } finally {
        step.finished_at = now();
      }
      await save(report);
    }
    report.status = "passed";
  } catch (error) {
    report.status = error instanceof ServiceError ? error.status : "unknown";
    for (const step of report.steps) {
      if (step.status === "running") step.status = "unknown";
    }
    report.errors.push(
      error instanceof ServiceError
        ? { code: error.code, message: error.message }
        : {
            code: "operation-unverified",
            message:
              "Sample execution or evidence saving could not be verified."
          }
    );
  } finally {
    try {
      report.database_state = await adapter.inspect();
    } catch {
      report.database_state = { status: "unknown" };
    }
    if (
      report.database_state?.status !== "verified" &&
      report.status === "passed"
    ) {
      report.status = "unknown";
      report.errors.push({
        code: "database-unverified",
        message: "The final database state could not be verified."
      });
    }
    // Evidence must be saved before deleting state. A failed save leaves the
    // resources named for investigation instead of erasing the only evidence.
    report.finished_at = now();
    try {
      await save(report);
      report.cleanup = await adapter.cleanup();
      serviceAssert(
        report.cleanup?.status === "removed",
        "cleanup-unverified",
        "Owned sample resources could not be verified as removed."
      );
    } catch {
      report.status = "unknown";
      report.cleanup = {
        status: "unknown",
        resources: adapter.resources?.() ?? []
      };
      report.errors.push({
        code: "cleanup-unverified",
        message:
          "Evidence saving or owned-resource cleanup requires reconciliation."
      });
    }
    await save(report);
  }
  return report;
}

export function verifyServiceReport(report, plan, attemptId) {
  validateServicePlan(plan);
  serviceAssert(
    report?.protocol === serviceProtocol &&
      report.profile === "sandbox" &&
      report.release_authorized === false &&
      report.plan_hash === plan.fingerprint &&
      report.attempt_id === attemptId &&
      serviceStatuses.includes(report.status) &&
      Array.isArray(report.errors) &&
      Array.isArray(report.steps) &&
      report.steps.length === plan.steps.length,
    "result-unverified",
    "Workflow evidence is not bound to this exact service attempt."
  );
  for (const [index, expected] of plan.steps.entries()) {
    const step = report.steps[index];
    serviceAssert(
      step.unit === expected.unit &&
        step.version === expected.version &&
        serviceHash(step.depends_on) === serviceHash(expected.depends_on) &&
        ["not-run", "passed", "blocked", "unknown", "stale"].includes(
          step.status
        ),
      "result-unverified",
      "Workflow steps differ from the saved service plan."
    );
    if (step.status === "passed")
      serviceAssert(
        step.result?.status === "passed" &&
          step.result.version === expected.version &&
          report.steps
            .slice(0, index)
            .every((prior) => prior.status === "passed"),
        "result-unverified",
        "Service success lacks its prerequisites or version proof."
      );
  }
  if (report.status === "passed")
    serviceAssert(
      report.baseline?.status === "passed" &&
        report.cleanup?.status === "removed" &&
        !report.errors.length &&
        report.steps.every((step) => step.status === "passed") &&
        report.database_state?.status === "verified",
      "result-unverified",
      "A passing workflow lacks database, step, or cleanup evidence."
    );
  return report;
}
