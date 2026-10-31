import { strict as assert } from "node:assert";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerSemanticTools } from "../src/intents/register-tools.js";
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

test("common semantic tools are discoverable and callable", async () => {
  const module = new SemanticIntentModule({
    operations: {
      async searchDatasets() {
        return [];
      },
      async listServices() {
        return [];
      },
      async listProjectGroups() {
        return [{ tdei_project_group_id: "group-1", name: "Accessible Seattle" }];
      },
      async listJobs() {
        return [];
      },
    },
    places: {
      async forwardGeocode() {
        return [];
      },
    },
  });
  const server = new McpServer({ name: "semantic-tools-test", version: "1.0.0" });
  registerSemanticTools(server, module);
  const client = new Client({ name: "semantic-tools-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    const semantic = listed.tools
      .filter((tool) => tool.name.startsWith("tdei_"))
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(semantic, [
      "tdei_calculate_confidence",
      "tdei_calculate_quality_intersection",
      "tdei_check_dataset_incline",
      "tdei_clone_dataset",
      "tdei_convert_osw",
      "tdei_convert_pathways",
      "tdei_cut_dataset_bbox",
      "tdei_delete_dataset",
      "tdei_download_feedbacks",
      "tdei_edit_metadata",
      "tdei_find_datasets",
      "tdei_generate_quality_report",
      "tdei_get_dataset_details",
      "tdei_get_feedback_summary",
      "tdei_get_metrics",
      "tdei_get_my_identity",
      "tdei_get_pm_tiles_url",
      "tdei_get_system_info",
      "tdei_list_feedbacks",
      "tdei_list_jobs",
      "tdei_list_my_project_groups",
      "tdei_list_services",
      "tdei_list_versions",
      "tdei_publish_dataset",
      "tdei_recover_password",
      "tdei_regenerate_api_key",
      "tdei_resolve_intent",
      "tdei_sanitize_dataset",
      "tdei_self_merge",
      "tdei_set_viewer_access",
      "tdei_spatial_join",
      "tdei_submit_feedback",
      "tdei_tag_incline",
      "tdei_tag_quality_metric",
      "tdei_tag_road",
      "tdei_union_datasets",
      "tdei_update_feedback_status",
      "tdei_upload_dataset",
      "tdei_validate_dataset",
      "tdei_verify_email",
    ]);
    const find = listed.tools.find((tool) => tool.name === "tdei_find_datasets");
    assert.match(find?.description ?? "", /latest dataset for Seattle/i);

    const resolution = await client.callTool({
      name: "tdei_resolve_intent",
      arguments: { request: "Which organizations can I access?" },
    });
    const resolutionFirst = resolution.content[0];
    const resolutionBody = JSON.parse(resolutionFirst?.type === "text" ? resolutionFirst.text : "{}");
    assert.equal(resolutionBody.status, "complete");
    assert.equal(resolutionBody.data.tool, "tdei_list_my_project_groups");
    assert.equal(resolutionBody.data.apiOperation, "listProjectGroups");

    const membership = await client.callTool({
      name: "tdei_list_my_project_groups",
      arguments: {},
    });
    const first = membership.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}");
    assert.equal(body.status, "complete");
    assert.equal(body.data.accessScope, "authenticated_user");
    assert.match(body.data.scopeExplanation, /NOT confirmed membership/i);
    assert.equal(body.data.apiOperation, "listProjectGroups");
    assert.equal(body.data.path, "/api/v1/project-groups");
    assert.equal(body.data.projectGroups[0].tdei_project_group_id, "group-1");

    const upload = await client.callTool({
      name: "tdei_upload_dataset",
      arguments: { dataType: "osw" },
    });
    const uploadFirst = upload.content[0];
    const uploadBody = JSON.parse(uploadFirst?.type === "text" ? uploadFirst.text : "{}");
    assert.equal(uploadBody.status, "needs_input");
    assert.ok(uploadBody.missing.some((item: { field: string }) => item.field === "metadata.dataset_detail.name"));
  } finally {
    await client.close();
  }
});
