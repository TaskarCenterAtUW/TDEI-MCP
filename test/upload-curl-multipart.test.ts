import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { DirectMultipartTdeiMutations } from "../src/adapters/direct-multipart-tdei-mutations.js";

const execFileAsync = promisify(execFile);

/**
 * The TDEI upload endpoints declare (OpenAPI multipart/form-data):
 *   required: dataset, metadata; dataset/metadata/changeset: type string, format binary.
 * `format: binary` means each is a FILE part (Content-Disposition has a filename).
 */
const SPEC = { required: ["dataset", "metadata"], binaryParts: ["dataset", "metadata", "changeset"] };

interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  body: string;
}

function parseMultipart(body: Buffer, contentType: string): Part[] {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  assert.ok(boundary, "multipart boundary");
  return body
    .toString("latin1")
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((raw) => {
      const [head = "", ...rest] = raw.replace(/^\r\n/, "").split("\r\n\r\n");
      const disposition = /name="([^"]+)"(?:; filename="([^"]*)")?/.exec(head);
      return {
        name: disposition?.[1] ?? "",
        ...(disposition?.[2] !== undefined ? { filename: disposition[2] } : {}),
        ...(/Content-Type: ([^\r\n]+)/i.exec(head)?.[1]
          ? { contentType: /Content-Type: ([^\r\n]+)/i.exec(head)?.[1] }
          : {}),
        body: rest.join("\r\n\r\n").replace(/\r\n$/, ""),
      } as Part;
    });
}

test("generated upload curl sends metadata as a JSON file part, matching the endpoint's multipart spec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tdei-upload-"));
  const received: { parts: Part[] }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ parts: parseMultipart(Buffer.concat(chunks), req.headers["content-type"] ?? "") });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const zip = join(dir, "data's.zip");
    writeFileSync(zip, "PK-fake-zip");
    const metadata = {
      dataset_detail: {
        name: `Seattle "OSW"; it's, {odd}`,
        version: "1.0",
        collected_by: "City",
        collection_date: "2026-09-01",
        data_source: "InHouse" as const,
        schema_version: "0.3",
      },
    };
    const adapter = new DirectMultipartTdeiMutations({ baseUrl: `http://127.0.0.1:${port}` });
    const instruction = await adapter.uploadDataset(
      {
        dataType: "osw",
        asset: { kind: "local_path", path: zip },
        projectGroupId: "pg",
        serviceId: "svc",
        metadata,
      },
      { accessToken: "tok" },
    );
    await execFileAsync("sh", ["-c", instruction.curlCommand]);

    const parts = received[0]?.parts ?? [];
    const byName = new Map(parts.map((part) => [part.name, part]));
    for (const required of SPEC.required) assert.ok(byName.has(required), `missing required part ${required}`);
    for (const part of parts) {
      if (SPEC.binaryParts.includes(part.name)) {
        assert.ok(part.filename, `${part.name} must be a file part (has a filename)`);
      }
    }
    const meta = byName.get("metadata");
    assert.equal(meta?.contentType, "application/json");
    assert.deepEqual(JSON.parse(meta?.body ?? ""), metadata);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
