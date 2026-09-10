import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ServiceError,
  serviceAssert,
  serviceHash,
  databaseSpec,
  executeServiceSteps,
  validateServicePlan
} from "./service-contract.mjs";

export const serviceImages = Object.freeze({
  node: "node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
  mysql:
    "mysql@sha256:3466ba4a4828aa8d46fb7c3bc16b67b781c98413cf4ea0fac6feaa6e881faa26"
});
const label = "6529-coordinator-service-attempt";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function dockerCommand(
  args,
  { input, timeout = 30_000, allowedCodes = [0] } = {}
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      {
        encoding: "utf8",
        timeout,
        maxBuffer: 256 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DOCKER_HOST: process.env.DOCKER_HOST,
          DOCKER_CONTEXT: process.env.DOCKER_CONTEXT
        }
      },
      (error, stdout) => {
        if (error && !allowedCodes.includes(error.code))
          reject(
            new ServiceError(
              error.killed ? "service-timeout" : "container-unavailable",
              error.killed
                ? "A sample container exceeded its time limit."
                : "The isolated sample container operation failed."
            )
          );
        else resolve({ code: error?.code ?? 0, stdout });
      }
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Candidate code only sees its read-only files and JSON stdin. It cannot reach
// MySQL, GitHub, the Docker socket, or the controller's evidence files.
const wrapper = `import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
const input = JSON.parse(await readFile('/dev/stdin', 'utf8'));
const text = await readFile('/app/program.mjs', 'utf8');
const source = createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\\0').update(text).digest('hex');
const program = await import('/app/program.mjs');
let value;
if (input.unit === 'api') {
  const server = createServer(async (_request, response) => {
    try { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await program.run(input.data))); }
    catch { response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { const result = await fetch('http://127.0.0.1:' + server.address().port + '/item'); if (!result.ok) throw Error('API failed'); value = await result.json(); }
  finally { await new Promise(resolve => server.close(resolve)); }
} else value = await program.run(input.data);
process.stdout.write(JSON.stringify({ source, value }));
`;

