/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK: string
  readonly VITE_FACTORY_CONTRACT_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}