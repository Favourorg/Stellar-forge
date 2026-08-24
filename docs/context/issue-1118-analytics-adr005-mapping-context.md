# Contexto de Ejecución: Issue #1118 - Analytics Privacy Consent Mapping & ADR-005 Enforcement

- **Estado:** Fase 2 (Implementación completada)
- **Rama:** docs/1118-analytics-adr005-mapping
- **Fecha:** Mon Aug 24 16:14:36 -05 2026
- **Auditoría de Entorno:**
  - Node.js: `v20.20.2` (cumple el requisito v18+; `.nvmrc` fija `20`).
  - npm: `10.8.2`.
  - pnpm: `11.5.1` detectado, pero no ejecutable con Node.js 20; requiere Node.js `>=22.13` y falla al cargar `node:sqlite`.
  - Rust: no disponible en `PATH` (`rustc` no encontrado).
  - Cargo: no disponible en `PATH` (`cargo` no encontrado).
  - Stellar CLI: `27.1.0`.
  - Soroban CLI: no disponible en `PATH`.
  - Manifiestos inspeccionados: `package.json`, `frontend/package.json`, `contracts/Cargo.toml` y `.nvmrc`.
- **Objetivos y Alcance:**
  - Trazabilidad y checklist de ADR-005 frente a tests (`frontend/src/services/analytics.test.ts`, `frontend/src/components/AnalyticsOptOut.test.tsx`).
  - Diff y alineación del script de CI `frontend/scripts/check-analytics-bypass.mjs`.
  - Consolidación documental (resolución del stub `.kiro/specs/analytics-integration/` y actualización de `docs/adr/ADR-005-analytics-privacy-consent.md`).

## Especificación de Trazabilidad

### Convenciones

- `REQ-ADR005-*` identifica un requisito normativo o funcional derivado de ADR-005.
- `UT-*` identifica una aserción o grupo de aserciones de `analytics.test.ts`.
- `CT-*` identifica una aserción o grupo de aserciones de `AnalyticsOptOut.test.tsx`.
- `CI-*` identifica una comprobación de `check-analytics-bypass.mjs`.
- La trazabilidad es bidireccional: cada requisito debe apuntar a evidencia y cada evidencia debe declarar el requisito que protege.
- La evidencia existente se considera **parcial** cuando prueba el comportamiento de un adaptador, pero no la propiedad completa declarada por ADR-005.

### Requisitos normalizados y matriz ADR -> evidencia

| ID | Requisito de ADR-005 | Evidencia actual | Cobertura | Gap / decisión |
|---|---|---|---|---|
| `REQ-ADR005-01` | No recopilar PII ni direcciones de wallet. | `UT-06` comprueba tipos de props escalares; los tests ejercitan `symbol`, `amount` y `success`. | Parcial | Ampliar tests con una lista explícita de campos prohibidos y revisión de todos los callers. No waiver: es una garantía de privacidad. |
| `REQ-ADR005-02` | No usar cookies, fingerprinting ni tracking cross-site. | Ninguna aserción en las dos suites; el CI no inspecciona cookies ni configuración del proveedor. | No cubierta por tests | Mantener la afirmación como propiedad del proveedor y añadir un check documental/configuracional en Fase 2. No waiver para cookies propias; documentar el límite de verificación sobre Plausible. |
| `REQ-ADR005-03` | El opt-out debe estar disponible cuando analytics está configurado. | `CT-01` renderiza el checkbox con dominio; `CT-02` verifica que se oculta sin dominio. | Cubierta | Sin ampliación requerida; añadir anotación ADR en la implementación del test. |
| `REQ-ADR005-04` | Persistir la preferencia en `localStorage` bajo `analytics_opt_out`. | `UT-04`, `UT-05`, `CT-05`, `CT-06` verifican escritura, eliminación y lectura persistida. | Cubierta | Añadir caso de almacenamiento no disponible si se busca cubrir la tolerancia declarada por el servicio. |
| `REQ-ADR005-05` | Leer el consentimiento en cada tracking call y aplicar el cambio inmediatamente en la sesión. | `UT-08`, `UT-09`, `UT-14`, `UT-15`, `UT-18`, `CT-07`, `CT-08` cubren supresión y reactivación sin reload. | Cubierta | Sin waiver. Conservar pruebas de transición opt-in/opt-out. |
| `REQ-ADR005-06` | Enviar únicamente `pageview` y eventos custom con nombre y props no-PII. | `UT-06`, `UT-07`, `UT-10`, `UT-11`, `UT-12`, `UT-13` verifican forma de llamadas y pageview con URL. | Parcial | Añadir catálogo verificable de nombres/eventos permitidos o justificar que el nombre es input controlado por callers. Validar que la URL no incorpora wallet. |
| `REQ-ADR005-07` | No realizar llamadas si `VITE_PLAUSIBLE_DOMAIN` no está configurado. | `UT-10`, `UT-16`, `CT-02` verifican ausencia de llamadas/renderizado. | Cubierta | Sin ampliación requerida; cubrir también dominio whitespace si la política lo exige. |
| `REQ-ADR005-08` | Todo tracking debe pasar por `trackEvent`/`trackPageView`; no se permite `window.plausible` directo. | `CI-01` rechaza imports directos fuera de allowlist; `CI-02` rechaza llamadas `window.plausible`; `UT-17`, `UT-18` cubren API pública. | Cubierta con limitación | Fase 2 debe hacer que CI también verifique la existencia y ejecución de sus tests. La allowlist de `App.tsx` requiere revisión explícita ante cambios. |

