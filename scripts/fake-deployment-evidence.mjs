import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateReleaseBuild } from "../coordinator/src/release-contract.mjs";
import { verifyApplicationBuild } from "../coordinator/sandbox/application-build.mjs";

const sha = (value) => /^[0-9a-f]{40}$/u.test(value ?? "");
const runId = (value) => /^[1-9][0-9]{0,19}$/u.test(value ?? "");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function expected({ role, environment, sourceSha, workflowRunId, workflowPath }) {
  if (
    !["frontend", "backend", "monitoring"].includes(role) ||
    !["staging", "prod"].includes(environment) ||
    !sha(sourceSha) ||
    !runId(workflowRunId) ||
    !/^\.github\/workflows\/[a-z0-9-]+\.yml$/u.test(workflowPath)
  )
    throw new Error("Fake deployment identity is invalid.");
  return {
    role,
    environment,
    source_sha: sourceSha,
    workflow_run_id: workflowRunId,
    workflow_path: workflowPath
  };
}

async function readBuild(manifestPath, role, sourceSha) {
  const text = await readFile(manifestPath);
  const manifest = validateReleaseBuild(JSON.parse(text.toString("utf8")));
  if (manifest.role !== role || manifest.source_commit !== sourceSha)
    throw new Error("Fake deployment build belongs to different source code.");
  await verifyApplicationBuild(path.dirname(path.dirname(manifestPath)), role, sourceSha);
  return { manifest, digest: digest(text) };
}

export async function createFakeDeploymentEvidence({
  role,
  environment,
  sourceSha,
  workflowRunId,
  workflowPath,
  unit = null,
  manifestPath,
  outputPath
}) {
  const identity = expected({
    role,
    environment,
    sourceSha,
    workflowRunId,
    workflowPath
  });
  const build = await readBuild(manifestPath, role, sourceSha);
  const evidence = {
    contract: "fake-deployment-evidence-v1",
    ...identity,
    unit,
    build_manifest_sha256: build.digest
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export async function verifyFakeDeploymentEvidence({
  role,
  environment,
  sourceSha,
  workflowRunId,
  workflowPath,
  unit = null,
  manifestPath,
  evidencePath
}) {
  const identity = expected({
    role,
    environment,
    sourceSha,
    workflowRunId,
    workflowPath
  });
  const build = await readBuild(manifestPath, role, sourceSha);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const wanted = {
    contract: "fake-deployment-evidence-v1",
    ...identity,
    unit,
    build_manifest_sha256: build.digest
  };
  if (!isDeepStrictEqual(evidence, wanted))
    throw new Error("Fake deployment evidence does not match the selected run.");
  return evidence;
}

const direct =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  const args = process.argv.slice(2);
  if (args.length !== 9)
    throw new Error(
      "Expected command, role, environment, source SHA, run ID, workflow path, unit, build manifest and evidence path."
    );
  const [command, role, environment, sourceSha, workflowRunId, workflowPath, unitValue, manifestPath, evidencePath] = args;
  const input = {
    role,
    environment,
    sourceSha,
    workflowRunId,
    workflowPath,
    unit: unitValue === "-" ? null : unitValue,
    manifestPath,
    ...(command === "create" ? { outputPath: evidencePath } : { evidencePath })
  };
  const result =
    command === "create"
      ? await createFakeDeploymentEvidence(input)
      : command === "verify"
        ? await verifyFakeDeploymentEvidence(input)
        : (() => {
            throw new Error("Expected create or verify.");
          })();
  console.log(JSON.stringify(result));
}
