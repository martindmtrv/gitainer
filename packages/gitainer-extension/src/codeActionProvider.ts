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
        const actions: vscode.CodeAction[] = [];
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
                    fragmentContent = fragmentContent.replace(/^(x-[a-zA-Z0-9_-]*):/gm, `$1-${alias}:`);
                }
                const requiredAnchors = await this.getRequiredAnchors(fragmentContent);
                const missingAnchors = requiredAnchors.filter(a => !this.isAnchorDefinedInDocument(document, a));

                if (missingAnchors.length > 0) {
                    const commentText = alias ? `alias ${alias}` : 'unnamed import';
                    const commentSearchRegex = new RegExp(`^\\s*#\\s*${commentText}\\s*$`);
                    
                    let foundCommentLine = -1;
                    for (let i = 0; i < document.lineCount; i++) {
                        if (commentSearchRegex.test(document.lineAt(i).text)) {
                            foundCommentLine = i;
                            break;
                        }
                    }

                    const fix = new vscode.CodeAction(`Gitainer: Autofill missing anchors`, vscode.CodeActionKind.QuickFix);
                    fix.edit = new vscode.WorkspaceEdit();

                    if (foundCommentLine !== -1) {
                        const match = /^(\s*)/.exec(document.lineAt(foundCommentLine).text);
                        const currentIndent = match ? match[1] : this.getIndentString(document);
                        const insertText = missingAnchors.map(a => `${currentIndent}x-${a}: &${a}\n`).join('');
                        fix.edit.insert(document.uri, new vscode.Position(foundCommentLine + 1, 0), insertText);
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
                        fix.edit.insert(document.uri, new vscode.Position(insertLine, 0), insertText);
                    }
                    actions.push(fix);
                }

                const services = this.getServicesFromDocument(document);
                if (services.length > 0 && !alias) {
                    const expandFix = new vscode.CodeAction(`Gitainer: Create aliased import for all services`, vscode.CodeActionKind.QuickFix);
                    expandFix.edit = new vscode.WorkspaceEdit();
                    const replacementImports = services.map(s => `${line.text} as ${s}`).join('\n');
                    expandFix.edit.replace(document.uri, line.range, replacementImports);

                    let topLevelInsertLine = -1;
                    let defaultIndent = '';
                    let topLevelPrefixText = '';
                    let accumulatedInsertText = '';

                    for (const service of services) {
                        let serviceFragmentContent = fragmentContent;
                        serviceFragmentContent = serviceFragmentContent.replace(/(^|\s)([&*])([a-zA-Z0-9_-]+)/g, `$1$2$3-${service}`);
                        serviceFragmentContent = serviceFragmentContent.replace(/^(x-[a-zA-Z0-9_-]*):/gm, `$1-${service}:`);
                        
                        const requiredAnchors = await this.getRequiredAnchors(serviceFragmentContent);
                        const missingAnchors = requiredAnchors.filter(a => !this.isAnchorDefinedInDocument(document, a));
                        
                        if (missingAnchors.length > 0) {
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
                                expandFix.edit.insert(document.uri, new vscode.Position(foundCommentLine + 1, 0), insertText);
                            } else {
                                if (topLevelInsertLine === -1) {
                                    for (let i = 0; i < document.lineCount; i++) {
                                        if (/^x-[a-zA-Z0-9_-]+:/.test(document.lineAt(i).text)) {
                                            topLevelInsertLine = i + 1;
                                            defaultIndent = this.getIndentString(document);
                                            break;
                                        }
                                    }
                                    if (topLevelInsertLine === -1) {
                                        let firstImportLine = -1;
                                        for (let i = 0; i < document.lineCount; i++) {
                                            if (document.lineAt(i).text.startsWith('#!')) {
                                                firstImportLine = i;
                                                break;
                                            }
                                        }
                                        topLevelInsertLine = firstImportLine !== -1 ? firstImportLine : 0;
                                        topLevelPrefixText = 'x-vars:\n';
                                        defaultIndent = this.getIndentString(document);
                                    }
                                }
                                const comment = `${defaultIndent}# ${commentText}\n`;
                                const insertText = topLevelPrefixText + comment + missingAnchors.map(a => `${defaultIndent}x-${a}: &${a}\n`).join('');
                                topLevelPrefixText = ''; // Clear prefix after first use
                                accumulatedInsertText += insertText;
                            }
                        }
                    }

                    if (accumulatedInsertText) {
                        expandFix.edit.insert(document.uri, new vscode.Position(topLevelInsertLine, 0), accumulatedInsertText);
                    }

                    actions.push(expandFix);
                }
            }
        }

        return actions;
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
