import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  makeReleaseBuild,
  monitoringTemplate,
  releaseBuildFiles,
  releaseMonitoringEnvironments,
  validateReleaseBuild
} from "../src/release-contract.mjs";

const sha = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const backendServer = `import { createServer } from "node:http";
import { run as runWorker } from "./worker.mjs";
import { run as runApi } from "./api.mjs";

export async function start({ port = 0, rowValue = 10 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/health") {
        response.end("ok");
        return;
      }
      if (request.url !== "/value") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const row = await runWorker({ row: { id: 1, value: rowValue } });
      const payload = await runApi({ row });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    } catch {
      response.statusCode = 500;
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
`;

const frontendServer = `import { createServer } from "node:http";
import { run as render } from "./render.mjs";

export async function start({ backendUrl, port = 0 } = {}) {
  let backendTarget;
  try {
    backendTarget = new URL(backendUrl);
  } catch {
    throw new Error("A local backend URL is required.");
  }
  if (
    backendTarget.protocol !== "http:" ||
    backendTarget.hostname !== "127.0.0.1" ||
    !backendTarget.port ||
    backendTarget.pathname !== "/" ||
    backendTarget.search ||
    backendTarget.hash
  )
    throw new Error("A local backend URL is required.");
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/health") {
        response.end("ok");
        return;
      }
      if (request.url !== "/") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const backend = await fetch(new URL("/value", backendTarget), {
        signal: AbortSignal.timeout(10_000)
      });
      if (!backend.ok) throw new Error("Backend request failed.");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(await render({ payload: await backend.json() }));
    } catch {
      response.statusCode = 500;
      response.end("frontend failed");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
`;

const frontendHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Coordinator sandbox</title></head>
  <body><main id="app">Built sandbox frontend</main></body>
</html>
`;

async function source(root, name) {
  const value = await readFile(path.join(root, name));
  if (!value.length || value.length > 12_000)
    throw new Error(`Sandbox build source size is invalid: ${name}.`);
  return value;
}

async function describe(directory, names) {
  return Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name);
      const handle = await open(file, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile())
          throw new Error(`Sandbox build output is not a file: ${name}.`);
        const value = await handle.readFile();
        return { path: name, sha256: digest(value), bytes: value.length };
      } finally {
        await handle.close();
      }
    })
  );
}

// The sample monitoring package mirrors the real one's shape: hand-edited
// alarm sources, a committed inventory generated from the backend service
// catalog, and a build that fails when that inventory is stale. Everything is
// bounded JSON; no candidate code runs while building or deploying it.
export const monitoringMetrics = Object.freeze([
  "Errors",
  "Throttles",
  "Duration"
]);
const keysOnly = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Sample monitoring source is not valid JSON: ${name}.`);
  }
}

export function monitoringCatalogFunctions(catalog, environment) {
  if (
    !Array.isArray(catalog?.services) ||
    !catalog.services.length ||
    catalog.services.length > 100 ||
    catalog.services.some(
      (service) =>
        !keysOnly(service, [
          "name",
          "allowed_environments",
          "default_dependencies"
        ]) ||
        !/^[A-Za-z0-9_-]{1,120}$/u.test(service.name ?? "") ||
        !Array.isArray(service.allowed_environments) ||
        service.allowed_environments.some(
          (value) => !releaseMonitoringEnvironments.includes(value)
        )
    )
  )
    throw new Error("The sample service catalog is unsupported.");
  const names = catalog.services
    .filter((service) => service.allowed_environments.includes(environment))
    .map((service) => service.name)
    .sort((a, b) => a.localeCompare(b));
  if (new Set(names).size !== names.length)
    throw new Error("The sample service catalog repeats a service.");
  return names;
}

export function validateMonitoringAlarms(value) {
  if (
    !keysOnly(value, ["alarms"]) ||
    !Array.isArray(value.alarms) ||
    !value.alarms.length ||
    value.alarms.length > 20 ||
    value.alarms.some(
      (alarm) =>
        !keysOnly(alarm, ["metric", "threshold"]) ||
        !monitoringMetrics.includes(alarm.metric) ||
        !Number.isSafeInteger(alarm.threshold) ||
        alarm.threshold < 1 ||
        alarm.threshold > 1000
    ) ||
    new Set(value.alarms.map((alarm) => alarm.metric)).size !==
      value.alarms.length
  )
    throw new Error("The sample monitoring alarms are unsupported.");
  return value.alarms.map(({ metric, threshold }) => ({ metric, threshold }));
}

export function validateMonitoringDeploy(value) {
  if (
    !keysOnly(value, ["fail_environment"]) ||
    !(
      value.fail_environment === null ||
      releaseMonitoringEnvironments.includes(value.fail_environment)
    )
  )
    throw new Error("The sample monitoring deployment switch is unsupported.");
  return { fail_environment: value.fail_environment ?? null };
}

export function monitoringInventory(catalog, alarms, environment) {
  if (!releaseMonitoringEnvironments.includes(environment))
    throw new Error("Unknown sample monitoring environment.");
  const functions = monitoringCatalogFunctions(catalog, environment);
  const validAlarms = validateMonitoringAlarms({ alarms });
  return {
    environment,
    functions,
    alarms: functions.flatMap((name) =>
      validAlarms.map((alarm) => ({
        name: `${environment}-${name}-${alarm.metric}`,
        function: name,
        metric: alarm.metric,
        threshold: alarm.threshold
      }))
    )
  };
}

