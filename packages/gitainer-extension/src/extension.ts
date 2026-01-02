import * as vscode from 'vscode';
import { HydrationProvider } from './hydrationProvider';
import { EnvProvider } from './envProvider';
import { HoverProvider } from './hoverProvider';
import { PreviewPanel } from './previewPanel';
import { CompletionProvider } from './completionProvider';
import { CodeActionProvider } from './codeActionProvider';

export function activate(context: vscode.ExtensionContext) {
    const hydrationProvider = new HydrationProvider();
    const envProvider = new EnvProvider();
    const hoverProvider = new HoverProvider(hydrationProvider, envProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('gitainer.previewHydration', () => {
            PreviewPanel.createOrShow(context.extensionUri, 'Hydration Preview', hydrationProvider);
        }),
        vscode.commands.registerCommand('gitainer.previewEnv', () => {
            PreviewPanel.createOrShow(context.extensionUri, 'Env Preview', envProvider);
        }),
        vscode.languages.registerHoverProvider('yaml', hoverProvider),
        vscode.languages.registerHoverProvider('dockercompose', hoverProvider),
        vscode.languages.registerHoverProvider('docker-compose', hoverProvider),
        vscode.languages.registerCompletionItemProvider('yaml', new CompletionProvider(hydrationProvider), '*', '#', ' ', '/'),
        vscode.languages.registerCompletionItemProvider('dockercompose', new CompletionProvider(hydrationProvider), '*', '#', ' ', '/'),
        vscode.languages.registerCompletionItemProvider('docker-compose', new CompletionProvider(hydrationProvider), '*', '#', ' ', '/'),
        vscode.languages.registerCodeActionsProvider('yaml', new CodeActionProvider(hydrationProvider), {
            providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds
        }),
        vscode.languages.registerCodeActionsProvider('dockercompose', new CodeActionProvider(hydrationProvider), {
            providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds
        }),
        vscode.languages.registerCodeActionsProvider('docker-compose', new CodeActionProvider(hydrationProvider), {
            providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds
        })
    );
}

export function deactivate() { }
