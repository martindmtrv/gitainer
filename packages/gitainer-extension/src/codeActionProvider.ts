import * as vscode from 'vscode';
import { HydrationProvider } from './hydrationProvider';

export class CodeActionProvider implements vscode.CodeActionProvider {
    constructor(private hydrationProvider: HydrationProvider) { }

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    async provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        _context: vscode.CodeActionContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        const line = document.lineAt(range.start.line);
        const match = HydrationProvider.IMPORT_REGEX.exec(line.text);
        HydrationProvider.IMPORT_REGEX.lastIndex = 0;

        if (match) {
            const fragmentPath = match[1].trim();
            const alias = match[2];
            let fragmentContent = await this.hydrationProvider.getFragmentContent(fragmentPath, document);
            if (fragmentContent) {
                if (alias) {
                    fragmentContent = fragmentContent.replace(/(^|\s)([&*])([a-zA-Z0-9_-]+)/g, `$1$2$3-${alias}`);
                }
                const requiredAnchors = await this.getRequiredAnchors(fragmentContent);
                const missingAnchors = requiredAnchors.filter(a => !this.isAnchorDefinedInDocument(document, a));

                if (missingAnchors.length > 0) {
                    let insertLine = 0;
                    let indent = '';
                    let prefixText = '';
                    for (let i = 0; i < document.lineCount; i++) {
                        if (/^[a-zA-Z0-9_-]+:/.test(document.lineAt(i).text)) {
                            insertLine = i + 1;
                            indent = this.getIndentString(document);
                            break;
                        }
                    }
                    if (!indent) {
                        prefixText = 'x-anchors:\n';
                        indent = this.getIndentString(document);
                    }

                    const fix = new vscode.CodeAction(`Gitainer: Autofill missing anchors`, vscode.CodeActionKind.QuickFix);
                    fix.edit = new vscode.WorkspaceEdit();
                    const insertText = prefixText + missingAnchors.map(a => `${indent}x-${a}: &${a}\n`).join('');
                    fix.edit.insert(document.uri, new vscode.Position(insertLine, 0), insertText);
                    return [fix];
                }
            }
        }

        return [];
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

    private getIndentString(document: vscode.TextDocument): string {
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
        if (editor && editor.options.insertSpaces !== undefined) {
            return editor.options.insertSpaces ? ' '.repeat(editor.options.tabSize as number || 2) : '\t';
        }
        const config = vscode.workspace.getConfiguration('editor', document.uri);
        return config.get<boolean>('insertSpaces', true) ? ' '.repeat(config.get<number>('tabSize', 2)) : '\t';
    }

    private isAnchorDefinedInDocument(document: vscode.TextDocument, anchorName: string): boolean {
        const text = document.getText();
        const defRegex = new RegExp(`&${anchorName}\\b`);
        return defRegex.test(text);
    }
}
