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
        const importRegex = /^\s*#!\s*(.*?)\s*$/;
        const match = importRegex.exec(line.text);

        if (match) {
            const fragmentPath = match[1].trim();
            const fragmentContent = await this.hydrationProvider.getFragmentContent(fragmentPath, document);
            if (fragmentContent) {
                const requiredAnchors = await this.getRequiredAnchors(fragmentContent);
                const missingAnchors = requiredAnchors.filter(a => !this.isAnchorDefinedInDocument(document, a));

                if (missingAnchors.length > 0) {
                    const fix = new vscode.CodeAction(`Gitainer: Autofill missing anchors`, vscode.CodeActionKind.QuickFix);
                    fix.edit = new vscode.WorkspaceEdit();
                    const insertText = missingAnchors.map(a => `x-${a}: &${a}\n  \n`).join('');
                    fix.edit.insert(document.uri, new vscode.Position(range.start.line, 0), insertText);
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

    private isAnchorDefinedInDocument(document: vscode.TextDocument, anchorName: string): boolean {
        const text = document.getText();
        const defRegex = new RegExp(`&${anchorName}\\b`);
        return defRegex.test(text);
    }
}
