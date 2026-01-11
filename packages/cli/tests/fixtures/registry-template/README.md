# OCX Registry Starter

A ready-to-deploy component registry for [OpenCode](https://opencode.ai).

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
