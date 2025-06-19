// src/extension/LLMService.ts

import vscode from 'vscode';
import { ChatMessage, ModelConfig } from '../common/types';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

/**
 * 标志位：设置为 true 以使用 Gemini，设置为 false 则使用 settings.json 中的模型配置。
 * 使用 Gemini 前，请确保已安装 `@langchain/google-genai` 并在 `.codewiki/.env` 文件中配置了 GOOGLE_API_KEY。
 */
const USE_GEMINI = true;

/**
 * 创建模型实例时使用的选项。
 */
export interface CreateModelOptions {
    // 当不使用 Gemini 时，需要此配置来创建 OpenAI 或兼容模型
    modelConfig: ModelConfig; 
    temperature?: number;
    streaming?: boolean;
}

/**
 * 从工作区的 .codewiki/.env 文件中安全地读取 Google API 密钥。
 * @returns {Promise<string | undefined>} 返回 API 密钥或 undefined。
 */
async function getGoogleApiKey(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return undefined;
    }
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


/**
 * 服务类，用于与大语言模型交互。
 * 此类现在是创建模型实例的唯一入口点，整合了 OpenAI 和 Gemini 的逻辑。
 */
export class LLMService {
    private _abortController: AbortController | null = null;

    constructor() {}

    /**
     * 统一的模型创建工厂方法。
     * 根据 USE_GEMINI 标志和传入的选项，创建并返回一个 LLM 实例。
     * @param options - 创建模型所需的配置，包括温度、是否流式等。
     * @returns {Promise<BaseChatModel>} 一个配置好的 LangChain 模型实例。
     */
    public async createModel(options: CreateModelOptions): Promise<BaseChatModel> {
        const { modelConfig, temperature = 0.7, streaming = false } = options;

        if (USE_GEMINI) {
            console.log("[LLMService] Creating model using Google Gemini.");
            const apiKey = await getGoogleApiKey();
            if (!apiKey) {
                throw new Error("Gemini execution failed: 'GOOGLE_API_KEY' not found in your .codewiki/.env file.");
            }
            // Gemini 对温度的支持可能与 OpenAI 不同，这里直接传入
            return new ChatGoogleGenerativeAI({
                model: "gemini-2.5-flash", 
                apiKey: apiKey,
                temperature,
                // Gemini 的 streaming 是通过 .stream() 方法控制的，这里设置 streaming 属性可能无效，但为了接口统一保留
            });
        }
        
        // 默认使用 OpenAI 或兼容的代理
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
            configuration: {
                baseURL: finalBaseUrl,
            }
        });
    }


    /**
     * 获取模型的流式补全。
     * @param messages 聊天消息历史
     * @param config 选定的模型配置
     * @param onData 接收到数据块时的回调
     * @param onEnd 完成时的回调
     * @param onError 出错时的回调
     */
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
            // 使用新的工厂方法创建模型实例
            llm = await this.createModel({
                modelConfig: config,
                streaming: true,
                temperature: 0.7 // Standard temperature for chat
            });

            const langchainMessages: BaseMessage[] = messages.map(msg => {
                return msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content);
            });

            const stream = await llm.stream(langchainMessages, {
                signal: signal,
            });

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
                // 构造错误信息，因为我们不知道是哪个URL
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