import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TdeiOperations } from "../src/intents/operations.js";
import type { PlaceResolver } from "../src/intents/place-resolver.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";
import { resolveDownloadSettings, saveDatasetToDisk } from "../src/intents/server-download.js";

const UUID = "7d6ae05c-8928-4727-bb0d-4717e46242f1";
const BEARER = "secret-bearer-token-xyz";
const API = "https://api.example.test";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tdei-dl-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("download mode defaults to client", () => {
  const r = resolveDownloadSettings({}, "http", "127.0.0.1");
  assert.equal(r.settings.mode, "client");
  assert.deepEqual(r.warnings, []);
});

test("server mode is allowed on stdio and loopback, refused on a public bind", () => {
  assert.equal(resolveDownloadSettings({ TDEI_DOWNLOAD_MODE: "server" }, "stdio", "0.0.0.0").settings.mode, "server");
  assert.equal(resolveDownloadSettings({ TDEI_DOWNLOAD_MODE: "server" }, "http", "127.0.0.1").settings.mode, "server");
  const refused = resolveDownloadSettings({ TDEI_DOWNLOAD_MODE: "server" }, "http", "0.0.0.0");
  assert.equal(refused.settings.mode, "client");
  assert.equal(refused.warnings.length, 1);
});

test("invalid mode and relative dir fall back with warnings", () => {
  const r = resolveDownloadSettings({ TDEI_DOWNLOAD_MODE: "bogus", TDEI_DOWNLOAD_DIR: "relative/dir" }, "stdio", "");
  assert.equal(r.settings.mode, "client");
  assert.equal(r.warnings.length, 2);
});

test("saveDatasetToDisk streams the body to disk with the bearer header", async () => {
  await withTempDir(async (dir) => {
    let seenAuth = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(new Uint8Array([80, 75, 3, 4, 1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    const saved = await saveDatasetToDisk({ url: `${API}/x`, bearer: BEARER, dir, filename: "a.zip", fetchImpl });

    assert.equal(seenAuth, `Bearer ${BEARER}`);
    assert.equal(saved.bytes, 7);
    assert.equal(saved.httpStatus, 200);
    assert.deepEqual([...(await readFile(saved.filePath))], [80, 75, 3, 4, 1, 2, 3]);
    assert.deepEqual(await readdir(dir), ["a.zip"]);
  });
});

test("a failed download leaves no partial file and does not echo the bearer", async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    await assert.rejects(
      saveDatasetToDisk({ url: `${API}/x`, bearer: BEARER, dir, filename: "a.zip", fetchImpl }),
      (err: Error) => {
        assert.match(err.message, /HTTP 403/);
        assert.ok(!err.message.includes(BEARER));
        return true;
      },
    );
    assert.deepEqual(await readdir(dir), []);
  });
});

test("server mode saves the ZIP and omits the curl command and token from the result", async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;
    const module = new SemanticIntentModule({
      operations: {} as unknown as TdeiOperations,
      places: {} as unknown as PlaceResolver,
      apiUrl: API,
      downloadSettings: { mode: "server", serverDir: dir },
      fetchImpl,
    });

    const result = await module.downloadDataset({ tdeiDatasetId: UUID, dataType: "osw" }, { accessToken: BEARER });

    assert.equal(result.status, "complete");
    if (result.status !== "complete") return;
    assert.equal(result.data.curlCommand, undefined);
    assert.equal(result.data.bytes, 3);
    assert.ok(result.data.savedTo?.startsWith(dir));
    assert.deepEqual(await readdir(dir), [`${UUID}.zip`]);
    assert.ok(!JSON.stringify(result).includes(BEARER));
  });
});

test("server mode without a sign-in asks for tdei_sso_login and does not fetch", async () => {
  let fetched = false;
  const module = new SemanticIntentModule({
    operations: {} as unknown as TdeiOperations,
    places: {} as unknown as PlaceResolver,
    apiUrl: API,
    downloadSettings: { mode: "server", serverDir: join(tmpdir(), "unused") },
    fetchImpl: (async () => {
      fetched = true;
      return new Response("");
    }) as typeof fetch,
  });

  const result = await module.downloadDataset({ tdeiDatasetId: UUID, dataType: "osw" }, {});

  assert.equal(result.status, "needs_input");
  assert.equal(fetched, false);
});
