// Keep tests from scaffolding tdei.config.json into the repo checkout.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TDEI_CONFIG_PATH ??= join(mkdtempSync(join(tmpdir(), "tdei-test-")), "tdei.config.json");
