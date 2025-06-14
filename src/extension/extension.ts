import * as vscode from 'vscode';
import { CodeWikiViewProvider } from './CodeWikiViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new CodeWikiViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CodeWikiViewProvider.viewType, provider)
    );
}

export function deactivate() {}
