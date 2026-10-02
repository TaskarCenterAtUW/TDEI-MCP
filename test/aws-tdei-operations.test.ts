import { strict as assert } from "node:assert";
import test from "node:test";

import { AwsTdeiOperations } from "../src/adapters/aws-tdei-operations.js";

test("AWS adapter maps dataset search and decodes MCP text content", async () => {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const adapter = new AwsTdeiOperations(async (tool, input) => {
    calls.push({ tool, input });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ datasets: [{ tdei_dataset_id: "dataset-1" }] }),
      }],
    };
  });

  const datasets = await adapter.searchDatasets({
    city: "Seattle",
    dataType: "osw",
    status: "All",
    sortField: "uploaded_timestamp",
    sortOrder: "desc",
    page: 1,
    pageSize: 10,
  }, {});

  assert.deepEqual(calls, [{
    tool: "listDatasetFiles",
    input: {
      city: "Seattle",
      data_type: "osw",
      status: "All",
      sort_field: "uploaded_timestamp",
      sort_order: "desc",
      page_no: 1,
      page_size: 10,
    },
  }]);
  assert.deepEqual(datasets, [{ tdei_dataset_id: "dataset-1" }]);
});

test("AWS adapter maps service filters", async () => {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const adapter = new AwsTdeiOperations(async (tool, input) => {
    calls.push({ tool, input });
    return [{ tdei_service_id: "service-1" }];
  });

  const services = await adapter.listServices({
    projectGroupId: "group-1",
    serviceType: "pathways",
    page: 2,
    pageSize: 20,
  }, {});

  assert.deepEqual(calls, [{
    tool: "listServices",
    input: {
      tdei_project_group_id: "group-1",
      service_type: "pathways",
      page_no: 2,
      page_size: 20,
    },
  }]);
  assert.deepEqual(services, [{ tdei_service_id: "service-1" }]);
});

test("AWS adapter maps authenticated project-group listing", async () => {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const adapter = new AwsTdeiOperations(async (tool, input) => {
    calls.push({ tool, input });
    return [{ tdei_project_group_id: "group-1" }];
  });

  const groups = await adapter.listProjectGroups({
    searchText: "Seattle",
    page: 1,
    pageSize: 50,
  }, {});

  assert.deepEqual(calls, [{
    tool: "listProjectGroups",
    input: { searchText: "Seattle", page_no: 1, page_size: 50 },
  }]);
  assert.deepEqual(groups, [{ tdei_project_group_id: "group-1" }]);
});
