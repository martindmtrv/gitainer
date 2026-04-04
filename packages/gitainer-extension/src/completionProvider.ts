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

        const lineText = document.lineAt(position.line).text;
        const lineTextUpToCursor = lineText.substring(0, position.character);
        
        const asMatch = /#!\s*(.*?)\s+as\s+([a-zA-Z0-9_-]*)$/.exec(lineTextUpToCursor);
        if (asMatch) {
            const fragmentPath = asMatch[1].trim();
            const currentTypedAlias = asMatch[2];
            return this.provideAliasCompletions(document, position, fragmentPath, currentTypedAlias);
        }
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
                    // Removed automatic additionalTextEdits insertion here.
                    // Instead, rely on the CodeAction Quick Fix to append required variables
                    // once the user has finished typing their import and possible alias.
                }
            }

            items.push(item);
        }

        return items;
    }

    private async provideAliasCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        fragmentPath: string,
        currentTypedAlias: string
    ): Promise<vscode.CompletionItem[]> {
        const services = this.getServicesFromDocument(document);
        if (services.length === 0) return [];

        const items: vscode.CompletionItem[] = [];
        const startIndex = position.character - currentTypedAlias.length;
        const range = new vscode.Range(position.line, startIndex, position.line, position.character);

        let baseFragmentContent = await this.hydrationProvider.getFragmentContent(fragmentPath, document);

        for (const service of services) {
            const item = new vscode.CompletionItem(service, vscode.CompletionItemKind.Value);
            item.range = range;

            if (baseFragmentContent) {
                let fragmentContent = baseFragmentContent;
                fragmentContent = fragmentContent.replace(/(^|\s)([&*])([a-zA-Z0-9_-]+)/g, `$1$2$3-${service}`);
                fragmentContent = fragmentContent.replace(/^(x-[a-zA-Z0-9_-]*):/gm, `$1-${service}:`);
                
                const requiredAnchors = await this.getRequiredAnchors(fragmentContent);
                const missingAnchors = requiredAnchors.filter(a => !this.isAnchorDefinedInDocument(document, a));

                if (missingAnchors.length > 0) {
                    item.detail = `Requires: ${missingAnchors.join(', ')}`;
                    const commentText = `alias ${service}`;
                    const commentSearchRegex = new RegExp(`^\\s*#\\s*${commentText}\\s*$`);
                    
                    let foundCommentLine = -1;
                    for (let i = 0; i < document.lineCount; i++) {
                        if (commentSearchRegex.test(document.lineAt(i).text)) {
                            foundCommentLine = i;
                            break;
                        }
                    }

                    if (foundCommentLine !== -1) {
                        const match = /^(\s*)/.exec(document.lineAt(foundCommentLine).text);
                        const currentIndent = match ? match[1] : this.getIndentString(document);
                        const insertText = missingAnchors.map(a => `${currentIndent}x-${a}: &${a}\n`).join('');
                        const edit = new vscode.TextEdit(
                            new vscode.Range(foundCommentLine + 1, 0, foundCommentLine + 1, 0),
                            insertText
                        );
                        item.additionalTextEdits = [edit];
                    } else {
                        let insertLine = -1;
                        let indent = '';
                        let prefixText = '';
                        for (let i = 0; i < document.lineCount; i++) {
                            if (/^x-[a-zA-Z0-9_-]+:/.test(document.lineAt(i).text)) {
                                insertLine = i + 1;
                                indent = this.getIndentString(document);
                                break;
                            }
                        }
                        if (insertLine === -1) {
                            let firstImportLine = -1;
                            for (let i = 0; i < document.lineCount; i++) {
                                if (document.lineAt(i).text.startsWith('#!')) {
                                    firstImportLine = i;
                                    break;
                                }
                            }
                            insertLine = firstImportLine !== -1 ? firstImportLine : 0;
                            prefixText = 'x-vars:\n';
                            indent = this.getIndentString(document);
                        }

                        const comment = `${indent}# ${commentText}\n`;
                        const insertText = prefixText + comment + missingAnchors.map(a => `${indent}x-${a}: &${a}\n`).join('');
                        const edit = new vscode.TextEdit(
                            new vscode.Range(insertLine, 0, insertLine, 0),
                            insertText
                        );
                        item.additionalTextEdits = [edit];
                    }
                }
            }

            items.push(item);
        }

        return items;
    }

    private getServicesFromDocument(document: vscode.TextDocument): string[] {
        const services: string[] = [];
        let inServices = false;
        let servicesIndent = -1;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (line.trim().startsWith('#')) continue;

            if (/^services:\s*$/.test(line)) {
                inServices = true;
                continue;
            }

            if (inServices) {
                const match = /^(\s+)([a-zA-Z0-9_-]+):/.exec(line);
                if (match) {
                    const indent = match[1].length;
                    if (servicesIndent === -1) {
                        servicesIndent = indent;
                        services.push(match[2]);
                    } else if (indent === servicesIndent) {
                        services.push(match[2]);
                    } else if (indent < servicesIndent) {
                        if (/^[a-zA-Z0-9_-]+:/.test(line)) inServices = false;
                    }
                } else if (/^[a-zA-Z0-9_-]+:/.test(line)) {
                    inServices = false;
                }
            }
        }
        return services;
    }

    private isAnchorDefinedInDocument(document: vscode.TextDocument, anchorName: string): boolean {
        const text = document.getText();
        const defRegex = new RegExp(`&${anchorName}\\b`);
        return defRegex.test(text);
    }

    private getIndentString(document: vscode.TextDocument): string {
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
        if (editor && editor.options.insertSpaces !== undefined) {
            return editor.options.insertSpaces ? ' '.repeat(editor.options.tabSize as number || 2) : '\t';
        }
        const config = vscode.workspace.getConfiguration('editor', document.uri);
        return config.get<boolean>('insertSpaces', true) ? ' '.repeat(config.get<number>('tabSize', 2)) : '\t';
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
                    fragmentContent = fragmentContent.replace(/^(x-[a-zA-Z0-9_-]*):/gm, `$1-${alias}:`);
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
