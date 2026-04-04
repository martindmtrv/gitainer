import * as vscode from 'vscode';
import * as path from 'path';
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

        // 1. Check if the user is typing an anchor reference (e.g., after '*')
        if (lineText.includes('*')) {
            const anchors = await this.getAnchorsFromFragments(document);
            return anchors.map(anchor => {
                const item = new vscode.CompletionItem(anchor.name, vscode.CompletionItemKind.Variable);
                item.detail = `Anchor from fragment: ${anchor.fragmentPath}`;
                item.documentation = new vscode.MarkdownString(`Source fragment: \`${anchor.fragmentPath}\`\n\n\`\`\`yaml\n${anchor.content}\n\`\`\``);
                return item;
            });
        }

        // 2. Check if the user is typing a fragment import (after '#!')
        if (line.text.startsWith('#!')) {
            // Ensure the cursor is after '#!'
            const hashBangIndex = line.text.indexOf('#!');
            if (position.character > hashBangIndex + 1) {
                return await this.provideFragmentPathCompletions(document, position, hashBangIndex);
            }
        }

        return [];
    }

    private async provideFragmentPathCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        hashBangIndex: number
    ): Promise<vscode.CompletionItem[]> {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return [];
        }

        const files = await vscode.workspace.findFiles('**/*.{yaml,yml}');
        const items: vscode.CompletionItem[] = [];

        // Calculate the range to replace: only the path part
        const lineText = document.lineAt(position.line).text;
        const match = HydrationProvider.IMPORT_REGEX.exec(lineText);
        HydrationProvider.IMPORT_REGEX.lastIndex = 0;

        let alias = '';
        let pathEndIndex = lineText.length;
        if (match) {
            alias = match[2] || '';
            // If alias exists, the path ends before ' as <alias>'
            if (alias) {
                const asIndex = lineText.lastIndexOf(' as ');
                if (asIndex !== -1) {
                    pathEndIndex = asIndex;
                }
            }
        }

        const range = new vscode.Range(
            position.line,
            hashBangIndex + 2,
            position.line,
            pathEndIndex
        );

        for (const file of files) {
            let relativePath = path.relative(folder.uri.fsPath, file.fsPath);

            // Skip the current file
            if (file.fsPath === document.uri.fsPath) {
                continue;
            }

            const item = new vscode.CompletionItem(relativePath, vscode.CompletionItemKind.File);
            item.range = range;
            item.insertText = ' ' + relativePath;

            // Check for required anchors in this fragment
            const fragmentContent = await this.hydrationProvider.getFragmentContent(relativePath, document);
            if (fragmentContent) {
                const requiredAnchors = await this.getRequiredAnchors(fragmentContent);
                if (requiredAnchors.length > 0) {
                    item.detail = `Requires: ${requiredAnchors.join(', ')}`;

                    // Add additionalTextEdits to autofill anchors above the import line
                    const edit = new vscode.TextEdit(
                        new vscode.Range(position.line, 0, position.line, 0),
                        requiredAnchors.map(a => `x-${a}${alias ? '-' + alias : ''}: &${a}${alias ? '-' + alias : ''}\n  \n`).join('')
                    );
                    item.additionalTextEdits = [edit];
                }
            }

            items.push(item);
        }

        return items;
    }

    private async getRequiredAnchors(fragmentContent: string): Promise<string[]> {
        const usedAnchors = new Set<string>();
        const definedAnchors = new Set<string>();

        const usedRegex = /\*([a-zA-Z0-9_-]+)/g;
        let match;
        while ((match = usedRegex.exec(fragmentContent)) !== null) {
            usedAnchors.add(match[1]);
        }

        const defRegex = /&([a-zA-Z0-9_-]+)/g;
        while ((match = defRegex.exec(fragmentContent)) !== null) {
            definedAnchors.add(match[1]);
        }

        return Array.from(usedAnchors).filter(a => !definedAnchors.has(a));
    }

    private async getAnchorsFromFragments(document: vscode.TextDocument): Promise<{ name: string, fragmentPath: string, content: string }[]> {
        const content = document.getText();
        const matches = Array.from(content.matchAll(HydrationProvider.IMPORT_REGEX));
        const results: { name: string, fragmentPath: string, content: string }[] = [];

        for (const match of matches) {
            const fragmentPath = match[1].trim();
            const alias = match[2];
            let fragmentContent = await this.hydrationProvider.getFragmentContent(fragmentPath, document);
            if (fragmentContent) {
                if (alias) {
                    fragmentContent = fragmentContent.replace(/(^|\s)([&*])([a-zA-Z0-9_-]+)/g, `$1$2$3-${alias}`);
                }
                const anchorDefRegex = /&([a-zA-Z0-9_-]+)/g;
                let anchorMatch;
                while ((anchorMatch = anchorDefRegex.exec(fragmentContent)) !== null) {
                    results.push({
                        name: anchorMatch[1],
                        fragmentPath: `${fragmentPath}${alias ? ' as ' + alias : ''}`,
                        content: fragmentContent
                    });
                }
            }
        }

        return results;
    }
}
