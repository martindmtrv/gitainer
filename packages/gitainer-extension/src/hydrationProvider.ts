import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class HydrationProvider {
    static readonly IMPORT_REGEX = /^#!\s*(.*?)\s*$/mg;

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
            const fullPath = path.isAbsolute(fragmentPath)
                ? fragmentPath
                : path.join(folder.uri.fsPath, fragmentPath);

            if (fs.existsSync(fullPath)) {
                const fragmentContent = fs.readFileSync(fullPath, 'utf8');
                fragments.push(`# fragment -> ${fragmentPath}\n${fragmentContent}`);
            } else {
                fragments.push(`# fragment -> ${fragmentPath} (NOT FOUND)`);
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

        const fullPath = path.isAbsolute(fragmentPath)
            ? fragmentPath
            : path.join(folder.uri.fsPath, fragmentPath);

        if (fs.existsSync(fullPath)) {
            return fs.readFileSync(fullPath, 'utf8');
        }
        return undefined;
    }
}