### Matriz inversa evidencia -> requisito

| Evidencia | Requisitos protegidos | Observación |
|---|---|---|
| `analytics.test.ts` (`UT-01` a `UT-05`) | `REQ-ADR005-03`, `REQ-ADR005-04` | La suite del servicio cubre estado y persistencia, no UI. |
| `analytics.test.ts` (`UT-06` a `UT-13`) | `REQ-ADR005-01`, `REQ-ADR005-06`, `REQ-ADR005-07` | La restricción de tipos no constituye por sí sola una prueba exhaustiva de PII. |
| `analytics.test.ts` (`UT-14` a `UT-18`) | `REQ-ADR005-05`, `REQ-ADR005-07`, `REQ-ADR005-08` | Cubre supresión inmediata y ausencia de API global, no todos los callers productivos. |
| `AnalyticsOptOut.test.tsx` (`CT-01` a `CT-09`) | `REQ-ADR005-03`, `REQ-ADR005-04`, `REQ-ADR005-05` | Confirma accesibilidad básica mediante `aria-label`; no prueba integración en footer/App. |
| `check-analytics-bypass.mjs` (`CI-01`, `CI-02`) | `REQ-ADR005-08` | Escanea `.ts/.tsx`, omite tests y aplica una allowlist explícita. No prueba privacidad del payload. |

## Gap Analysis y Enforcement

### Brechas aceptadas como trabajo pendiente

1. **PII y wallet addresses (`REQ-ADR005-01`):** la firma escalar reduce riesgo, pero no demuestra que los nombres o valores enviados sean siempre no-PII. Fase 2 debe añadir casos de regresión y un inventario de callers. No se concede waiver.
2. **Cookies y fingerprinting (`REQ-ADR005-02`):** no es demostrable únicamente con unit tests. Se requiere una comprobación de integración o auditoría de red/documentación del proveedor; el resultado debe quedar fechado en QA. No se concede waiver sobre comportamiento propio.
3. **Catálogo de eventos (`REQ-ADR005-06`):** el contrato actual permite cualquier `string`. Fase 2 debe decidir entre un catálogo cerrado o mantener nombres abiertos con una revisión de payloads. Hasta esa decisión, cobertura parcial.
4. **Completitud del enforcement:** CI detecta bypasses sintácticos, pero no prueba que las suites se ejecuten ni que no existan callers dinámicos. Fase 2 debe añadir el comando al pipeline y documentar sus límites.

No se proponen waivers en Fase 1. Cualquier waiver futuro debe incluir requisito, justificación, riesgo residual, responsable, fecha de expiración y issue de seguimiento; un comentario informal no es suficiente.

### Stub `.kiro/specs/analytics-integration/`

El stub queda clasificado como especificación histórica obsoleta: afirma un flujo **opt-in** y referencia `CookieConsentBanner`, mientras ADR-005 y el código vigente definen **opt-out** mediante `AnalyticsOptOut`. En Fase 2 se debe conservar su contenido solo como evidencia de la discrepancia, añadir una nota de supersesión o retirar el stub mediante el proceso documental del repositorio. ADR-005 y este SSOT son las fuentes normativas; no se debe implementar el flujo del stub.

