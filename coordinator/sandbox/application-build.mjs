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
  releaseBuildFiles,
  validateReleaseBuild
} from "../src/release-contract.mjs";

const sha = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
const digest = (value) => createHash("sha256").update(value).digest("hex");

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

export async function buildApplication(
  role,
  {
    root = process.cwd(),
    sourceCommit = process.env.SANDBOX_SOURCE_COMMIT
  } = {}
) {
  if (!releaseBuildFiles[role] || !sha(sourceCommit))
    throw new Error("A sandbox role and exact source commit are required.");
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
  const manifest = await buildApplication(process.argv[2]);
  console.log(JSON.stringify(manifest));
}
