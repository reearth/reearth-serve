# AGENTS.md

## Before Starting Work

- Always read `README.md` and `ROADMAP.md` before touching any code.
- Check relevant ADRs in `docs/adr/` if the task involves architectural decisions.

## Coding Conventions

- Use `npm run` instead of `npx` for running npm scripts.
- After modifying Go code, always run `gofmt` and `golangci-lint run`.
- Proactively split files that exceed ~1000 lines.

## After Implementation

- Always run `npm run check` (typecheck + unit tests) before considering the task done.
- Update `README.md` and existing ADRs as needed to reflect changes.
- Create a new ADR in `docs/adr/` when making significant design decisions.
