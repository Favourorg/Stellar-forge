// IPFS configuration
//
// Pinata credentials are never held here or in any VITE_-prefixed env var -
// they'd be inlined into the client bundle and shipped to every visitor.
// Uploads go through our own serverless proxy (api/ipfs/*), which holds the
// credentials server-side. Only public, read-only gateway access is direct.

export const IPFS_CONFIG = {
  ipfsProxyUrl: '/api/ipfs',
  pinataGateway: 'https://gateway.pinata.cloud/ipfs',
}