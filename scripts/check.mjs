import { existsSync } from "node:fs";
if (existsSync("FAIL_CHECK")) throw new Error("Deliberate sandbox CI failure");
console.log("Sandbox sample check passed");
