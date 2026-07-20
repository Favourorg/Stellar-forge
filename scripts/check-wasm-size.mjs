#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_WASM_SIZE_LIMIT_BYTES = 64 * 1024;

const formatter = new Intl.NumberFormat("en-US");

const formatBytes = (bytes) => `${formatter.format(bytes)} bytes`;

export const parseByteLimit = (value) => {
  if (value === undefined || value === "") return DEFAULT_WASM_SIZE_LIMIT_BYTES;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `WASM size limit must be a positive integer byte count, got "${value}"`,
    );
  }

  return parsed;
};

export const checkWasmSize = async ({
  file,
  limitBytes = DEFAULT_WASM_SIZE_LIMIT_BYTES,
}) => {
  if (!file) {
    throw new Error("Missing required --file path to optimized contract WASM");
  }

  const { size } = await stat(file);
  if (size > limitBytes) {
    throw new Error(
      `${file} exceeds Soroban WASM size limit: ${formatBytes(size)} > ${formatBytes(limitBytes)}`,
    );
  }

  return { file, sizeBytes: size, limitBytes };
};

const parseArgs = (argv) => {
  const args = { file: undefined, limitBytes: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--max-bytes" || arg === "--limit-bytes") {
      args.limitBytes = parseByteLimit(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument "${arg}"`);
  }

  return args;
};

const main = async () => {
  const { file, limitBytes } = parseArgs(process.argv.slice(2));
  const result = await checkWasmSize({ file, limitBytes });

  console.log(
    `WASM size OK: ${result.file} is ${formatBytes(result.sizeBytes)} ` +
      `(limit ${formatBytes(result.limitBytes)})`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