export async function createDockerServiceAdapter(
  plan,
  attemptId,
  { docker = dockerCommand, wait = delay } = {}
) {
  validateServicePlan(plan);
  serviceAssert(
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(attemptId),
    "invalid-attempt",
    "An exact attempt ID is required."
  );
  const directory = await mkdtemp(path.join(tmpdir(), "6529-service-"));
  const prefix = `rc-service-${attemptId}`,
    mysql = `${prefix}-mysql`,
    owned = new Set();
  const baseline = databaseSpec(plan.sources.backend.baseline),
    candidate = databaseSpec(plan.sources.backend.files);
  let count = 0,
    dbReady = false;
  const resources = () => [...owned];
  async function owns(name) {
    const listed = await docker([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${name}$`
    ]);
    if (!listed.stdout.trim()) return false;
    const found = await docker([
      "inspect",
      "--format",
      `{{ index .Config.Labels "${label}" }}`,
      name
    ]);
    serviceAssert(
      found.stdout.trim() === attemptId,
      "cleanup-unverified",
      "Container ownership changed; it was not removed."
    );
    return true;
  }
  async function sql(statement, timeout = 20_000) {
    const result = await docker(
      [
        "exec",
        "-i",
        "-e",
        "MYSQL_PWD=only-sandbox-data",
        mysql,
        "mysql",
        "--user=root",
        "--batch",
        "--skip-column-names",
        "coordinator"
      ],
      { input: statement, timeout }
    );
    return result.stdout.trim();
  }
  async function program(unit, file, data) {
    const folder = path.join(directory, `program-${++count}`),
      name = `${prefix}-program-${count}`;
    await mkdir(folder);
    await writeFile(path.join(folder, "program.mjs"), file.text);
    await writeFile(path.join(folder, "wrapper.mjs"), wrapper);
    owned.add(name);
    let result;
    try {
      result = await docker(
        [
          "run",
          "--rm",
          "-i",
          "--name",
          name,
          "--label",
          `${label}=${attemptId}`,
          "--network",
          "none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user",
          "65534:65534",
          "--memory=128m",
          "--cpus=1",
          "--pids-limit=64",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16777216",
          "--mount",
          `type=bind,src=${folder},dst=/app,readonly`,
          serviceImages.node,
          "node",
          "/app/wrapper.mjs"
        ],
        {
          input: JSON.stringify({ unit, data }),
          timeout: 15_000,
          allowedCodes: [0, 1]
        }
      );
      serviceAssert(
        result.code === 0,
        "service-failed",
        `${unit} failed while running its sample program.`,
        "blocked"
      );
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new ServiceError(
          "result-unverified",
          "A sample returned unreadable output."
        );
      }
      serviceAssert(
        parsed.source === file.sha,
        "version-unverified",
        "Executed sample code differs from the requested Git blob."
      );
      return parsed.value;
    } finally {
      try {
        if (await owns(name))
          await docker(["rm", "--force", "--volumes", name]);
        owned.delete(name);
      } catch {
        // Keep ownership for final cleanup without replacing a program failure.
      }
    }
  }
  async function row() {
    const schema = Number(
      await sql(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='coordinator' AND table_name='items' AND column_name='display_value';"
      )
    )
      ? 2
      : 1;
    const values = (
      await sql(
        `SELECT id, value${schema === 2 ? ", display_value" : ""} FROM items ORDER BY id;`
      )
    ).split("\t");
    serviceAssert(
      values.length >= 2,
      "database-unverified",
      "The expected baseline row is missing."
    );
    return {
      id: Number(values[0]),
      value: Number(values[1]),
      ...(schema === 2
        ? { display_value: values[2] === "NULL" ? null : Number(values[2]) }
        : {})
    };
  }
  function expectedValue() {
    return (
      (10 +
        (plan.database.observed === "yes" ? candidate.change.increment : 0)) *
      2
    );
  }
  const api = {
    resources,
    async prepare() {
      for (const image of Object.values(serviceImages))
        await docker(["pull", image], { timeout: 180_000 });
      owned.add(mysql);
      await docker([
        "run",
        "--detach",
        "--name",
        mysql,
        "--label",
        `${label}=${attemptId}`,
        "--network",
        "none",
        "--memory=768m",
        "--cpus=1",
        "--tmpfs",
        "/var/lib/mysql:rw,size=536870912",
        "--tmpfs",
        "/var/run/mysqld:rw",
        "-e",
        "MYSQL_ROOT_PASSWORD=only-sandbox-data",
        "-e",
        "MYSQL_DATABASE=coordinator",
        serviceImages.mysql
      ]);
      // At most 20 * (3-second probe + 1-second pause), within the job limit.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await sql("SELECT 1;", 3000);
          dbReady = true;
          break;
        } catch {
          await wait(1000);
        }
      }
      serviceAssert(
        dbReady,
        "database-unavailable",
        "Temporary MySQL did not become ready."
      );
      await sql(`CREATE TABLE items (id INT PRIMARY KEY, value INT NOT NULL${baseline.schema.version === 2 ? ", display_value INT NULL" : ""});
        INSERT INTO items(id,value) VALUES(1,10);
        CREATE TABLE applied_changes (id VARCHAR(64) PRIMARY KEY);
        INSERT INTO applied_changes(id) VALUES('${baseline.change.id}');`);
      serviceAssert(
        (await row()).value === 10,
        "baseline-unverified",
        "The saved baseline data was not created correctly."
      );
      try {
        const worker = await program(
          "worker",
          plan.sources.backend.baseline["src/worker.mjs"],
          { row: await row() }
        );
        serviceAssert(
          worker?.value === 20,
          "baseline-unverified",
          "The unchanged baseline worker failed."
        );
        const payload = await program(
          "api",
          plan.sources.backend.baseline["src/api.mjs"],
          { row: { id: 1, value: 20, display_value: 20 } }
        );
        const rendered = await program(
          "frontend",
          plan.sources.frontend.baseline["src/render.mjs"],
          { payload }
        );
        serviceAssert(
          payload?.value === 20 && rendered === "Value: 20",
          "baseline-unverified",
          "The unchanged baseline application failed."
        );
      } catch {
        throw new ServiceError(
          "baseline-unverified",
          "The unchanged sample baseline failed; this is not attributed to the ticket."
        );
      }
      return {
        status: "passed",
        database: "temporary-mysql",
        schema_version: baseline.schema.version,
        row_count: 1,
        source: serviceHash(plan.sources.backend.baseline),
        images: serviceImages
      };
    },
    async run(step) {
      const result = { status: "passed", version: step.version };
      if (step.unit === "dbMigrationsLoop") {
        if (plan.database.observed === "no")
          return { ...result, change: "not-needed", state: await row() };
        if (candidate.schema.version > baseline.schema.version)
          await sql("ALTER TABLE items ADD COLUMN display_value INT NULL;");
        if (
          candidate.change.fail_after_schema &&
          candidate.schema.version > baseline.schema.version
        )
          throw new ServiceError(
            "database-step-failed",
            "Deliberate sample failure after the schema changed; dependent services stopped.",
            "blocked"
          );
        const apply = async () => {
          const prior = Number(
            await sql(
              `SELECT COUNT(*) FROM applied_changes WHERE id='${candidate.change.id}';`
            )
          );
          if (!prior)
            await sql(
              `START TRANSACTION; UPDATE items SET value=value+${candidate.change.increment}; INSERT INTO applied_changes(id) VALUES('${candidate.change.id}'); COMMIT;`
            );
          return prior ? "already-applied" : "applied";
        };
        const first = await apply(),
          repeated = await apply(),
          current = await row();
        serviceAssert(
          current.value === 10 + candidate.change.increment &&
            repeated === "already-applied",
          "database-step-failed",
          "The one-off database effect or retry check failed.",
          "blocked"
        );
        return {
          ...result,
          change: first,
          repeat: repeated,
          state: current,
          change_id: plan.database.change_id
        };
      }
      if (step.unit === "worker") {
        const value = await program(
          "worker",
          plan.sources.backend.files["src/worker.mjs"],
          { row: await row() }
        );
        serviceAssert(
          value?.id === 1 &&
            value.value === expectedValue() &&
            (candidate.schema.version !== 2 ||
              value.display_value === expectedValue()),
          "service-failed",
          "Worker returned the wrong calculated data.",
          "blocked"
        );
        await sql(
          `UPDATE items SET value=${value.value}${candidate.schema.version === 2 ? `,display_value=${value.display_value}` : ""} WHERE id=1;`
        );
        return { ...result, row: await row() };
      }
      if (step.unit === "api") {
        api.payload = await program(
          "api",
          plan.sources.backend.files["src/api.mjs"],
          { row: await row() }
        );
        serviceAssert(
          api.payload?.id === 1 && api.payload.value === expectedValue(),
          "service-failed",
          "API returned the wrong persisted data.",
          "blocked"
        );
        return { ...result, response: api.payload, transport: "http-loopback" };
      }
      const rendered = await program(
        "frontend",
        plan.sources.frontend.files["src/render.mjs"],
        { payload: api.payload }
      );
      serviceAssert(
        rendered === `Value: ${expectedValue()}`,
        "service-failed",
        "Frontend output does not match the actual API response.",
        "blocked"
      );
      return { ...result, rendered };
    },
    async inspect() {
      if (!dbReady) return { status: "unknown" };
      return {
        status: "verified",
        row: await row(),
        applied_changes: (
          await sql("SELECT id FROM applied_changes ORDER BY id;")
        ).split("\n")
      };
    },
    async cleanup() {
      for (const name of [...owned]) {
        if (await owns(name))
          await docker(["rm", "--force", "--volumes", name]);
        serviceAssert(
          !(await owns(name)),
          "cleanup-unverified",
          "A sample container remains after cleanup."
        );
        owned.delete(name);
      }
      await rm(directory, { recursive: true, force: true });
      return { status: "removed" };
    }
  };
  return api;
}

export async function runDockerServicePlan(
  plan,
  { attemptId, save, ...options }
) {
  const adapter = await createDockerServiceAdapter(plan, attemptId, options);
  return executeServiceSteps(plan, adapter, { attemptId, save });
}
