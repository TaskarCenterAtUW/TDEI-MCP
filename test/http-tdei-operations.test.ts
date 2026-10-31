import { strict as assert } from "node:assert";
import test from "node:test";

import { HttpTdeiOperations } from "../src/adapters/http-tdei-operations.js";

test("HTTP adapter forwards request bearer and dataset filters", async () => {
  const requests: Request[] = [];
  const adapter = new HttpTdeiOperations("https://api.example.test", async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Response(JSON.stringify([{ tdei_dataset_id: "dataset-1" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await adapter.searchDatasets(
    {
      bbox: [-122.46, 47.48, -122.22, 47.74],
      dataType: "osw",
      status: "Publish",
      sortField: "uploaded_timestamp",
      sortOrder: "desc",
      page: 1,
      pageSize: 5,
    },
    { accessToken: "bearer-A" },
  );

  assert.deepEqual(result, [{ tdei_dataset_id: "dataset-1" }]);
  assert.equal(requests.length, 1);
  const request = requests[0] as Request;
  assert.equal(request.headers.get("Authorization"), "Bearer bearer-A");
  assert.equal(
    request.url,
    "https://api.example.test/api/v1/datasets?bbox=-122.46&bbox=47.48&bbox=-122.22&bbox=47.74&data_type=osw&status=Publish&sort_field=uploaded_timestamp&sort_order=desc&page_no=1&page_size=5",
  );
});

test("HTTP adapter keeps service request tokens isolated", async () => {
  const authorizations: string[] = [];
  const adapter = new HttpTdeiOperations("https://api.example.test/", async (input, init) => {
    const request = new Request(input, init);
    authorizations.push(request.headers.get("Authorization") ?? "");
    return new Response("[]", { status: 200 });
  });
  const search = {
    serviceType: "all" as const,
    page: 1,
    pageSize: 10,
  };

  await adapter.listServices(search, { accessToken: "bearer-A" });
  await adapter.listServices(search, { accessToken: "bearer-B" });

  assert.deepEqual(authorizations, ["Bearer bearer-A", "Bearer bearer-B"]);
});

test("HTTP adapter falls back to authenticated project-groups endpoint", async () => {
  let request: Request | undefined;
  const adapter = new HttpTdeiOperations("https://api.example.test", async (input, init) => {
    request = new Request(input, init);
    return new Response(
      JSON.stringify({
        project_groups: [{ tdei_project_group_id: "group-1" }],
      }),
      { status: 200 },
    );
  });

  const groups = await adapter.listProjectGroups(
    {
      page: 1,
      pageSize: 50,
    },
    { accessToken: "bearer-A" },
  );

  assert.deepEqual(groups, [{ tdei_project_group_id: "group-1" }]);
  assert.equal(request?.headers.get("Authorization"), "Bearer bearer-A");
  assert.equal(request?.url, "https://api.example.test/api/v1/project-groups?page_no=1&page_size=50");
});

test("HTTP adapter uses tokenProvider when request context has no bearer", async () => {
  let request: Request | undefined;
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async (input, init) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify([{ tdei_project_group_id: "group-1", project_group_name: "AA Viewer Internal" }]),
        { status: 200 },
      );
    },
    15_000,
    { tokenProvider: async () => "sso-token" },
  );

  const groups = await adapter.listProjectGroups({ page: 1, pageSize: 10 }, {});

  assert.equal(groups[0]?.project_group_name, "AA Viewer Internal");
  assert.equal(request?.headers.get("Authorization"), "Bearer sso-token");
});

test("HTTP adapter parses BOM and fenced JSON list bodies", async () => {
  const payload = [{ tdei_project_group_id: "group-1", project_group_name: "AA Viewer Internal" }];
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async () =>
      new Response(`\uFEFF\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  const groups = await adapter.listProjectGroups({ page: 1, pageSize: 10 }, { accessToken: "bearer-A" });
  assert.deepEqual(groups, payload);
});

test("HTTP adapter validate returns a client-side curl instruction without fetching", async () => {
  let calls = 0;
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async () => {
      calls += 1;
      return new Response("must not fetch bytes", { status: 500 });
    },
    15_000,
  );
  const instruction = await adapter.validateDataset(
    {
      dataType: "osw",
      asset: { kind: "local_path", path: "/Users/tester/data/dataset.zip" },
    },
    { accessToken: "bearer-A" },
  );

  assert.equal(instruction.apiOperation, "validateDataset");
  assert.equal(instruction.method, "POST");
  assert.equal(instruction.path, "/api/v1/osw/validate");
  assert.match(
    instruction.curlCommand,
    /curl -X POST "https:\/\/api\.example\.test\/api\/v1\/osw\/validate" -H "Authorization: Bearer bearer-A" -F "dataset=@\/Users\/tester\/data\/dataset\.zip"/,
  );
  assert.match(instruction.instruction, /already embedded/);
  assert.equal(calls, 0);
});

test("HTTP adapter upload returns curl with inline metadata and encoded target", async () => {
  let calls = 0;
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async () => {
      calls += 1;
      return new Response("must not fetch bytes", { status: 500 });
    },
    15_000,
  );
  const metadata = {
    dataset_detail: {
      name: "Seattle OSW",
      version: "1.0",
      collected_by: "City of Seattle",
      collection_date: "2026-09-01",
      data_source: "InHouse" as const,
      schema_version: "0.3",
    },
  };
  const instruction = await adapter.uploadDataset(
    {
      dataType: "pathways",
      asset: { kind: "local_path", path: "/Users/tester/data/upload.zip" },
      projectGroupId: "group 1",
      serviceId: "service/1",
      metadata,
      derivedFromDatasetId: "source-1",
      changeset: { kind: "local_path", path: "/Users/tester/data/change.osc" },
    },
    { accessToken: "bearer-A" },
  );

  assert.equal(instruction.apiOperation, "uploadDataset");
  assert.equal(instruction.path, "/api/v1/gtfs-pathways/upload/group%201/service%2F1");
  assert.ok(instruction.curlCommand.includes("derived_from_dataset_id=source-1"));
  assert.ok(instruction.curlCommand.includes('-F "dataset=@/Users/tester/data/upload.zip"'));
  assert.ok(instruction.curlCommand.includes(`-F 'metadata=${JSON.stringify(metadata)};type=application/json'`));
  assert.ok(instruction.curlCommand.includes('-F "changeset=@/Users/tester/data/change.osc"'));
  assert.ok(instruction.curlCommand.includes("Bearer bearer-A"));
  assert.equal(calls, 0);
});

test("HTTP adapter upload falls back to the token provider and then $TDEI_TOKEN", async () => {
  const calls: number[] = [];
  const withProvider = new HttpTdeiOperations(
    "https://api.example.test",
    async () => {
      calls.push(1);
      return new Response("must not fetch", { status: 500 });
    },
    15_000,
    { tokenProvider: async () => "provider-token" },
  );
  const viaProvider = await withProvider.validateDataset(
    { dataType: "flex", asset: { kind: "local_path", path: "/data/flex.zip" } },
    {},
  );
  assert.ok(viaProvider.curlCommand.includes("Bearer provider-token"));
  assert.match(viaProvider.instruction, /already embedded/);

  const withoutToken = new HttpTdeiOperations("https://api.example.test");
  const viaPlaceholder = await withoutToken.validateDataset(
    { dataType: "flex", asset: { kind: "local_path", path: "/data/flex.zip" } },
    {},
  );
  assert.ok(viaPlaceholder.curlCommand.includes("Bearer $TDEI_TOKEN"));
  assert.match(viaPlaceholder.instruction, /sign in via tdei_sso_login first/);
});

test("HTTP adapter refuses non-local assets and guides to curl", async () => {
  const adapter = new HttpTdeiOperations("https://api.example.test");
  await assert.rejects(
    () =>
      adapter.validateDataset(
        {
          dataType: "osw",
          asset: { kind: "inline_base64", name: "dataset.zip", mediaType: "application/zip", data: "UEsDBA==" },
        },
        { accessToken: "bearer-A" },
      ),
    /must be a local_path asset/,
  );
});

test("HTTP adapter rejects unsupported upload file extensions without fetching", async () => {
  let attempts = 0;
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async () => {
      attempts += 1;
      return new Response("must not fetch", { status: 500 });
    },
    15_000,
  );

  await assert.rejects(
    () =>
      adapter.validateDataset(
        {
          dataType: "osw",
          asset: { kind: "local_path", path: "/tmp/malware.sh" },
        },
        { accessToken: "bearer-A" },
      ),
    /Unsupported dataset file extension "\.sh"/,
  );
  assert.equal(attempts, 0);
});

test("HTTP adapter rejects relative client paths without fetching", async () => {
  let attempts = 0;
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async () => {
      attempts += 1;
      return new Response("must not fetch", { status: 500 });
    },
    15_000,
  );
  await assert.rejects(
    () =>
      adapter.uploadDataset(
        {
          dataType: "osw",
          asset: { kind: "local_path", path: "relative/dataset.zip" },
          projectGroupId: "group-1",
          serviceId: "service-1",
          metadata: { dataset_detail: { name: "x" } },
        },
        { accessToken: "bearer-A" },
      ),
    /must be absolute on the CLIENT machine/,
  );
  assert.equal(attempts, 0);
});
