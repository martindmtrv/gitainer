# Gitainer VS Code Extension

Preview Gitainer stack hydration and environment variables directly in VS Code.

## Features

- **Hydration Preview**: See how your `docker-compose.yaml` looks after resolving all `#!` fragment imports.
- **Env Variables Preview**: View a table of all environment variables used in your compose file and their resolved values from `.env`.
- **IntelliSense Hover**: Hover over `#!` fragment import lines to see the content of the fragment without opening the file.

## Installation

### From Source

1. Clone the repository.
2. Navigate to `packages/gitainer-extension`.
3. Install dependencies:
   ```bash
   bun install
   ```
4. Build the extension:
   ```bash
   bun run compile
   ```
5. Press `F5` in VS Code to open a new window with the extension loaded, or package it (see below).

### Using VSIX Package

1. Generate the `.vsix` package:
   ```bash
   bun run package
   ```
2. In VS Code, go to the Extensions view (`Ctrl+Shift+X`).
3. Click the `...` (Views and More Actions) menu and select **Install from VSIX...**.
4. Select the generated `gitainer-extension-0.0.1.vsix` file.

### Advanced Features

- **Variable Hovers**: Hover over `$VAR` to see resolved values.
- **Anchor Hovers/Completion**: Hover over `*anchor` to see its source fragment, and get completions for anchors defined in fragments.
- **Anchor Autofill**: Automatically insert required anchor templates when importing fragments.

## Publishing

To publish the extension to the VS Code Marketplace:

1. Create a publisher at [Manage Publishers](https://marketplace.visualstudio.com/manage).
2. Create a Personal Access Token (PAT) in Azure DevOps with `Marketplace -> Publish` scope.
3. Use the helper script:
   ```bash
   ./publish.sh <YOUR_PAT>
   ```
   Or run the bun script:
   ```bash
   bun run publish -- -p <YOUR_PAT>
   ```

## Development

- `bun run compile`: Build the extension.
- `bun run watch`: Build and watch for changes.
- `bun run package`: Create a `.vsix` file.
