import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { BinaryTdeiDownloads } from "../src/adapters/binary-tdei-downloads.js";
import { DirectMultipartTdeiMutations } from "../src/adapters/direct-multipart-tdei-mutations.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

const run = promisify(execFile);

// Hands-free contract for upload + download:
// - curl runs on the CLIENT machine directly against the TDEI backend
//   (gateway is never a relay, no server fetch, no server disk)
// - the caller's own bearer is embedded (responses go only to that caller),
//   so the assistant can execute the command at once with no export step
// - the command is a single line: no heredoc, no temp file, no script file
// - the assistant executes it itself via its shell tool (no human step)

const nastyMetadata = {
  dataset_detail: {
    name: "O'Brien; test",
    version: "1.0",
    collected_by: "Data;Wizard's",
    collection_date: "2026-11-12",
    data_source: "TDEITools" as const,
    schema_version: "v0.3",
    description: "a;b,c 'q' \"d\" \\ e",
  },
};

test("download curl embeds the caller's bearer and is directive", async () => {
  const download = new BinaryTdeiDownloads({ baseUrl: "https://api-dev.tdei.us" });
  const out = await download.download("getOswFile", { tdei_dataset_id: "id-1" }, { accessToken: "caller-token-xyz" });

  assert.ok(out.curlCommand.includes("Bearer caller-token-xyz"));
  assert.match(out.instruction, /Execute this now/);
  assert.match(out.instruction, /do not ask the user/);
  assert.match(out.instruction, /already embedded/);
  assert.match(out.instruction, /gateway is not a relay/);
});

test("download curl falls back to $TDEI_TOKEN only when no token exists", async () => {
  const download = new BinaryTdeiDownloads({ baseUrl: "https://api-dev.tdei.us" });
  const out = await download.download("getOswFile", { tdei_dataset_id: "id-1" });
  assert.ok(out.curlCommand.includes("Bearer $TDEI_TOKEN"));
});

test("upload curl is one line with the bearer and survives quotes and semicolons", async () => {
  const mutations = new DirectMultipartTdeiMutations({ baseUrl: "https://api-dev.tdei.us" });
  const out = await mutations.uploadDataset(
    {
      dataType: "osw",
      asset: { kind: "local_path", path: "/Users/me/Downloads/odot_osw.zip" },
      projectGroupId: "pg-1",
      serviceId: "svc-1",
      metadata: nastyMetadata,
    },
    { accessToken: "caller-token-xyz" },
  );

  assert.equal(out.curlCommand.includes("\n"), false);
  assert.equal(out.curlCommand.includes("mktemp"), false);
  assert.ok(out.curlCommand.includes("Bearer caller-token-xyz"));
  assert.match(out.curlCommand, /HTTP_STATUS/);
  assert.match(out.instruction, /Execute this now/);
  assert.match(out.instruction, /do not save it to a script file/);
});

test("validate curl has HTTP status trailer and the caller's bearer", async () => {
  const mutations = new DirectMultipartTdeiMutations({ baseUrl: "https://api-dev.tdei.us" });
  const out = await mutations.validateDataset(
    { dataType: "osw", asset: { kind: "local_path", path: "/Users/me/Downloads/a.zip" } },
    { accessToken: "caller-token-xyz" },
  );

  assert.ok(out.curlCommand.includes("Bearer caller-token-xyz"));
  assert.match(out.curlCommand, /HTTP_STATUS/);
  assert.match(out.curlCommand, /--fail-with-body/);
  assert.match(out.instruction, /Execute this now/);
});

test("semantic downloadDataset defaults to $HOME/Downloads with the caller's bearer", async () => {
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [];
      },
      async listJobs() {
        return [];
      },
    } as never,
    places: {
      async forwardGeocode() {
        return [];
      },
    },
    apiUrl: "https://api-dev.tdei.us",
  });

  const result = await module.downloadDataset(
    { tdeiDatasetId: "80296cbe-53ac-463b-b5f6-dad8b8e5e788", dataType: "osw" },
    { accessToken: "caller-token-xyz" },
  );
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error("expected complete");
  assert.ok(result.data.filePath.startsWith("$HOME/Downloads/"));
  assert.ok(result.data.curlCommand?.includes("Bearer caller-token-xyz"));
  assert.match(result.data.instruction, /Execute this now/);
  assert.match(result.data.instruction, /\$HOME\/Downloads/);
});

test("generated upload curl actually runs in a shell and delivers file, bearer and metadata intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-upload-"));
  const zipPath = join(dir, "odot_osw.zip");
  writeFileSync(zipPath, "PK-fake-zip-bytes");

  const seen: { auth?: string; url?: string; body: string } = { body: "" };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen.auth = req.headers.authorization;
      seen.url = req.url;
      seen.body = Buffer.concat(chunks).toString("utf-8");
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job_id: "123" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const mutations = new DirectMultipartTdeiMutations({ baseUrl: `http://127.0.0.1:${port}` });
    const out = await mutations.uploadDataset(
      {
        dataType: "osw",
        asset: { kind: "local_path", path: zipPath },
        projectGroupId: "pg-1",
        serviceId: "svc-1",
        metadata: nastyMetadata,
      },
      { accessToken: "caller-token-xyz" },
    );

    // Run it exactly as an assistant's shell tool would: one command string, no export.
    const { stdout } = await run("bash", ["-c", out.curlCommand], { env: { PATH: process.env.PATH ?? "" } });

    assert.match(stdout, /HTTP_STATUS:202/);
    assert.equal(seen.auth, "Bearer caller-token-xyz");
    assert.equal(seen.url, "/api/v1/osw/upload/pg-1/svc-1");
    assert.ok(seen.body.includes("PK-fake-zip-bytes"));
    const metaPart = /name="metadata"[^\r\n]*\r\nContent-Type: application\/json\r\n\r\n([^\r]*)\r\n/.exec(seen.body);
    assert.ok(metaPart, "metadata part present as application/json");
    assert.deepEqual(JSON.parse(metaPart[1] as string), nastyMetadata);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generated download curl runs in a shell and writes the file to the target folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-dl-"));
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(200, { "Content-Type": "application/zip" });
    res.end("ZIPDATA");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const module = new SemanticIntentModule({
      operations: {} as never,
      places: {
        async forwardGeocode() {
          return [];
        },
      },
      apiUrl: `http://127.0.0.1:${port}`,
    });
    const result = await module.downloadDataset(
      { tdeiDatasetId: "80296cbe-53ac-463b-b5f6-dad8b8e5e788", dataType: "osw", outputDir: dir },
      { accessToken: "caller-token-xyz" },
    );
    if (result.status !== "complete") throw new Error("expected complete");
    const { stdout } = await run("bash", ["-c", result.data.curlCommand as string], {
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.match(stdout, /HTTP_STATUS:200/);
    assert.equal(auth, "Bearer caller-token-xyz");
    assert.ok(result.data.filePath.startsWith(dir));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
