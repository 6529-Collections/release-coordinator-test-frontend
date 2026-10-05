export function run({ payload }) {
  const value = Number(payload.value);
  // Deliberate test-only failure after a successful exact staging deployment.
  // PR/service/build checks and fake production retain their normal result.
  if (
    process.env.GITHUB_WORKFLOW === "Staging E2E" &&
    process.env.SELECTED_PACK
  )
    return `Workflow-wait acceptance E2E failure: ${value}`;
  if (import.meta.url.includes("/dist/") && "id" in payload)
    return `Controlled E2E failure: ${value}`;
  return `Value: ${value}`;
}
