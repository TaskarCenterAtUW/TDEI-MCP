import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerOpenApiTools, type OpenApiToolClient } from "../src/openapi/register-openapi-tools.js";
import { augmentTdeiToolDescription, TDEI_TOOL_INSTRUCTIONS } from "../src/tdei/tool-instructions.js";

function fakeClient(names: string[]): OpenApiToolClient {
  return {
    async listTools() {
      return {
        tools: names.map((name) => ({
          name,
          description: `raw ${name}`,
          inputSchema: { type: "object", properties: {} },
        })),
      };
    },
    async callTool() {
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
}

test("TDEI instructions are appended to the matching raw tool descriptions", async () => {
  const server = new McpServer({ name: "tool-instructions", version: "1.0.0" });
  await registerOpenApiTools(server, fakeClient(["validateOswFile", "oswQualityReportGenerate", "job_download"]), {
    augmentDescription: augmentTdeiToolDescription,
  });
  const client = new Client({ name: "tool-instructions-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool.description ?? ""]));

    const validate = byName.get("validateOswFile") ?? "";
    assert.match(validate, /raw validateOswFile/);
    assert.match(validate, /-F "dataset=@\/path\/to\/file\.zip"/);
    assert.match(validate, /tdei_list_jobs/);
    assert.match(validate, /\/api\/v1\/job\/download\/<job_id>/);

    const report = byName.get("oswQualityReportGenerate") ?? "";
    assert.match(report, /Which TDEI dataset id should get a quality report\?/);
    assert.match(report, /\/api\/v1\/osw\/quality-report\/\{tdei_dataset_id\}/);
    assert.match(report, /\/api\/v1\/job\/download\/<job_id>/);

    const download = byName.get("job_download") ?? "";
    assert.match(download, /Only|only download after|only download after the job status is COMPLETED/);
    assert.match(download, /GET \/api\/v1\/job\/download\/\{job_id\}/);
  } finally {
    await client.close();
  }
});

test("dashed operation ids fall back to the normalized instruction key", () => {
  assert.equal(augmentTdeiToolDescription("job-download", "desc"), `desc\n\n${TDEI_TOOL_INSTRUCTIONS.job_download}`);
});
