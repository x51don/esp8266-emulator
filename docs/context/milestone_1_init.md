# Milestone 1 - Project initialization (Phase 1)

Date: 2026-09-17. Status: DONE.

## What exists now

- git repo (`main`), `.gitignore`, README.
- pnpm project: react, react-dom, CodeMirror 6 (state/view/commands/lang-cpp/one-dark),
  vite 5, vitest 2, TS strict. `pnpm-workspace.yaml` allows the esbuild build script
  (binary comes from optionalDependencies; the "ignored builds" notice is harmless).
- Toolchain verified: `npx vitest run` green (`tests/toolchain.test.ts`), `tsc --noEmit` clean,
  esbuild 0.21.5 binary runs.
- Directory skeleton: `core/` `peripherals/` `gui/` `tests/` `docs/context/` `examples/`.
- Vite entry: `index.html` -> `gui/main.tsx` -> `gui/App.tsx` (placeholder shell).
  Dev server port 5188 (`vite.config.ts`), tests include `tests/**/*.test.ts`.

## Decisions (full rationale in ARCHITECTURE.md)

- Stack: TypeScript + React + Vite + custom canvas engine; editor = CodeMirror 6.
- Sketch runtime = tree-walking interpreter (generator-based cooperative execution)
  for an Arduino-C++ subset, NOT Xtensa/WASM CPU emulation.
- Virtual-time scheduler drives everything; tests advance time manually, GUI uses rAF driver.

## Constraints noted

- Max ONE concurrent subagent (user). Subagents sequential only.
- GUI must be verified with headless browser screenshots, not just type checks.

## Next step (Phase 2)

TDD modules, in order: `core/clock.ts` (virtual clock + scheduler),
`core/registers.ts` (GPIO register file), `core/boards.ts` (Wemos/NodeMCU pin maps).
Each: failing test first, then minimal implementation, then commit.
