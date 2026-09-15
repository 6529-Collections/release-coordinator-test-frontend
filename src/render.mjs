export function run({ payload }) {
  const value = Number(payload.value);
  return `Value: ${value}`;
}
