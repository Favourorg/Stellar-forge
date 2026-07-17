import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkWasmSize,
  DEFAULT_WASM_SIZE_LIMIT_BYTES,
  parseByteLimit,
} from "./check-wasm-size.mjs";

const withFixture = async (bytes, testFn) => {
  const dir = await mkdtemp(join(tmpdir(), "stellar-forge-wasm-size-"));
  try {
    const file = join(dir, "token_factory.wasm");
    await writeFile(file, Buffer.alloc(bytes));
    await testFn(file);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

describe("check-wasm-size", () => {
  it("uses a 64 KiB default limit", () => {
    assert.equal(DEFAULT_WASM_SIZE_LIMIT_BYTES, 64 * 1024);
  });

  it("parses a positive byte limit", () => {
    assert.equal(parseByteLimit("98304"), 98304);
  });

  it("rejects invalid byte limits", () => {
    assert.throws(() => parseByteLimit("0"), /positive integer/);
    assert.throws(() => parseByteLimit("64kb"), /positive integer/);
  });

  it("passes when the optimized WASM is at or below the limit", async () => {
    await withFixture(64 * 1024, async (file) => {
      const result = await checkWasmSize({ file, limitBytes: 64 * 1024 });

      assert.equal(result.sizeBytes, 64 * 1024);
      assert.equal(result.limitBytes, 64 * 1024);
    });
  });

  it("fails with a descriptive message when the optimized WASM exceeds the limit", async () => {
    await withFixture(64 * 1024 + 1, async (file) => {
      await assert.rejects(
        () => checkWasmSize({ file, limitBytes: 64 * 1024 }),
        /exceeds Soroban WASM size limit: 65,537 bytes > 65,536 bytes/,
      );
    });
  });
});
