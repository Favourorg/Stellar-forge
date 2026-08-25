import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isRateLimited } from "../_lib/rateLimit";
import { PINATA_API_URL, pinataHeaders } from "../_lib/pinata";
import { isValidCid } from "../_lib/schemaValidation";
import { verifyToken } from "../_lib/jwt";
import { getPinOwner, clearPinOwner } from "../_lib/pinOwnership";

interface UnpinBody {
  cid: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Authenticate: require a valid JWT from the challenge → signature flow
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error:
        "Authorization required. Request a challenge and sign with your wallet.",
    });
    return;
  }

  let walletAddress: string;
  try {
    const token = authHeader.slice(7); // Remove "Bearer "
    const payload = verifyToken(token);
    walletAddress = payload.address;
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : "Invalid or expired token.",
    });
    return;
  }

  // Check rate limits (per wallet address, durable across instances)
  if (await isRateLimited(walletAddress)) {
    res
      .status(429)
      .json({ error: "Too many requests. Please try again later." });
    return;
  }

  const body = req.body as UnpinBody | undefined;
  const rawCid = typeof body?.cid === "string" ? body.cid : null;
  if (!rawCid || !isValidCid(rawCid)) {
    auditUnpin(walletAddress, rawCid ?? "(missing)", "denied_invalid_cid");
    res
      .status(400)
      .json({ error: "Request body must include a valid { cid: string }." });
    return;
  }
  const cid = rawCid;

  // Ownership check: a CID may only be unpinned by the wallet that pinned
  // it. An unindexed/unknown CID is denied by default — we never assume
  // the requester owns content we have no record of.
  const ownerAddress = await getPinOwner(cid);

  if (ownerAddress === null) {
    auditUnpin(walletAddress, cid, "denied_unknown_cid");
    res.status(403).json({
      error:
        "This CID has no known owner on record. Unpin is denied by default for unindexed content.",
    });
    return;
  }

  if (ownerAddress !== walletAddress) {
    auditUnpin(walletAddress, cid, "denied_not_owner");
    res
      .status(403)
      .json({ error: "You are not authorized to unpin this content." });
    return;
  }

  let headers: Record<string, string>;
  try {
    headers = pinataHeaders();
  } catch (err) {
    res
      .status(500)
      .json({
        error: err instanceof Error ? err.message : "Server misconfiguration.",
      });
    return;
  }

  try {
    const pinataRes = await fetch(`${PINATA_API_URL}/pinning/unpin/${cid}`, {
      method: "DELETE",
      headers,
    });

    if (!pinataRes.ok) {
      auditUnpin(walletAddress, cid, "pinata_error");
      res
        .status(502)
        .json({ error: `Pinata unpin failed (HTTP ${pinataRes.status}).` });
      return;
    }

    await clearPinOwner(cid);
    auditUnpin(walletAddress, cid, "allowed");
    res.status(200).json({ cid, unpinned: true });
  } catch {
    auditUnpin(walletAddress, cid, "error");
    res
      .status(500)
      .json({ error: "Unexpected error while unpinning from IPFS." });
  }
}

/** Structured audit log for every unpin attempt, allowed or rejected. */
function auditUnpin(address: string, cid: string, outcome: string): void {
  console.log(
    JSON.stringify({
      event: "ipfs_unpin",
      address,
      cid,
      outcome,
      at: new Date().toISOString(),
    }),
  );
}
