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
export const releaseEnvironments = ["staging", "prod"];
export const releaseOperations = ["deploy", "e2e"];
export const releaseBackendUnits = ["dbMigrationsLoop", "worker", "api"];

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
    frontend_commit: value.frontend_commit
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
      ))
  )
    throw new Error("Invalid sandbox release operation.");
  return value;
}

export function verifyReleaseReport(report, operation) {
  validateReleaseOperation(operation);
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
    !object(report.versions) ||
    report.versions.backend !== operation.backend_commit ||
    report.versions.frontend !== operation.frontend_commit ||
    !object(report.runner) ||
    !Number.isSafeInteger(Number(report.runner.run_id)) ||
    Number(report.runner.run_id) < 1 ||
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
    throw new Error("Sandbox release report does not match its saved operation.");
  return report;
}
