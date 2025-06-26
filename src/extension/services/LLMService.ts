// src/extension/services/LLMService.ts (修改后完整文件)

import vscode from 'vscode';
// highlight-start
import { ChatMessage, ModelConfig, TextChatMessage } from '../../common/types';
// highlight-end
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

const USE_GEMINI = false;

export interface CreateModelOptions {
    modelConfig: ModelConfig; 
    temperature?: number;
    streaming?: boolean;
}

/**
 * 定义一个可以放入队列的LLM任务。
 * 它包含一个返回Promise的函数，以及用于解决该Promise的resolver和rejecter。
 */
type LlmTask<T> = {
    task: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
};

async function getGoogleApiKey(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return undefined;
    const workspaceRoot = workspaceFolders[0].uri;
    const envPath = vscode.Uri.joinPath(workspaceRoot, '.codewiki', '.env');
    try {
        const contentBytes = await vscode.workspace.fs.readFile(envPath);
        const content = Buffer.from(contentBytes).toString('utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('GOOGLE_API_KEY=')) {
                return trimmedLine.substring('GOOGLE_API_KEY='.length).trim();
            }
        }
    } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
            console.error("Error reading .codewiki/.env file:", error);
        }
    }
    return undefined;
}

export class LLMService {
    private _abortController: AbortController | null = null;

    // --- 新的并行速率限制器属性 ---
    private requestQueue: LlmTask<any>[] = [];
    private activeRequests = 0;
    private isProcessing = false;
    private lastRequestTime = 0;

    // --- 配置 ---
    // 每秒最多发送1个请求（1 RPS），设置为1100ms以提供缓冲
    private readonly minInterval = 1100; 
    // 最大并发请求数，防止过多请求同时进行
    private readonly concurrencyLimit = 10; 

    constructor() {}

    public async createModel(options: CreateModelOptions): Promise<BaseChatModel> {
        const { modelConfig, temperature = 0.7, streaming = false } = options;
        if (USE_GEMINI) {
            console.log("[LLMService] Creating model using Google Gemini.");
            const apiKey = await getGoogleApiKey();
            if (!apiKey) throw new Error("Gemini execution failed: 'GOOGLE_API_KEY' not found in your .codewiki/.env file.");
            return new ChatGoogleGenerativeAI({ model: "gemini-1.5-flash-latest", apiKey, temperature });
        }
        
        const url = new URL(modelConfig.baseUrl);
        if (!url.pathname.includes('/v1')) {
            url.pathname = ('/v1' + url.pathname).replace(/\/+/g, '/');
        }
        const finalBaseUrl = url.toString().replace(/\/$/, '');

        return new ChatOpenAI({
            modelName: modelConfig.modelId,
            apiKey: modelConfig.apiKey,
            streaming,
            temperature,
            configuration: { baseURL: finalBaseUrl }
        });
    }

    /**
     * 将一个非流式的LLM调用任务加入队列，并由并行的速率限制调度器执行。
     * @param task 一个返回LLM调用Promise的函数，例如 `() => llm.invoke(messages)`
     * @returns 一个在任务完成时解析的Promise
     */
    public scheduleLlmCall<T>(task: () => Promise<T>): Promise<T> {
        console.log(`[LLMService] A new call was scheduled. Queue size: ${this.requestQueue.length + 1}`);
        return new Promise<T>((resolve, reject) => {
            this.requestQueue.push({ task, resolve, reject });
            // 触发处理流程
            this.processQueue();
        });
    }

    private async processQueue() {
        // 如果正在处理或者队列为空，或者已达到并发上限，则返回
        if (this.isProcessing || this.requestQueue.length === 0 || this.activeRequests >= this.concurrencyLimit) {
            return;
        }

        this.isProcessing = true;

        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        const delay = Math.max(0, this.minInterval - elapsed);

        // 使用setTimeout来延迟执行，从而不阻塞当前事件循环
        setTimeout(() => {
            // 在延迟后，再次检查条件，以防状态改变
            if (this.requestQueue.length === 0 || this.activeRequests >= this.concurrencyLimit) {
                this.isProcessing = false;
                return;
            }

            const { task, resolve, reject } = this.requestQueue.shift()!;
            
            this.lastRequestTime = Date.now();
            this.activeRequests++;

            console.log(`[LLMService] Executing call. Active: ${this.activeRequests}, Queue: ${this.requestQueue.length}`);

            // 立即释放锁并尝试调度下一个，实现并行
            this.isProcessing = false;
            this.processQueue(); 

            // 异步执行任务
            task()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    this.activeRequests--;
                    // 任务完成后，再次尝试处理队列，以防有任务因达到并发上限而等待
                    this.processQueue();
                });
                
        }, delay);
    }

    public async getCompletion(
        messages: ChatMessage[],
        config: ModelConfig,
        onData: (chunk: string) => void,
        onEnd: () => void,
        onError: (error: any) => void
    ): Promise<void> {
        this._abortController = new AbortController();
        const signal = this._abortController.signal;
        let llm: BaseChatModel;

        try {
            llm = await this.createModel({ modelConfig: config, streaming: true, temperature: 0.7 });
            // highlight-start
            // Filter for text messages only and then map them
            const langchainMessages: BaseMessage[] = messages
                .filter((msg): msg is TextChatMessage => msg.type === 'text')
                .map(msg => msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content));
            // highlight-end
            const stream = await llm.stream(langchainMessages, { signal });
            for await (const chunk of stream) {
                if (chunk.content) {
                    onData(chunk.content as string);
                }
            }
        } catch (error: any) {
            if (signal.aborted) {
                console.log('Request aborted by user.');
            } else {
                console.error("--- LANGCHAIN REQUEST FAILED ---");
                 if (error instanceof Error) {
                     console.error("Full Error Object:", error);
                     onError(error);
                 } else {
                     console.error("Unknown Error:", error);
                     onError(new Error(String(error)));
                 }
                console.error("--- END OF ERROR ---");
            }
        } finally {
            onEnd();
            this._abortController = null;
        }
    }

    public abortRequest() {
        if (this._abortController) {
            this._abortController.abort();
        }
    }
}