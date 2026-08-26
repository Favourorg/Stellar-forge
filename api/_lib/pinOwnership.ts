/**
 * Tracks which wallet address pinned a given IPFS CID, so the unpin endpoint
 * can verify ownership before deleting content from Pinata on someone's
 * behalf. Recorded at upload time by upload-json.ts / upload-file.ts.
 *
 * Uses Vercel KV for durability across serverless instances, matching the
 * pattern in rateLimit.ts. Falls back to per-instance memory when KV isn't
 * configured — note that this fallback fails *closed*: a CID pinned by one
 * instance won't be found by a different instance's in-memory map, so
 * getPinOwner() returns null and the caller denies the unpin. Configure
 * Vercel KV in production so legitimate owners aren't denied.
 */

interface PinOwnerRecord {
  ownerAddress: string;
  pinnedAt: number;
}

const memoryRegistry = new Map<string, PinOwnerRecord>();

function pinKey(cid: string): string {
  return `pinowner:${cid}`;
}

/** Records the wallet address that pinned `cid`. Called after a successful Pinata pin. */
export async function recordPinOwner(
  cid: string,
  ownerAddress: string,
): Promise<void> {
  const kvUrl = process.env.VERCEL_KV_REST_API_URL;
  const kvToken = process.env.VERCEL_KV_REST_API_TOKEN;
  const record: PinOwnerRecord = { ownerAddress, pinnedAt: Date.now() };

  if (kvUrl && kvToken) {
    try {
      await kvSet(kvUrl, kvToken, pinKey(cid), JSON.stringify(record));
      return;
    } catch (err) {
      console.error(
        "Failed to record pin owner in KV, falling back to memory:",
        err,
      );
    }
  }

  memoryRegistry.set(cid, record);
}

/**
 * Returns the wallet address that pinned `cid`, or null if the CID is not
 * indexed. Callers MUST treat null as "ownership cannot be verified" and
 * deny the request — never allow-by-default for an unknown CID.
 */
export async function getPinOwner(cid: string): Promise<string | null> {
  const kvUrl = process.env.VERCEL_KV_REST_API_URL;
  const kvToken = process.env.VERCEL_KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const data = await kvGet(kvUrl, kvToken, pinKey(cid));
      if (!data) return null;
      const record = JSON.parse(data) as PinOwnerRecord;
      return record.ownerAddress;
    } catch (err) {
      console.error("Failed to read pin owner from KV:", err);
      return null;
    }
  }

  return memoryRegistry.get(cid)?.ownerAddress ?? null;
}

/** Removes ownership tracking for `cid` after it has been successfully unpinned. */
export async function clearPinOwner(cid: string): Promise<void> {
  const kvUrl = process.env.VERCEL_KV_REST_API_URL;
  const kvToken = process.env.VERCEL_KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    try {
      await kvDel(kvUrl, kvToken, pinKey(cid));
      return;
    } catch (err) {
      console.error("Failed to clear pin owner from KV:", err);
    }
  }

  memoryRegistry.delete(cid);
}

// Vercel KV REST API helpers (mirrors rateLimit.ts)
async function kvGet(
  url: string,
  token: string,
  key: string,
): Promise<string | null> {
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { result: string | null };
  return data.result;
}

async function kvSet(
  url: string,
  token: string,
  key: string,
  value: string,
): Promise<void> {
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ value }),
  });
}

async function kvDel(url: string, token: string, key: string): Promise<void> {
  await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}
