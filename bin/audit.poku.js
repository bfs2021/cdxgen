import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { strict as assert, describe, it } from "poku";

// stdout writes to a pipe complete asynchronously, so a process.exit() issued
// right after the write raced the flush and truncated piped cdx-audit reports
// at 64/128 KiB. This suite runs the CLI with a stand-in stdout whose writes
// complete in slices on later ticks, the way a kernel pipe flushes, and
// checks that the whole report survives the exit. A real pipe cannot be used
// because pipe writes are synchronous on Windows, which hides the race.
const wrapper = `
import { Writable } from "node:stream";
import { writeFileSync } from "node:fs";
const chunks = [];
const pipe = new Writable({
  highWaterMark: 64 * 1024,
  write(chunk, encoding, callback) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
    let written = 0;
    const flush = () => {
      const slice = buffer.subarray(written, written + 64 * 1024);
      chunks.push(slice);
      written += slice.length;
      if (written < buffer.length) {
        setImmediate(flush);
      } else {
        callback();
      }
    };
    setImmediate(flush);
  },
});
Object.defineProperty(process, "stdout", { value: pipe, configurable: true });
process.on("exit", () => {
  writeFileSync(process.env.AUDIT_PIPE_CAPTURE, Buffer.concat(chunks));
});
await import(process.env.AUDIT_PIPE_ENTRY);
`;

describe("cdx-audit report drainage through an asynchronous stdout", () => {
  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-audit-pipe-"));
  process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));
  writeFileSync(join(workDir, "pipe-stdout.mjs"), wrapper);
  const capture = join(workDir, "captured.json");

  const auditThroughPipe = (...args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.argv0,
        [join(workDir, "pipe-stdout.mjs"), ...args],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            AUDIT_PIPE_CAPTURE: capture,
            AUDIT_PIPE_ENTRY: pathToFileURL(
              join(process.cwd(), "bin", "audit.js"),
            ).href,
          },
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stderr }));
      child.on("error", reject);
    });

  it("drains the whole JSON report before exiting", async () => {
    const { status, stderr } = await auditThroughPipe(
      "--bom",
      "test/data/bom-java.json",
      "--direct-bom-audit",
      "--report",
      "json",
    );
    assert.strictEqual(status, 0, `cdx-audit exited ${status}: ${stderr}`);
    const captured = readFileSync(capture, "utf-8");
    // The fixture's report is far larger than the 64/128 KiB points where the
    // truncated output used to stop, so surviving the drain means both cut
    // points were passed.
    assert.ok(
      captured.length > 131072,
      `only ${captured.length} bytes of the report drained`,
    );
    assert.doesNotThrow(
      () => JSON.parse(captured),
      "the piped report was cut off mid-document",
    );
  });
});
