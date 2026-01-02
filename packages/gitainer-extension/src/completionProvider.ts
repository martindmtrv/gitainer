import * as vscode from 'vscode';
import { HydrationProvider } from './hydrationProvider';

export class CompletionProvider implements vscode.CompletionItemProvider {
    constructor(private hydrationProvider: HydrationProvider) { }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
        const line = document.lineAt(position.line);
        const lineText = line.text.substring(0, position.character);

        // Check if the user is typing an anchor reference (e.g., after '*')
        if (lineText.includes('*')) {
            const anchors = await this.getAnchorsFromFragments(document);
            return anchors.map(anchor => {
                const item = new vscode.CompletionItem(anchor.name, vscode.CompletionItemKind.Variable);
                item.detail = `Anchor from fragment: ${anchor.fragmentPath}`;
                item.documentation = new vscode.MarkdownString(`Source fragment: \`${anchor.fragmentPath}\`\n\n\`\`\`yaml\n${anchor.content}\n\`\`\``);
                return item;
            });
        }

        return [];
    }

    private async getAnchorsFromFragments(document: vscode.TextDocument): Promise<{ name: string, fragmentPath: string, content: string }[]> {
        const content = document.getText();
        const fragmentImports = Array.from(content.matchAll(HydrationProvider.IMPORT_REGEX)).map(m => m[1].trim());
        const results: { name: string, fragmentPath: string, content: string }[] = [];

        for (const fragmentPath of fragmentImports) {
            const fragmentContent = await this.hydrationProvider.getFragmentContent(fragmentPath, document);
            if (fragmentContent) {
                // Regex to find &anchor definitions
                const anchorDefRegex = /&([a-zA-Z0-9_-]+)/g;
                let match;
                while ((match = anchorDefRegex.exec(fragmentContent)) !== null) {
                    results.push({
                        name: match[1],
                        fragmentPath: fragmentPath,
                        content: fragmentContent
                    });
                }
            }
        }

        return results;
    }
}
