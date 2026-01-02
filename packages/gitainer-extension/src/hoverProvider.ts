import * as vscode from 'vscode';
import { HydrationProvider } from './hydrationProvider';

export class HoverProvider implements vscode.HoverProvider {
    constructor(private hydrationProvider: HydrationProvider) { }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const line = document.lineAt(position.line);
        const hoverRegex = /^\s*#!\s*(.*?)\s*$/;
        const match = hoverRegex.exec(line.text);

        if (match) {
            const fragmentPath = match[1].trim();
            const content = await this.hydrationProvider.getFragmentContent(fragmentPath, document);

            if (content) {
                const markdown = new vscode.MarkdownString();
                markdown.appendCodeblock(content, 'yaml');
                return new vscode.Hover(markdown);
            }
        }

        return undefined;
    }
}
