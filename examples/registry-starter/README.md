# OCX Registry Starter

A ready-to-deploy component registry for [OpenCode](https://opencode.ai).

## One-Click Deploy

Deploy your registry instantly to your preferred platform:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/YOUR_REPO)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/YOUR_REPO)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/YOUR_USERNAME/YOUR_REPO)

> **After forking:** Update the deploy button URLs above to point to your repository.

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Build the Registry

```bash
bun run build
```

### 3. Local Development

```bash
bun run dev
```

This starts a local server at `http://localhost:8787`.

### 4. Deploy

```bash
bun run deploy
```

## Using Your Registry

Once deployed, users can add components from your registry:

```bash
# Add a component
ocx add your-namespace/hello-world

# Or specify the registry URL
ocx add hello-world --registry https://your-registry.workers.dev
```

## Project Structure

```
├── registry.jsonc         # Registry manifest
├── files/                  # Component source files
│   └── skill/
│       └── hello-world/
│           └── SKILL.md   # Example skill
├── dist/                   # Built output (generated)
├── wrangler.jsonc          # Cloudflare Workers config
├── vercel.json             # Vercel config
├── netlify.toml            # Netlify config
└── AGENTS.md               # AI assistant guidelines
```

## Adding Components

### 1. Create your component file

```bash
# Skill
mkdir -p files/skill/my-skill
echo "# My Skill\n\nInstructions..." > files/skill/my-skill/SKILL.md

# Plugin
touch files/plugin/my-plugin.ts

# Agent
touch files/agent/my-agent.md
```

### 2. Register it in `registry.jsonc`

```json
{
  "components": [
    {
      "name": "my-skill",
      "type": "ocx:skill",
      "description": "What it does",
      "files": ["skill/my-skill/SKILL.md"]
    }
  ]
}
```

### 3. Build and deploy

```bash
bun run build && bun run deploy
```

## Component Types

| Type | Purpose | Format |
|------|---------|--------|
| `ocx:skill` | AI behavior instructions | Markdown |
| `ocx:plugin` | OpenCode extensions | TypeScript |
| `ocx:agent` | Agent role definitions | Markdown |
| `ocx:command` | Custom TUI commands | Markdown |
| `ocx:tool` | Custom tool implementations | TypeScript |
| `ocx:bundle` | Component collections | JSON |

See [AGENTS.md](./AGENTS.md) for detailed documentation on each type.

## Configuration

### Cloudflare Workers (default)

Edit `wrangler.jsonc` to customize your worker name and settings.

### Vercel

Edit `vercel.json`. Build command and output directory are pre-configured.

### Netlify

Edit `netlify.toml`. Build command and publish directory are pre-configured.

## Documentation

- [OCX CLI Documentation](https://github.com/kdcokenny/ocx)
- [OpenCode Reference](https://raw.githubusercontent.com/kdcokenny/ocx/main/docs/OPENCODE_REFERENCE.md)
- [Registry Protocol](https://raw.githubusercontent.com/kdcokenny/ocx/main/docs/REGISTRY_PROTOCOL.md)

## License

MIT
