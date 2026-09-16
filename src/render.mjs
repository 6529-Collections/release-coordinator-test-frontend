export function run({ payload }) {
  const value = Number(payload.value);
  // Controlled sandbox fault: only the fake-production matching E2E fails.
  const operation = process.env.OPERATION_JSON
    ? JSON.parse(process.env.OPERATION_JSON)
    : null;
  if (operation?.environment === "prod" && operation.operation === "e2e")
    return `Value: ${value + 1}`;
  return `Value: ${value}`;
}
