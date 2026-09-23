import { createHash } from "node:crypto";

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(value);
const hash = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}

export const releaseHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export const releaseProtocol = 1;
export const releaseBuildProtocol = 1;
export const releaseEnvironments = ["staging", "prod"];
export const releaseOperations = ["deploy", "e2e", "monitoring"];
export const releaseBackendUnits = ["dbMigrationsLoop", "worker", "api"];
// New monitoring operations use the branch matching their environment. Saved
// v1 operations may still have staging monitoring in the prod release stage.
export const releaseMonitoringEnvironments = ["staging", "prod"];
export const releaseMonitoringUnit = "monitoring";
export const releaseMonitoringPaths = Object.freeze([
  "ops/monitoring/src/alarms.json",
  "ops/monitoring/src/deploy.json",
  "ops/monitoring/monitoring-prod.json",
  "ops/monitoring/monitoring-staging.json"
]);
export const releaseBuildFiles = Object.freeze({
  backend: Object.freeze([
    "api.mjs",
    "change.json",
    "item.json",
    "server.mjs",
    "worker.mjs"
  ]),
  frontend: Object.freeze(["index.html", "render.mjs", "server.mjs"]),
  monitoring: Object.freeze([
    "deploy.json",
    "monitoring-prod.json",
    "monitoring-staging.json"
  ])
});
export const releaseBuildSourceRole = (role) =>
  role === "monitoring" ? "backend" : role;
export const releaseBuildRoles = (operation) =>
  operation.operation === "e2e"
    ? ["backend", "frontend"]
    : operation.operation === "monitoring"
      ? ["monitoring"]
      : [operation.role];
export const monitoringTemplate = (environment) =>
  `monitoring-${environment}.json`;

export function makeReleaseBuild(value) {
  const contents = {
    protocol: releaseBuildProtocol,
    role: value.role,
    source_commit: value.source_commit,
    files: value.files
  };
  const build = { ...contents, fingerprint: releaseHash(contents) };
  validateReleaseBuild(build);
  return build;
}

