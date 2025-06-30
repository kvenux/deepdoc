// --- file_path: common/types.ts ---
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
 * 新增：代表性能和限制相关的配置。
 */
export interface PerformanceConfig {
    concurrencyLimit: number; // LLM 并发请求数
    minInterval: number;      // LLM 请求最小间隔 (ms)
    maxTokensPerBatch: number; // Map-Reduce 每批最大 Token 数
    maxTokensForDirectAnalysis: number; // 直接分析的最大 Token 阈值
}

/**
 * 新增：代表一个已完成并被持久化的 Agent 运行记录中单个步骤的状态。
 * 注意：这不包含 runId 或 isCollapsed 等瞬态/UI状态。
 */
export interface SavedStepState {
    stepName: string;
    taskId?: string;
    status: 'running' | 'completed' | 'failed' | 'waiting';
    logs: { type: 'input' | 'output' | 'llm-request', data: any, metadata?: Record<string, any> }[];
    streamedContent: string;
    error?: string;
}


/**
 * 新增：代表一个已完成并被持久化的 Agent 运行记录。
 */
export interface AgentRunRecord {
    plan: AgentPlan;
    // 注意：executionState 的 key 是 stepKey (taskId 或 stepName)
    executionState: Record<string, SavedStepState>;
    result: AgentResult;
}

/**
 * 代表一个标准的文本消息。
 */
export interface TextChatMessage {
    type: 'text';
    role: 'user' | 'assistant';
    content: string;
}

/**

 * 代表一个已完成的 Agent 运行消息。
 */
export interface AgentRunChatMessage {
    type: 'agent_run';
    role: 'assistant'; // Agent 运行总是被视为 'assistant' 的一部分
    run: AgentRunRecord;
}

/**
 * 代表一个完整的消息，可以是文本或 Agent 运行。
 */
export type ChatMessage = TextChatMessage | AgentRunChatMessage;


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

/**
 * =======================================================================
 * Agent Execution Event & Plan Types
 * =======================================================================
 */

/**
 * 定义了一个Agent执行计划中的单个步骤。
 */
export interface AgentPlanStep {
    name: string;
    description: string;
    promptFiles?: string[]; // 使用的YML文件名
}

/**
 * 描述了Agent的完整执行计划。
 */
export interface AgentPlan {
    agentName: string;
    agentId: string;
    steps: AgentPlanStep[];
    parameters: { // 需要用户输入的参数
        name: string;
        description: string;
        type: 'path' | 'string';
        value?: any; // 解析后的或用户输入的值
        isValid?: boolean;
        error?: string;
    }[];
}

/**
 * 代表一个正在执行的步骤或子任务。
 */
export interface StepExecution {
    runId: string; // 整个Agent运行的唯一ID
    stepName: string; //
    taskId?: string; // 并行任务中，子任务的唯一ID
    status: 'running' | 'completed' | 'failed' | 'waiting';
}

/**
 * 用于更新一个正在执行的步骤的信息。
 */
export interface StepUpdate {
    runId: string;
    taskId?: string;
    type: 'input' | 'output' | 'llm-request' | 'status';
    data: any;
    metadata?: Record<string, any>; // 例如 { type: 'file', path: '...' }
}

/**
 * 代表一个步骤或子任务的最终结果。
 */
export interface StepResult {
    runId: string;
    stepName: string; // <-- 新增: 确保步骤名称被传递
    taskId?: string; //
    status: 'completed' | 'failed';
    output?: any;
    error?: string;
}

/**
 * 代表一个LLM流式响应的数据块。
 */
export interface StreamChunk {
    runId: string;
    taskId?: string;
    content: string;
}

/**
 * 代表整个Agent运行的最终结果。
 */
export interface AgentResult {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    finalOutput?: any;
    error?: string;
    stats?: {
        duration: string;
        totalTokens: number;
        promptTokens: number;
        completionTokens: number;
    };
}