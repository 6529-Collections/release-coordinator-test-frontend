export function run({ payload }) {
  const value = Number(payload.value);
  if (
    import.meta.url.includes("/dist/") &&
    process.env.SELECTED_PACK === "all"
  )
    return `Controlled E2E failure: ${value}`;
  return `Value: ${value}`;
}
