// src/extension/services/LLMService.ts (修改后完整文件)

import vscode from 'vscode';

import { ChatMessage, ModelConfig, TextChatMessage } from '../../common/types';

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

export interface ScheduleLlmOptions {
    maxRetries?: number;
}

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
    public minInterval: number;
    public concurrencyLimit: number;

    constructor() {
        // 在构造函数中设置一个临时的默认值，它们将被 StateManager 的值覆盖
        this.minInterval = 10000;
        this.concurrencyLimit = 10;
    }


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
     * 新增：对LLM的响应进行后处理，移除思考过程标签。
     * @param content 从LLM收到的原始字符串内容。
     * @returns 清理后的字符串。
     */
    private _postProcessResponse(content: string): string {
        if (typeof content !== 'string') {
            return content;
        }
        // 查找最后一个 </think> 或 </thinking> 标签
        const thinkEndTagRegex = /<\/think(ing)?>/gi;
        let lastIndex = -1;
        let match;

        // 循环找到最后一个匹配项的索引
        while ((match = thinkEndTagRegex.exec(content)) !== null) {
            lastIndex = match.index + match[0].length;
        }

        // 如果找到了结束标签，则截取它之后的内容
        if (lastIndex !== -1) {
            return content.substring(lastIndex).trim();
        }

        // 如果没有找到结束标签，返回原始内容
        return content;
    }

    /**
     * 将一个非流式的LLM调用任务加入队列，并由并行的速率限制调度器执行。
     * @param task 一个返回LLM调用Promise的函数，例如 `() => llm.invoke(messages)`
     * @returns 一个在任务完成时解析的Promise
     */
    public scheduleLlmCall<T>(task: () => Promise<T>, options?: ScheduleLlmOptions): Promise<T> {
        console.log(`[LLMService] ${new Date().toISOString()} A new call was scheduled. Queue size: ${this.requestQueue.length + 1}`);
        
        // 默认重试配置
        const { maxRetries = 3} = options || {};
        const retryDelay = this.minInterval;

        // 创建一个包含重试逻辑的包装器任务
        const retryWrapper = async (): Promise<T> => {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const result = await task();

                    // 检查特定于业务的失败条件：返回空字符串
                    if (typeof result === 'string' && result.trim() === '') {
                        if (attempt < maxRetries) {
                            console.warn(`[LLMService] Attempt ${attempt} returned an empty result. Retrying in ${retryDelay}ms...`);
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                            continue; // 继续下一次尝试
                        } else {
                            // 最后一次尝试仍然是空结果，抛出错误
                            throw new Error(`LLM returned an empty result after ${maxRetries} attempts.`);
                        }
                    }

                    // 如果结果有效，直接返回
                    return result;

                } catch (error) {
                    // 捕获真正的异常（如网络错误、API错误）
                    if (attempt < maxRetries) {
                        console.warn(`[LLMService] Attempt ${attempt} failed with error: ${error}. Retrying in ${retryDelay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    } else {
                        // 所有重试都失败了，重新抛出最后的错误
                        console.error(`[LLMService] All ${maxRetries} attempts failed.`);
                        throw error;
                    }
                }
            }
            // 此处理论上不可达，但为满足TypeScript编译器要求
            throw new Error("LLM call failed after all retries.");
        };

        return new Promise<T>((resolve, reject) => {
            const resolvingPostProcessor = (result: T) => {
                if (typeof result === 'string') {
                    const processedResult = this._postProcessResponse(result);
                    resolve(processedResult as T);
                } else if (result instanceof BaseMessage) {
                    if (typeof result.content === 'string') {
                        const processedContent = this._postProcessResponse(result.content);
                        const newResult = new AIMessage({
                            ...result,
                            content: processedContent,
                        });
                        resolve(newResult as T);
                    } else {
                        resolve(result);
                    }
                } else {
                    resolve(result);
                }
            };
            // 将包装后的任务推入队列，而不是原始任务
            this.requestQueue.push({ task: retryWrapper, resolve: resolvingPostProcessor, reject });
            this.processQueue();
        });
    }

    // 简化和修复 processQueue 逻辑
    private processQueue() {
        // 循环检查，直到无法再派发新任务
        while (this.requestQueue.length > 0 && this.activeRequests < this.concurrencyLimit) {
            const now = Date.now();
            const elapsed = now - this.lastRequestTime;
            const delay = Math.max(0, this.minInterval - elapsed);

            // 如果需要延迟，则设置一个定时器来重新触发 processQueue，然后退出循环
            if (delay > 0) {
                setTimeout(() => this.processQueue(), delay);
                return; // 退出当前循环，等待延迟结束
            }

            // 如果不需要延迟，立即派发一个任务
            const { task, resolve, reject } = this.requestQueue.shift()!;

            this.lastRequestTime = Date.now();
            this.activeRequests++;

            console.log(`[LLMService] ${new Date().toISOString()} Executing call. Active: ${this.activeRequests}, Queue: ${this.requestQueue.length}`);

            // 异步执行任务
            task()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    this.activeRequests--;
                    console.log(`[LLMService] ${new Date().toISOString()} Call finished. Active: ${this.activeRequests}, Queue: ${this.requestQueue.length}`);
                    // 任务完成后，再次尝试处理队列，以防有任务在等待
                    this.processQueue();
                });
        }
        // 如果循环结束（队列为空或达到并发上限），则函数自然返回。
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

            // Filter for text messages only and then map them
            const langchainMessages: BaseMessage[] = messages
                .filter((msg): msg is TextChatMessage => msg.type === 'text')
                .map(msg => msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content));

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