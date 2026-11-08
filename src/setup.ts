import { runSetup } from "./setup/cli.js";
import { SetupUsageError } from "./setup/errors.js";
import { npxSetupCommand } from "./setup/targets.js";

// `tdei-mcp setup ...` entry point (remote connectors only; `init` is unchanged).
try {
  process.exitCode = await runSetup(process.argv.slice(3));
} catch (error) {
  if (error instanceof SetupUsageError) {
    console.error(`Error: ${error.message}`);
    console.error(`\nRun '${npxSetupCommand()} --help' to see all options.`);
    process.exitCode = 2;
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
