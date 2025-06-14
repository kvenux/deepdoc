import type { PostMessage } from '../common/types';

/**
 * A typed wrapper around the VS Code API that is exposed to the webview.
 */
interface VsCodeApi {
    postMessage(message: PostMessage): void;
    getState(): any;
    setState(newState: any): void;
}

declare const acquireVsCodeApi: () => VsCodeApi;

export const vscode = acquireVsCodeApi();
