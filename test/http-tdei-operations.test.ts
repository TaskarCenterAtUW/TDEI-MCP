import { strict as assert } from "node:assert";
import test from "node:test";

import { HttpTdeiOperations } from "../src/adapters/http-tdei-operations.js";

test("HTTP adapter forwards request bearer and dataset filters", async () => {
  const requests: Request[] = [];
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(JSON.stringify([{ tdei_dataset_id: "dataset-1" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  const result = await adapter.searchDatasets({
    bbox: [-122.46, 47.48, -122.22, 47.74],
    dataType: "osw",
    status: "Publish",
    sortField: "uploaded_timestamp",
    sortOrder: "desc",
    page: 1,
    pageSize: 5,
  }, { accessToken: "bearer-A" });

  assert.deepEqual(result, [{ tdei_dataset_id: "dataset-1" }]);
  assert.equal(requests.length, 1);
  const request = requests[0] as Request;
  assert.equal(request.headers.get("Authorization"), "Bearer bearer-A");
  assert.equal(request.url, "https://api.example.test/api/v1/datasets?bbox=-122.46&bbox=47.48&bbox=-122.22&bbox=47.74&data_type=osw&status=Publish&sort_field=uploaded_timestamp&sort_order=desc&page_no=1&page_size=5");
});

test("HTTP adapter keeps service request tokens isolated", async () => {
  const authorizations: string[] = [];
  const adapter = new HttpTdeiOperations(
    "https://api.example.test/",
    async (input, init) => {
      const request = new Request(input, init);
      authorizations.push(request.headers.get("Authorization") ?? "");
      return new Response("[]", { status: 200 });
    },
  );
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
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        project_groups: [{ tdei_project_group_id: "group-1" }],
      }), { status: 200 });
    },
  );

  const groups = await adapter.listProjectGroups({
    page: 1,
    pageSize: 50,
  }, { accessToken: "bearer-A" });

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
      return new Response(JSON.stringify([
        { tdei_project_group_id: "group-1", project_group_name: "AA Viewer Internal" },
      ]), { status: 200 });
    },
    15_000,
    { tokenProvider: async () => "sso-token" },
  );

  const groups = await adapter.listProjectGroups({ page: 1, pageSize: 10 }, {});

  assert.equal(groups[0]?.project_group_name, "AA Viewer Internal");
  assert.equal(request?.headers.get("Authorization"), "Bearer sso-token");
});

test("HTTP adapter parses BOM and fenced JSON list bodies", async () => {
  const payload = [
    { tdei_project_group_id: "group-1", project_group_name: "AA Viewer Internal" },
  ];
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async () => new Response(
      `\uFEFF\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  const groups = await adapter.listProjectGroups(
    { page: 1, pageSize: 10 },
    { accessToken: "bearer-A" },
  );
  assert.deepEqual(groups, payload);
});

test("HTTP adapter submits inline validation assets as multipart", async () => {
  let request: Request | undefined;
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async (input, init) => {
      request = new Request(input, init);
      return new Response("validation-job", {
        status: 202,
        headers: { Location: "/api/v1/jobs/validation-job" },
      });
    },
  );
  const job = await adapter.validateDataset({
    dataType: "osw",
    asset: {
      kind: "inline_base64",
      name: "dataset.zip",
      mediaType: "application/zip",
      data: "UEsDBA==",
    },
  }, { accessToken: "bearer-A" });

  assert.deepEqual(job, {
    jobId: "validation-job",
    location: "/api/v1/jobs/validation-job",
  });
  assert.equal(request?.url, "https://api.example.test/api/v1/osw/validate");
  assert.equal(request?.headers.get("Authorization"), "Bearer bearer-A");
  const form = await request?.formData();
  const dataset = form?.get("dataset");
  assert.ok(dataset instanceof File);
  assert.equal(dataset.name, "dataset.zip");
});

test("HTTP adapter uploads dataset and metadata to the selected target", async () => {
  let request: Request | undefined;
  const adapter = new HttpTdeiOperations(
    "https://api.example.test",
    async (input, init) => {
      request = new Request(input, init);
      return new Response("upload-job", { status: 202 });
    },
  );
  const asset = {
    kind: "inline_base64" as const,
    name: "dataset.zip",
    mediaType: "application/zip",
    data: "UEsDBA==",
  };
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
  const job = await adapter.uploadDataset({
    dataType: "pathways",
    asset,
    projectGroupId: "group 1",
    serviceId: "service/1",
    metadata,
    derivedFromDatasetId: "source-1",
  }, { accessToken: "bearer-A" });

  assert.equal(job.jobId, "upload-job");
  assert.equal(request?.url, "https://api.example.test/api/v1/gtfs-pathways/upload/group%201/service%2F1?derived_from_dataset_id=source-1");
  const form = await request?.formData();
  assert.ok(form?.get("dataset") instanceof File);
  const metadataFile = form?.get("metadata");
  assert.ok(metadataFile instanceof File);
  assert.deepEqual(JSON.parse(await metadataFile.text()), metadata);
});
