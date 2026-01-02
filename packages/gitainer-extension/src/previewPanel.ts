import * as vscode from 'vscode';

export class PreviewPanel {
    public static currentPanel: PreviewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, title: string, provider: { getHydratedContent: (doc: vscode.TextDocument) => Promise<string> }) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PreviewPanel.currentPanel) {
            PreviewPanel.currentPanel._panel.reveal(column);
            PreviewPanel.currentPanel._update(title, provider);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'gitainerPreview',
            title,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        PreviewPanel.currentPanel = new PreviewPanel(panel, title, provider);
    }

    private constructor(panel: vscode.WebviewPanel, title: string, provider: { getHydratedContent: (doc: vscode.TextDocument) => Promise<string> }) {
        this._panel = panel;

        this._update(title, provider);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose() {
        PreviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update(title: string, provider: { getHydratedContent: (doc: vscode.TextDocument) => Promise<string> }) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        this._panel.title = title;
        const content = await provider.getHydratedContent(editor.document);
        this._panel.webview.html = this._getHtmlForWebview(content);
    }

    private _getHtmlForWebview(content: string) {
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Gitainer Preview</title>
                <style>
                    :root {
                        color-scheme: light dark;
                    }
                    body { 
                        font-family: var(--vscode-font-family); 
                        font-size: var(--vscode-font-size);
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        padding: 20px; 
                        line-height: 1.6; 
                        margin: 0;
                    }
                    pre { 
                        background-color: var(--vscode-textCodeBlock-background); 
                        padding: 15px; 
                        border-radius: 5px; 
                        overflow: auto; 
                        border: 1px solid var(--vscode-widget-border); 
                        color: var(--vscode-editor-foreground); 
                        max-width: 100%;
                        white-space: pre-wrap;
                        word-wrap: break-word;
                    }
                    table { 
                        border-collapse: collapse; 
                        width: 100%; 
                        margin-top: 20px; 
                        background-color: var(--vscode-editor-background);
                    }
                    th, td { 
                        border: 1px solid var(--vscode-widget-border); 
                        padding: 12px; 
                        text-align: left; 
                    }
                    th { 
                        background-color: var(--vscode-editor-lineHighlightBackground); 
                        color: var(--vscode-editor-foreground);
                    }
                </style>
            </head>
            <body>
                <pre>${this._escapeHtml(content)}</pre>
            </body>
            </html>`;
    }

    private _escapeHtml(text: string) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}
