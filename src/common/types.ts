/**
 * Defines the structure for messages posted between the Webview and the Extension Host.
 */
export interface PostMessage {
    command: string;
    payload?: any;
}

/**
 * Represents the configuration for a single language model.
 */
export interface ModelConfig {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    modelId: string;
    isDefault?: boolean;
}

/**
 * Represents a single message in a conversation, from either the user or the model (assistant).
 */
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    // Additional metadata can be added here, e.g., timestamps, message ID, etc.
}

/**
 * Represents a full conversation, including its ID, title, and all messages.
 */
export interface Conversation {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: string; // ISO 8601 date string
}

/**
 * Represents a reusable prompt template.
 */
export interface Prompt {
    id: string;
    title: string;
    content: string;
    createdAt: string; // ISO 8601 date string
    updatedAt: string; // ISO 8601 date string
}