export const monitoringInventoryText = (catalog, alarms, environment) =>
  json(monitoringInventory(catalog, alarms, environment));

export function validateMonitoringInventory(value, environment) {
  const functions = Array.isArray(value?.functions) ? value.functions : null;
  if (
    !keysOnly(value, ["environment", "functions", "alarms"]) ||
    value.environment !== environment ||
    !functions ||
    !Array.isArray(value.alarms) ||
    value.alarms.length > 2000 ||
    value.alarms.some(
      (alarm) =>
        !keysOnly(alarm, ["name", "function", "metric", "threshold"]) ||
        !functions.includes(alarm.function) ||
        !monitoringMetrics.includes(alarm.metric) ||
        alarm.name !== `${environment}-${alarm.function}-${alarm.metric}` ||
        !Number.isSafeInteger(alarm.threshold)
    )
  )
    throw new Error("The built monitoring inventory is unsupported.");
  return value;
}

async function readMonitoringSources(root) {
  const catalog = parseJson(
    await source(
      root,
      path.join("..", "..", "src", "config", "deploy-services.json")
    ),
    "deploy-services.json"
  );
  const alarms = validateMonitoringAlarms(
    parseJson(
      await source(root, path.join("src", "alarms.json")),
      "alarms.json"
    )
  );
  const deploy = validateMonitoringDeploy(
    parseJson(
      await source(root, path.join("src", "deploy.json")),
      "deploy.json"
    )
  );
  const generated = Object.fromEntries(
    releaseMonitoringEnvironments.map((environment) => [
      environment,
      monitoringInventoryText(catalog, alarms, environment)
    ])
  );
  return { catalog, alarms, deploy, generated };
}

export async function generateMonitoring(root = process.cwd()) {
  const { generated } = await readMonitoringSources(root);
  for (const [environment, text] of Object.entries(generated))
    await writeFile(path.join(root, monitoringTemplate(environment)), text);
  return Object.keys(generated);
}

export async function buildMonitoring({
  root = process.cwd(),
  sourceCommit = process.env.SANDBOX_SOURCE_COMMIT
} = {}) {
  if (!sha(sourceCommit))
    throw new Error("A sandbox role and exact source commit are required.");
  const { deploy, generated } = await readMonitoringSources(root);
  for (const [environment, text] of Object.entries(generated)) {
    const committed = (
      await source(root, monitoringTemplate(environment))
    ).toString("utf8");
    if (committed !== text)
      throw new Error(
        `Committed ${monitoringTemplate(environment)} is stale; regenerate the sample monitoring inventory.`
      );
  }
  const output = path.join(root, "dist");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const files = {
    "deploy.json": json(deploy),
    "monitoring-prod.json": generated.prod,
    "monitoring-staging.json": generated.staging
  };
  for (const [name, value] of Object.entries(files))
    await writeFile(path.join(output, name), value);
  const manifest = makeReleaseBuild({
    role: "monitoring",
    source_commit: sourceCommit,
    files: await describe(output, releaseBuildFiles.monitoring)
  });
  await writeFile(
    path.join(output, "build-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

export async function buildApplication(
  role,
  {
    root = process.cwd(),
    sourceCommit = process.env.SANDBOX_SOURCE_COMMIT
  } = {}
) {
  if (!releaseBuildFiles[role] || !sha(sourceCommit))
    throw new Error("A sandbox role and exact source commit are required.");
  if (role === "monitoring") return buildMonitoring({ root, sourceCommit });
  const output = path.join(root, "dist");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const files =
    role === "backend"
      ? {
          "api.mjs": await source(root, "src/api.mjs"),
          "change.json": await source(root, "src/data/change.json"),
          "item.json": await source(root, "src/entities/item.json"),
          "server.mjs": backendServer,
          "worker.mjs": await source(root, "src/worker.mjs")
        }
      : {
          "index.html": frontendHtml,
          "render.mjs": await source(root, "src/render.mjs"),
          "server.mjs": frontendServer
        };
  for (const [name, value] of Object.entries(files))
    await writeFile(path.join(output, name), value);
  const manifest = makeReleaseBuild({
    role,
    source_commit: sourceCommit,
    files: await describe(output, releaseBuildFiles[role])
  });
  await writeFile(
    path.join(output, "build-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

export async function verifyApplicationBuild(root, role, sourceCommit) {
  const output = path.join(root, "dist");
  const names = (await readdir(output)).sort();
  const expected = [...releaseBuildFiles[role], "build-manifest.json"].sort();
  if (names.join("\0") !== expected.join("\0"))
    throw new Error("Sandbox build output contains unexpected files.");
  const manifest = validateReleaseBuild(
    JSON.parse(await readFile(path.join(output, "build-manifest.json"), "utf8"))
  );
  if (manifest.role !== role || manifest.source_commit !== sourceCommit)
    throw new Error("Sandbox build belongs to different source code.");
  const actual = await describe(output, releaseBuildFiles[role]);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Sandbox build output differs from its manifest.");
  return manifest;
}

const direct =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  if (process.argv[2] === "monitoring" && process.argv[3] === "--generate") {
    console.log(JSON.stringify(await generateMonitoring()));
  } else {
    const manifest = await buildApplication(process.argv[2]);
    console.log(JSON.stringify(manifest));
  }
}
