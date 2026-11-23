import { runDoctor } from "./setup/doctor.js";

// `tdei-mcp doctor [--fix]` entry point.
process.exitCode = await runDoctor(process.argv.slice(3));
