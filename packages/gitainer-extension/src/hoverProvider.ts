import * as vscode from 'vscode';
import { HydrationProvider } from './hydrationProvider';
import { EnvProvider } from './envProvider';

export class HoverProvider implements vscode.HoverProvider {
    constructor(
        private hydrationProvider: HydrationProvider,
        private envProvider: EnvProvider
    ) { }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const line = document.lineAt(position.line);

        // 1. Check for #! fragment import hover
        const fragmentImportRegex = /^\s*#!\s*(.*?)\s*$/;
        const fragmentMatch = fragmentImportRegex.exec(line.text);
        if (fragmentMatch) {
            const fragmentPath = fragmentMatch[1].trim();
            const content = await this.hydrationProvider.getFragmentContent(fragmentPath, document);
            if (content) {
                const markdown = new vscode.MarkdownString();
                markdown.appendCodeblock(content, 'yaml');
                return new vscode.Hover(markdown);
            }
        }

        // 2. Check for environment variable hover
        const envVarRegex = /\$(?:([a-zA-Z_][a-zA-Z0-9_]*)|{([a-zA-Z_][a-zA-Z0-9_]*)})/g;
        let envMatch;
        while ((envMatch = envVarRegex.exec(line.text)) !== null) {
            const start = envMatch.index;
            const end = envMatch.index + envMatch[0].length;
            if (position.character >= start && position.character <= end) {
                const varName = envMatch[1] || envMatch[2];
                const envMap = await this.envProvider.getEnvMap(document);
                const value = envMap[varName];
                if (value !== undefined) {
                    const markdown = new vscode.MarkdownString();
                    markdown.appendMarkdown(`**Environment Variable**\n\n`);
                    markdown.appendMarkdown(`\`${varName}\` = \`${value}\``);
                    return new vscode.Hover(markdown);
                }
            }
        }

        // 3. Check for YAML anchor reference hover
        const anchorRefRegex = /\*([a-zA-Z0-9_-]+)/g;
        let anchorMatch;
        while ((anchorMatch = anchorRefRegex.exec(line.text)) !== null) {
            const start = anchorMatch.index;
            const end = anchorMatch.index + anchorMatch[0].length;
            if (position.character >= start && position.character <= end) {
                const anchorName = anchorMatch[1];
                return await this.provideAnchorHover(document, anchorName);
            }
        }

        return undefined;
    }

    private async provideAnchorHover(document: vscode.TextDocument, anchorName: string): Promise<vscode.Hover | undefined> {
        const content = document.getText();
        const fragmentImports = Array.from(content.matchAll(HydrationProvider.IMPORT_REGEX)).map(m => m[1].trim());

        for (const fragmentPath of fragmentImports) {
            const fragmentContent = await this.hydrationProvider.getFragmentContent(fragmentPath, document);
            if (fragmentContent) {
                // Look for anchor definition &anchorName
                const anchorDefRegex = new RegExp(`&${anchorName}\\b`);
                if (anchorDefRegex.test(fragmentContent)) {
                    const markdown = new vscode.MarkdownString();
                    markdown.appendMarkdown(`**Source Fragment:** \`${fragmentPath}\`\n\n`);
                    markdown.appendCodeblock(fragmentContent, 'yaml');
                    return new vscode.Hover(markdown);
                }
            }
        }

        return undefined;
    }
}