### Diseño de `Enforcement & Testing` para ADR-005

La sección futura debe contener, en este orden:

1. **Enforcement de runtime:** `isEnabled()` exige dominio configurado y `!isOptedOut()`; `isOptedOut()` se lee por invocación; errores de `localStorage` y Plausible no llegan al usuario.
2. **Enforcement estático:** `check-analytics-bypass.mjs` bloquea imports directos y llamadas a `window.plausible`, con allowlist revisada y justificada.
3. **Matriz de pruebas:** enlaces a requisitos `REQ-ADR005-*`, IDs de tests y resultado de CI.
4. **Privacidad del payload:** tipos permitidos, campos prohibidos, inventario de callers y resultado de auditoría de red.
5. **Gestión de excepciones:** formato de waiver, propietario, caducidad y requisito de actualizar ADR-005 cuando cambie la política.

## Convención de anotación para Fase 2

Cada bloque de test que proteja un requisito debe incluir un comentario breve y estable con el formato:

```ts
// ADR-005: REQ-ADR005-05 — opt-out takes effect immediately in-session.
```

Para un test que cubra varios requisitos se usará una línea por requisito. El comentario debe citar el ID exacto, no solo `ADR-005`; no se deben copiar cláusulas completas ni convertir el comentario en la fuente normativa. Los nombres `UT-*` y `CT-*` de esta matriz se actualizarán si el archivo cambia.

## Plan de acción

### Fase 2 — Implementación documental y enforcement

- Añadir anotaciones `REQ-ADR005-*` a las suites existentes y completar los casos de PII, almacenamiento no disponible y URL sin wallet.
- Decidir y documentar catálogo abierto/cerrado de eventos; ajustar la matriz y ADR-005 si la decisión altera el contrato.
- Extender `check-analytics-bypass.mjs` o el pipeline para exigir la ejecución de tests y revisar la allowlist de `App.tsx`.
- Resolver el stub `.kiro/specs/analytics-integration/` con una nota de supersesión o eliminación conforme a la política del repositorio.
- Diseñar la sección `Enforcement & Testing` de ADR-005 sin modificar `frontend/src/` en esta fase arquitectónica.

### Fase 3 — QA y cierre

- Ejecutar tests unitarios y de componente, el check de bypass y el typecheck del frontend.
- Verificar en navegador que no hay llamadas de red antes de configuración, tras opt-out y después de opt-in; registrar evidencia.
- Auditar cookies, almacenamiento y payloads, incluyendo navegación SPA y rutas con wallet conectada.
- Confirmar trazabilidad bidireccional requisito -> evidencia y evidencia -> requisito; marcar cada gap como cerrado o waiver aprobado.
- Actualizar este SSOT, ADR-005 y el changelog documental con resultados, fecha, commit y riesgos residuales.

## Historial de Decisiones y Fases

- Fase 0: rama de trabajo creada y auditoría de entorno registrada.
- Fase 1: matriz de trazabilidad, gap analysis, contrato de anotaciones y plan de enforcement definidos.
- Fase 2: suites anotadas con `REQ-ADR005-*`, enforcement documentado en ADR-005 y stub marcado como supersedido. Pendiente de validación QA de Fase 3.

## Resultado de Fase 2

- `frontend/src/services/analytics.test.ts`: anotaciones de requisitos para estado, persistencia, eventos, pageviews y supresión global.
- `frontend/src/components/AnalyticsOptOut.test.tsx`: anotaciones de requisitos para disponibilidad, persistencia, accesibilidad y efecto inmediato del control.
- `frontend/scripts/check-analytics-bypass.mjs`: enforcement identificado explícitamente como `REQ-ADR005-08`.
- `docs/adr/ADR-005-analytics-privacy-consent.md`: sección formal `Enforcement & Testing` añadida, incluyendo límites de evidencia y política de waivers.
- `.kiro/specs/analytics-integration/requirements.md`: stub documentado como supersedido por ADR-005.

### Validación de Fase 2

- Suites de analytics: `28/28` tests pasan.
- `node frontend/scripts/check-analytics-bypass.mjs`: pasa sin violaciones.
- Errores en los archivos modificados: ninguno detectado.
- Typecheck frontend: bloqueado por errores preexistentes en `frontend/src/test/ipfs.test.ts` (alrededor de las líneas 862, 864 y 1012); no relacionados con esta implementación.
