import { ChatMessage, ModelConfig } from '../common/types';

/**
 * Service to interact with a Large Language Model.
 * It handles API requests, including streaming responses and aborting requests.
 */
export class LLMService {
    private _abortController: AbortController | null = null;

    constructor() {}

    /**
     * Fetches a completion from the model in a streaming fashion.
     * @param prompt The prompt to send to the model.
     * @param config The configuration for the model endpoint.
     * @param onData A callback function to handle incoming data chunks.
     * @param onEnd A callback function to signal the end of the stream.
     * @param onError A callback function to handle any errors.
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

        try {
            const url = new URL(config.baseUrl);
            url.pathname = '/v1/chat/completions';
            
            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`
                },
                body: JSON.stringify({
                    model: config.modelId,
                    messages: messages,
                    stream: true
                }),
                signal: signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('Failed to get stream reader');
            }

            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                const chunk = decoder.decode(value, { stream: true });
                
                // OpenAI streaming API returns data in "data: { ... }" format.
                // We need to parse this to extract the actual content.
                const lines = chunk.split('\n').filter(line => line.trim().startsWith('data:'));
                for (const line of lines) {
                    const jsonStr = line.replace('data:', '').trim();
                    if (jsonStr === '[DONE]') {
                        break;
                    }
                    try {
                        const parsed = JSON.parse(jsonStr);
                        const content = parsed.choices[0]?.delta?.content;
                        if (content) {
                            onData(content);
                        }
                    } catch (e) {
                        console.error('Failed to parse stream chunk:', jsonStr);
                    }
                }
            }

        } catch (error) {
            if (signal.aborted) {
                console.log('Request aborted by user.');
            } else {
                onError(error);
            }
        } finally {
            onEnd();
            this._abortController = null;
        }
    }

    /**
     * Aborts the current in-flight request.
     */
    public abortRequest() {
        if (this._abortController) {
            this._abortController.abort();
        }
    }
}
