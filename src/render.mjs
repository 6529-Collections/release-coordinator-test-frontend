export function run({ payload }) {
  const value = Number(payload.value);
  return `Value: ${value}`;
}

// This second commit exercises recovery with a new immutable request.
