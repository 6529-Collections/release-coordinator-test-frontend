export function run({ payload }) {
  const value = Number(payload.value);
  if (import.meta.url.includes("/dist/") && "id" in payload)
    return `Controlled E2E failure: ${value}`;
  return `Value: ${value}`;
}
