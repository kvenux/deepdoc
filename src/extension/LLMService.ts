import { ChatMessage, ModelConfig } from '../common/types';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';

/**
 * Service to interact with a Large Language Model using Langchain.js.
 * It handles API requests, including streaming responses and aborting requests.
 */
export class LLMService {
    private _abortController: AbortController | null = null;

    constructor() {}

    public async getCompletion(
        messages: ChatMessage[],
        config: ModelConfig,
        onData: (chunk: string) => void,
        onEnd: () => void,
        onError: (error: any) => void
    ): Promise<void> {
        this._abortController = new AbortController();
        const signal = this._abortController.signal;

        let finalBaseUrl = '';

        try {
            // ==================== FINAL AND CORRECT FIX ====================
            // The root cause is the missing `/v1` in the final URL.
            // Langchain's `@langchain/openai` expects the `baseURL` to contain the API version,
            // e.g., `https://api.openai.com/v1`. It only appends the resource path like `/chat/completions`.

            // Let's create a robust logic to ensure the baseURL is correct.
            const url = new URL(config.baseUrl);

            // Check if the path already contains `/v1`. If not, add it.
            // This handles inputs like "https://api.openai.com" and "https://my-proxy.com".
            if (!url.pathname.includes('/v1')) {
                // Prepend `/v1` to any existing path, or set it if path is empty.
                url.pathname = ('/v1' + url.pathname).replace(/\/+/g, '/'); // Avoids double slashes
            }

            finalBaseUrl = url.toString().replace(/\/$/, ''); // Remove trailing slash

            const llm = new ChatOpenAI({
                modelName: config.modelId,
                apiKey: config.apiKey,
                streaming: true,
                temperature: 0.7,
                configuration: {
                    baseURL: finalBaseUrl,
                }
            });
            // ===============================================================

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

        } catch (error) {
            if (signal.aborted) {
                console.log('Request aborted by user.');
            } else {
                console.error("--- LANGCHAIN REQUEST FAILED ---");
                const attemptedUrl = `${finalBaseUrl}/chat/completions`;
                console.error(`Attempted to request: POST ${attemptedUrl}`);
                console.error("Model Config Used:", { ...config, apiKey: `...${config.apiKey.slice(-4)}`, finalBaseUrlUsed: finalBaseUrl });
                console.error("Full Error Object:", error);
                console.error("--- END OF ERROR ---");
                onError(error);
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