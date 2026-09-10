export function run({ payload }) { if (payload.batch_flag) throw new Error('Controlled A+B incompatibility'); return `Value: ${payload.value}`; }
