import {
  blobHash,
  serviceHash,
  serviceProtocol
} from "../src/service-contract.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const sampleFiles = () => ({
  backend: {
    "src/config/deploy-services.json": json({
      services: [
        {
          name: "api",
          allowed_environments: ["staging", "prod"],
          default_dependencies: ["worker"]
        },
        {
          name: "worker",
          allowed_environments: ["staging", "prod"],
          default_dependencies: ["dbMigrationsLoop"]
        },
        {
          name: "dbMigrationsLoop",
          allowed_environments: ["staging"],
          default_dependencies: []
        }
      ]
    }),
    "src/entities/item.json": json({ version: 1 }),
    "src/data/change.json": json({
      id: "baseline",
      increment: 0,
      fail_after_schema: false
    }),
    "src/worker.mjs":
      "export function run({ row }) { return { id: row.id, value: row.value * 2 }; }\n",
    "src/api.mjs":
      "export function run({ row }) { return { id: row.id, value: row.value }; }\n"
  },
  frontend: {
    "src/render.mjs":
      "export function run({ payload }) { return `Value: ${payload.value}`; }\n"
  }
});
export const databaseCandidate = () => {
  const files = sampleFiles();
  files.backend["src/entities/item.json"] = json({ version: 2 });
  files.backend["src/data/change.json"] = json({
    id: "add-display-value",
    increment: 5,
    fail_after_schema: false
  });
  files.backend["src/worker.mjs"] =
    "export function run({ row }) { return { id: row.id, value: row.value * 2, display_value: row.value * 2 }; }\n";
  files.backend["src/api.mjs"] =
    "export function run({ row }) { return { id: row.id, value: row.display_value }; }\n";
  return files;
};
export const sourceFiles = (files) =>
  Object.fromEntries(
    Object.entries(files).map(([name, text]) => [
      name,
      { text, sha: blobHash(text) }
    ])
  );

// Developer/normal-PR fixture only. Never accepted as an inbox request or imported report.
export function fixtureServicePlan(
  files = sampleFiles(),
  baseline = sampleFiles()
) {
  const sources = {};
  for (const [role, id] of [
    ["backend", 1362505082],
    ["frontend", 1362504370]
  ])
    sources[role] = {
      repository: {
        id,
        full_name: `6529-Collections/release-coordinator-test-${role}`
      },
      base_commit: "a".repeat(40),
      tree: "b".repeat(40),
      baseline: sourceFiles(baseline[role]),
      files: sourceFiles(files[role])
    };
  const before = {
    schema: JSON.parse(baseline.backend["src/entities/item.json"]),
    change: JSON.parse(baseline.backend["src/data/change.json"])
  };
  const after = {
    schema: JSON.parse(files.backend["src/entities/item.json"]),
    change: JSON.parse(files.backend["src/data/change.json"])
  };
  const answer = serviceHash(before) === serviceHash(after) ? "no" : "yes";
  const contents = {
    protocol: serviceProtocol,
    profile: "sandbox",
    target: "staging",
    input_source: "developer-fixture",
    database: {
      declared: answer,
      observed: answer,
      change_id: serviceHash({ before, after })
    },
    sources,
    steps: [
      {
        unit: "dbMigrationsLoop",
        role: "backend",
        depends_on: [],
        version: serviceHash(after)
      },
      {
        unit: "worker",
        role: "backend",
        depends_on: ["dbMigrationsLoop"],
        version: sources.backend.files["src/worker.mjs"].sha
      },
      {
        unit: "api",
        role: "backend",
        depends_on: ["worker"],
        version: sources.backend.files["src/api.mjs"].sha
      },
      {
        unit: "frontend",
        role: "frontend",
        depends_on: ["api"],
        version: sources.frontend.files["src/render.mjs"].sha
      }
    ]
  };
  return { ...contents, fingerprint: serviceHash(contents) };
}
