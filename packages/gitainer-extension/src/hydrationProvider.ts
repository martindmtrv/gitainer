import * as vscode from 'vscode';

export class HydrationProvider {
    static readonly IMPORT_REGEX = /^#!\s*(.*?)(?:\s+as\s+([a-zA-Z0-9_-]+))?\s*$/mg;

    async getHydratedContent(document: vscode.TextDocument): Promise<string> {
        let content = document.getText();
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return content;
        }

        const matches = Array.from(content.matchAll(HydrationProvider.IMPORT_REGEX));
        const fragments: string[] = [];

        for (const match of matches) {
            const fragmentPath = match[1];
            const alias = match[2];
            const fragmentUri = fragmentPath.startsWith('/')  
                ? vscode.Uri.file(fragmentPath) 
                : vscode.Uri.joinPath(folder.uri, fragmentPath);

            try {
                const uint8Array = await vscode.workspace.fs.readFile(fragmentUri);
                let fragmentContent = new TextDecoder().decode(uint8Array);
                if (alias) {
                    fragmentContent = fragmentContent.replace(/(^|\s)([&*])([a-zA-Z0-9_-]+)/g, `$1$2$3-${alias}`);
                    fragmentContent = fragmentContent.replace(/^(x-[a-zA-Z0-9_-]*):/gm, `$1-${alias}:`);
                }
                fragments.push(`# fragment -> ${fragmentPath}${alias ? ' as ' + alias : ''}\n${fragmentContent}`);
            } catch (e) {
                fragments.push(`# fragment -> ${fragmentPath}${alias ? ' as ' + alias : ''} (NOT FOUND)`);
            }
        }

        if (fragments.length === 0) {
            return content;
        }

        // Simple implementation of hydration logic similar to GitConsumer.ts
        const servicesIndex = content.search(/^services:\s*/m);
        if (servicesIndex === -1) {
            return content + "\n\n# === fragments start ===\n" + fragments.join('\n') + "\n# === fragments end ===\n";
        }

        return content.slice(0, servicesIndex) +
            "\n# === fragments start ===\n" +
            fragments.join('\n') +
            "\n# === fragments end ===\n" +
            content.slice(servicesIndex);
    }

    async getFragmentContent(fragmentPath: string, document: vscode.TextDocument): Promise<string | undefined> {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return undefined;
        }

        const fragmentUri = fragmentPath.startsWith('/') 
            ? vscode.Uri.file(fragmentPath) 
            : vscode.Uri.joinPath(folder.uri, fragmentPath);

        try {
            const uint8Array = await vscode.workspace.fs.readFile(fragmentUri);
            return new TextDecoder().decode(uint8Array);
        } catch (e) {
            return undefined;
        }
    }
}
