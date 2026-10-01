import { strict as assert } from "node:assert";
import test from "node:test";
import { fetchMultipartOperationIds, multipartOperationIds } from "../src/openapi-multipart.js";

const spec = {
  paths: {
    "/a": { post: { operationId: "uploadA", requestBody: { content: { "multipart/form-data": {} } } }, get: { operationId: "getA" } },
    "/b": { post: { operationId: "formB", parameters: [{ in: "formData", name: "f" }] } },
    "/h": { post: { operationId: "osw-union", requestBody: { content: { "multipart/form-data": {} } } } },
    "/c": { put: { operationId: "jsonC", requestBody: { content: { "application/json": {} } } } },
  },
};

test("multipartOperationIds finds multipart and formData operations only", () => {
  assert.deepEqual([...multipartOperationIds(spec)].sort(), ["formB", "osw_union", "uploadA"]);
});

test("fetchMultipartOperationIds returns undefined (not throw) when spec is unreachable", async () => {
  const res = await fetchMultipartOperationIds("https://x.invalid/spec.json", (async () => { throw new Error("offline"); }) as never);
  assert.equal(res, undefined);
});
