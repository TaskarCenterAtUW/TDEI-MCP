// Latency check for tdei_list_jobs fan-out: 20 project groups, 25ms upstream each.
// Sequential would take ~500ms; bounded concurrency (5) should land near 100-150ms.
import { SemanticIntentModule } from "../src/intents/semantic-intent-module.js";

const module = new SemanticIntentModule({
  operations: {
    searchDatasets: async () => [],
    listServices: async () => [],
    listProjectGroups: async () => Array.from({ length: 20 }, (_, i) => ({ tdei_project_group_id: `g${i}` })),
    listJobs: async (input) => {
      await new Promise((r) => setTimeout(r, 25));
      return [{ job_id: String(input.projectGroupId) }];
    },
  },
  places: { forwardGeocode: async () => [] },
});

for (const label of ["cold (fetches groups)", "warm (groups cached)"]) {
  const start = performance.now();
  await module.listJobs({}, { accessToken: "bench" });
  console.log(`${label}: ${(performance.now() - start).toFixed(0)}ms`);
}