export function validateReleaseBuild(value) {
  const { fingerprint, ...contents } = value ?? {};
  const names = releaseBuildFiles[value?.role];
  if (
    !object(value) ||
    value.protocol !== releaseBuildProtocol ||
    !names ||
    !sha(value.source_commit) ||
    !Array.isArray(value.files) ||
    value.files.length !== names.length ||
    value.files.some(
      (file, index) =>
        !object(file) ||
        file.path !== names[index] ||
        !hash(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 100_000
    ) ||
    !hash(fingerprint) ||
    releaseHash(contents) !== fingerprint
  )
    throw new Error("Invalid sandbox application build.");
  return value;
}

export function makeReleaseOperation(value) {
  const contents = {
    protocol: releaseProtocol,
    profile: "sandbox",
    release_id: value.release_id,
    operation_id: value.operation_id,
    operation: value.operation,
    environment: value.environment,
    role: value.role ?? null,
    unit: value.unit ?? null,
    backend_commit: value.backend_commit,
    frontend_commit: value.frontend_commit,
    // Older saved operations have no monitoring field; keep their fingerprints.
    ...(value.operation === "monitoring"
      ? { monitoring_environment: value.monitoring_environment }
      : {})
  };
  const operation = { ...contents, fingerprint: releaseHash(contents) };
  validateReleaseOperation(operation);
  return operation;
}

export function validateReleaseOperation(value) {
  const { fingerprint, ...contents } = value ?? {};
  if (
    !object(value) ||
    value.protocol !== releaseProtocol ||
    value.profile !== "sandbox" ||
    !uuid(value.release_id) ||
    !uuid(value.operation_id) ||
    !releaseOperations.includes(value.operation) ||
    !releaseEnvironments.includes(value.environment) ||
    !sha(value.backend_commit) ||
    !sha(value.frontend_commit) ||
    !hash(fingerprint) ||
    releaseHash(contents) !== fingerprint ||
    (value.operation === "e2e" &&
      (value.role !== null || value.unit !== null)) ||
    (value.operation === "deploy" &&
      !(
        ["backend", "frontend"].includes(value.role) &&
        typeof value.unit === "string" &&
        /^[A-Za-z][A-Za-z0-9]{0,60}$/u.test(value.unit) &&
        (value.role === "frontend"
          ? value.unit === "frontend"
          : releaseBackendUnits.includes(value.unit))
      )) ||
    (value.operation === "monitoring"
      ? !(
          value.role === "backend" &&
          value.unit === releaseMonitoringUnit &&
          (value.environment === value.monitoring_environment ||
            // Existing v1 release journals put staging monitoring in prod.
            (value.environment === "prod" &&
              value.monitoring_environment === "staging")) &&
          releaseMonitoringEnvironments.includes(value.monitoring_environment)
        )
      : Object.hasOwn(value, "monitoring_environment"))
  )
    throw new Error("Invalid sandbox release operation.");
  return value;
}

function installedMatches(report, operation) {
  const installed = report.installed;
  if (operation.operation !== "monitoring")
    return !Object.hasOwn(report, "installed");
  if (report.status !== "passed")
    return installed === null || installed === undefined;
  const template = monitoringTemplate(operation.monitoring_environment);
  const file = report.builds?.monitoring?.manifest?.files?.find(
    (value) => value.path === template
  );
  return (
    object(installed) &&
    Object.keys(installed).length === 4 &&
    installed.environment === operation.monitoring_environment &&
    installed.source_commit === operation.backend_commit &&
    installed.template === template &&
    hash(installed.sha256) &&
    installed.sha256 === file?.sha256
  );
}

export function verifyReleaseReport(report, operation) {
  validateReleaseOperation(operation);
  const requiredBuildRoles = releaseBuildRoles(operation);
  const buildEntries = object(report?.builds)
    ? Object.entries(report.builds)
    : [];
  const buildsValid = buildEntries.every(([role, build]) => {
    try {
      return (
        requiredBuildRoles.includes(role) &&
        object(build) &&
        validateReleaseBuild(build.manifest)?.role === role &&
        build.manifest.source_commit ===
          operation[`${releaseBuildSourceRole(role)}_commit`] &&
        object(build.artifact) &&
        build.artifact.name ===
          `sandbox-build-${operation.operation_id}-${role}` &&
        /^(?:sha256:)?[0-9a-f]{64}$/u.test(build.artifact.digest ?? "")
      );
    } catch {
      return false;
    }
  });
  if (
    !object(report) ||
    report.protocol !== releaseProtocol ||
    report.profile !== "sandbox" ||
    report.release_id !== operation.release_id ||
    report.operation_id !== operation.operation_id ||
    report.operation_hash !== operation.fingerprint ||
    report.operation !== operation.operation ||
    report.environment !== operation.environment ||
    report.role !== operation.role ||
    report.unit !== operation.unit ||
    !["passed", "failed"].includes(report.status) ||
    !Array.isArray(report.checks) ||
    !report.checks.length ||
    report.checks.some(
      (check) =>
        !object(check) ||
        typeof check.name !== "string" ||
        !["passed", "failed"].includes(check.status)
    ) ||
    !object(report.builds) ||
    !buildsValid ||
    (report.status === "passed" &&
      (buildEntries.length !== requiredBuildRoles.length ||
        requiredBuildRoles.some((role) => !report.builds[role]))) ||
    !installedMatches(report, operation) ||
    !object(report.versions) ||
    report.versions.backend !== operation.backend_commit ||
    report.versions.frontend !== operation.frontend_commit ||
    !object(report.runner) ||
    !Number.isSafeInteger(report.runner.run_id) ||
    report.runner.run_id < 1 ||
    !Number.isSafeInteger(report.runner.attempt) ||
    report.runner.attempt < 1 ||
    !sha(report.runner.commit) ||
    typeof report.runner.repository !== "string" ||
    !Number.isFinite(Date.parse(report.completed_at)) ||
    (report.status === "passed" &&
      report.checks.some((check) => check.status !== "passed")) ||
    (report.status === "failed" &&
      !report.checks.some((check) => check.status === "failed"))
  )
    throw new Error(
      "Sandbox release report does not match its saved operation."
    );
  return report;
}
