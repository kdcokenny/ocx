# My Registry

A static file registry for OCX 3 and OpenCode V2. Edit `registry.jsonc` and put source files under `files/`. Build with `bun run build`; preview with `bun run dev`; deploy with `bun run deploy`. These commands use the OCX preview channel after it has been published.

Install files with `ocx add team/hello-world --from <registry-url> --project`, or select a named profile with `--profile <name>`. Run `ocx init --project` before a project install.

See https://ocx.kdco.dev/v2/registries for ownership, dependencies, update behavior, and publishing.
