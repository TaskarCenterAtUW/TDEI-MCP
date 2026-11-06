import assert from "node:assert/strict";
import test from "node:test";

import { assertSafeShellPath, buildClientDownloadCurl } from "../src/adapters/binary-tdei-downloads.js";
import { DirectMultipartTdeiMutations } from "../src/adapters/direct-multipart-tdei-mutations.js";
import { SemanticIntentModule, type TdeiOperations } from "../src/intents/semantic-intent-module.js";

test("download and upload paths cannot break out of the quoted curl command", async () => {
  for (const bad of ['/tmp/a".zip', "/tmp/$(rm -rf ~).zip", "/tmp/`id`.zip", "/tmp/a\n.zip"]) {
    assert.throws(() => assertSafeShellPath(bad, "path"), /Unsafe/);
    assert.throws(() => buildClientDownloadCurl("https://x.test/a", "t", bad), /Unsafe/);
  }
  // Plain variables and spaces stay valid: the default folder is $HOME/Downloads.
  assert.doesNotThrow(() => buildClientDownloadCurl("https://x.test/a", "t", "$HOME/Downloads/My Data.zip"));

  const mutations = new DirectMultipartTdeiMutations({ baseUrl: "https://api.example.test" });
  await assert.rejects(
    mutations.validateDataset(
      { dataType: "osw", asset: { kind: "local_path", path: "/tmp/$(whoami).zip" } },
      { accessToken: "t" },
    ),
    /Unsafe/,
  );
  const ok = await mutations.validateDataset(
    { dataType: "osw", asset: { kind: "local_path", path: "/Users/me/my data/file.zip" } },
    { accessToken: "t" },
  );
  assert.match(ok.curlCommand, /dataset=@\/Users\/me\/my data\/file\.zip/);
});

class CountingOps implements TdeiOperations {
  calls: Record<string, number> = {};
  private bump(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }
  async searchDatasets() {
    return [];
  }
  async listServices() {
    return [];
  }
  async listProjectGroups() {
    return [];
  }
  async listJobs() {
    return [];
  }
  // Methods that rely on `this` must keep it when the module calls them.
  async listVersions(input: { dataType: string }) {
    this.bump(`versions:${input.dataType}`);
    return [`v-${input.dataType}`];
  }
  async getCapabilities() {
    this.bump("capabilities");
    return { max: 1 };
  }
  async listApiVersions() {
    this.bump("apiVersions");
    return ["v1"];
  }
}

test("versions and system info are fetched once per token, in parallel", async () => {
  const ops = new CountingOps();
  const module = new SemanticIntentModule({
    operations: ops as unknown as TdeiOperations,
    places: { forwardGeocode: async () => [] },
  });
  const first = await module.listVersions({}, { accessToken: "a" });
  await module.listVersions({}, { accessToken: "a" });
  await module.getSystemInfo({ accessToken: "a" });
  await module.getSystemInfo({ accessToken: "a" });
  assert.equal(first.status, "complete");
  if (first.status === "complete")
    assert.deepEqual(first.data.versions, { osw: ["v-osw"], flex: ["v-flex"], pathways: ["v-pathways"] });
  assert.deepEqual(ops.calls, {
    "versions:osw": 1,
    "versions:flex": 1,
    "versions:pathways": 1,
    capabilities: 1,
    apiVersions: 1,
  });
  await module.listVersions({}, { accessToken: "b" });
  assert.equal(ops.calls["versions:osw"], 2, "another token must not read the first token's cache");
});

test("checkDatasetIncline still returns the runbook when the dataset lookup fails", async () => {
  const module = new SemanticIntentModule({
    operations: {
      searchDatasets: async () => {
        throw new Error("upstream down");
      },
      listServices: async () => [],
      listProjectGroups: async () => [],
      listJobs: async () => [],
    },
    places: { forwardGeocode: async () => [] },
    apiUrl: "https://api.example.test",
  });
  const result = await module.checkDatasetIncline(
    { tdeiDatasetId: "80296cbe-53ac-463b-b5f6-dad8b8e5e788" },
    { accessToken: "t" },
  );
  assert.equal(result.status, "complete");
});
