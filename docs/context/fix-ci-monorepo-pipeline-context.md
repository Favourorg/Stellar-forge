# Contexto de Ejecución: Fix CI Monorepo & Access Control Drift
- **Estado:** Fase 0 (Setup inicializado)
- **Rama:** fix/ci-monorepo-drift-and-builds
- **Fecha:** 2026-08-24 22:38:13 UTC
- **Auditoría de Entorno:**
  - Node.js: v20.20.2
  - npm: 10.8.2
  - Rustc: No disponible
  - Cargo: No disponible
  - Target Wasm: No instalado
  - Stellar CLI: stellar 27.1.0 (8e402ea28202950b272fbabc34caad4d2f64fe87)
stellar-xdr 27.0.0 (5262803470be965e42f80023d12fba12808c774a)
xdr (68fa1ac55692f68ad2a2ca549d0a283273554439)
  - Soroban CLI: No disponible
- **Problemas a Resolver:**
  1. Rust Formatting (`cargo fmt --check`).
  2. Contract Build & Tests (`contracts/token-factory`).
  3. Contract/Frontend Drift (WASM hash, bindings y types).
  4. Frontend Typecheck, Lint y Tests (`frontend/`).
  5. Workflow `.github/workflows/validate-access-control-drift.yml` (`No jobs were run`).
- **Matriz de Diagnóstico y Plan por Fases:**
  - TBD
