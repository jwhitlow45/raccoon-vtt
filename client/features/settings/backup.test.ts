import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, importFormHeader, MAX_IMPORT_BYTES, type ApiErrorCodeOrNetwork } from "../../lib/api.ts";
import { exportErrorText, formatBytes, importErrorText, importFileProblem } from "./backup.ts";

const zip = (size: number) => ({ name: "raccoon-room-K7QH-2MXA.zip", size, type: "application/zip" });

describe("room import", () => {
  test("refuses a file over 95 MB before uploading it", () => {
    assert.equal(importFileProblem(zip(MAX_IMPORT_BYTES)), null);
    assert.match(importFileProblem(zip(MAX_IMPORT_BYTES + 1)) ?? "", /up to 95 MB.*admin import/);
  });

  test("refuses what is not a zip, and an empty file", () => {
    assert.match(importFileProblem({ name: "notes.txt", size: 10, type: "text/plain" }) ?? "", /\.zip/);
    assert.equal(importFileProblem({ name: "export.ZIP", size: 10, type: "" }), null);
    assert.match(importFileProblem(zip(0)) ?? "", /empty/);
  });

  test("the form travels as base64url JSON, the way the server decodes it", () => {
    const form = { name: "Café ü", playerPassword: "owlbear-druid-wand", dmName: "DM" };
    const header = importFormHeader(form);
    assert.match(header, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), form);
  });

  test("the server's refusals read as sentences, size limits included", () => {
    const err = (status: number, code: ApiErrorCodeOrNetwork | undefined, detail: Record<string, unknown> = {}) => new ApiError(status, "raw", code, null, detail);
    assert.match(importErrorText(err(413, "too_large")), /up to 95 MB/);
    assert.match(importErrorText(err(413, "import_too_large")), /1 GB/);
    assert.match(importErrorText(err(413, undefined)), /too big/);
    assert.match(importErrorText(err(413, "quota_exceeded")), /more than a room may store/);
    assert.match(importErrorText(err(507, "storage_full")), /out of disk space/);
    assert.match(importErrorText(err(400, "bad_zip")), /not a room export/);
    assert.match(importErrorText(err(400, "weak_password", { reason: "too_common" })), /too common/);
    assert.match(importErrorText(err(429, "rate_limited")), /Too many rooms/);
    assert.equal(importErrorText(err(500, "internal")), "raw");
  });

  test("sizes in plain units", () => {
    assert.equal(formatBytes(95_000_000), "95 MB");
    assert.equal(formatBytes(1_200_000_000), "1.2 GB");
    assert.equal(formatBytes(2_048), "2 KB");
  });
});

describe("room export", () => {
  test("a refused backup reads as a sentence, with the wait in minutes", () => {
    const err = (status: number, retryAfterMs: number | null = null) => new ApiError(status, "raw", undefined, retryAfterMs);
    assert.match(exportErrorText(err(429, 125_000)), /4 backups.*in 3 minutes\./);
    assert.match(exportErrorText(err(429, 20_000)), /in 1 minute\./);
    assert.match(exportErrorText(err(429)), /Try again later/);
    assert.match(exportErrorText(err(503)), /another backup/);
    assert.match(exportErrorText(err(403)), /Only a DM device/);
    assert.match(exportErrorText(new ApiError(0, "raw", "network", null)), /Could not reach/);
    assert.equal(exportErrorText(err(500)), "raw");
  });
});
