# Token Metadata Format

The contract stores only a `metadata_uri` string. Everything else — name, description, image — lives in a JSON document pinned to IPFS, which the frontend fetches and renders.

Because that document is pinned by whoever created the token, **it is untrusted input**. Anyone can pin metadata directly to IPFS and point a token at it without ever touching the StellarForge upload form, so the frontend validates it on read rather than trusting it was produced by our own UI.

This page documents the constraints the frontend enforces, so third-party integrators pinning their own metadata know what will and will not survive rendering.

## Document shape

```json
{
  "name": "MyToken",
  "description": "A short human-readable description.",
  "image": "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
}
```

All three fields are **required** and must be strings. A document missing any of them, or with a non-string value, is rejected outright and the token renders without metadata.

Unrecognised extra fields are **stripped** — only `name`, `description`, and `image` are read. Do not rely on custom fields surviving.

## Constraints

| Field | Constraint | Behaviour when exceeded |
| --- | --- | --- |
| `name` | ≤ **128** characters | Truncated, with `…` appended |
| `description` | ≤ **2,000** characters | Truncated, with `…` appended |
| `image` | Must be a well-formed `ipfs://` URI | Replaced with an inline placeholder image |
| *(whole document)* | ≤ **100 KB** raw JSON | Rejected — metadata is dropped entirely |

Lengths are counted in **Unicode code points**, not UTF-16 code units, so truncation never splits a surrogate pair and leaves half an emoji behind.

### Why truncate rather than reject

An over-long description makes for a bad token, not a broken one. Rejecting the whole document would also discard the name and image, leaving a strictly worse page. The 100 KB document cap is the exception: it is enforced *before* `JSON.parse`, because parsing a multi-megabyte payload costs main-thread time whether or not the result is later discarded.

### Why `image` must be `ipfs://`

An arbitrary `https://` image URL would be fetched by every visitor's browser, handing the token creator a view-tracking beacon that leaks each visitor's IP and user-agent. Only `ipfs://` URIs are resolved, and always through the configured gateway. Anything else — `https://`, `javascript:`, `data:`, protocol-relative, or a URI with path traversal — renders as a neutral placeholder. See `ipfsToGatewayUrl` in `frontend/src/utils/formatting.ts`.

## Rendering bounds

Independently of the data-layer caps above, the UI bounds what it draws:

- **Token detail** clamps the description to 3 lines with a "Show more" toggle; expanded text gets a capped scroll region rather than unbounded growth.
- **Token explorer** clamps to 2 lines with no expand affordance, so one token cannot grow its row and push other results off-screen.

This is deliberate redundancy. A character cap does not bound *height* — a few hundred newlines, or stacked combining marks, occupy far more vertical space than their length implies.

## Where these are enforced

| Layer | Location | Notes |
| --- | --- | --- |
| Read (authoritative) | `getMetadata` in `frontend/src/services/ipfs.ts` | The only check that binds for externally-pinned metadata |
| Write (advisory) | `MetadataForm.tsx`, `MetadataUploadForm.tsx` | Better UX; trivially bypassed by pinning directly |
| Render (defence in depth) | `TokenDetail.tsx`, `TokenExplorer.tsx` | Bounds height regardless of character count |

Constants live in `frontend/src/services/ipfs.ts` as `MAX_METADATA_NAME_LENGTH` and `MAX_METADATA_DESCRIPTION_LENGTH`. Update this document if you change them.
