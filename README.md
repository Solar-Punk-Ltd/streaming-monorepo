# streaming-monorepo

Solar Punk's multi-brand Swarm streaming platform. The interactive design is at
https://solar-punk-ltd.github.io/devcon-streaming-partnership/?model=mvp.

## Packages

| Package | What |
|---|---|
| [web2-admin](web2-admin/) | Brand console, admin API and Postgres. The Web2 admin layer of the MVP model. |

## Docs

- [Roadmap and checkpoints](docs/ROADMAP.md)
- [Web2 admin layer design brief](docs/architecture/web2-admin.md)
- [Infrastructure state](docs/infra-state.md)

## Getting started

Node 24 and pnpm 10 (see `.nvmrc` and `packageManager` in `package.json`).

```bash
pnpm install
```

Then `pnpm -r build`, `pnpm -r test`, `pnpm -r typecheck`.

## License

MIT, see [LICENSE](LICENSE).
