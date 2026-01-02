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

## Usage

- Open a `docker-compose.yaml` file.
- Use the command palette (`Ctrl+Shift+P`) and search for:
  - `Gitainer: Preview Hydration`
  - `Gitainer: Preview Env Variables`
- Hover over any line starting with `#!` to see the fragment preview.
