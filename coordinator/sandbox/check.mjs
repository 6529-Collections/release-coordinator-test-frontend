// Runs in the sample repositories' ordinary PR jobs, using the same runtime.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sampleFiles, fixtureServicePlan } from "./fixtures.mjs";
import { runDockerServicePlan } from "../src/service-runtime.mjs";

export async function checkSample(role, root = process.cwd()) {
  if (existsSync(`${root}/FAIL_CHECK`))
    throw new Error("Deliberate original sandbox gate failure.");
  if (!["frontend", "backend"].includes(role))
    throw new Error("Unknown sample role.");
  const files = sampleFiles();
  for (const name of Object.keys(files[role]))
    files[role][name] = await readFile(`${root}/${name}`, "utf8");
  const report = await runDockerServicePlan(fixtureServicePlan(files), {
    attemptId: randomUUID(),
    save: (value) =>
      writeFile(`${root}/sample-result.json`, JSON.stringify(value, null, 2))
  });
  console.log(
    JSON.stringify({
      status: report.status,
      steps: report.steps.map(({ unit, status }) => ({ unit, status })),
      errors: report.errors,
      cleanup: report.cleanup
    })
  );
  if (report.status !== "passed")
    throw new Error("Meaningful sample application checks failed.");
}
