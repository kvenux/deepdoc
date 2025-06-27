// src/webview/components/MessageBlock.ts
import { ChatMessage } from "../../common/types";

export class MessageBlock {
    constructor(private readonly message: ChatMessage, private readonly messageIndex: number) { }

    public render(): HTMLElement {
        const element = document.createElement('div');
        element.className = `message-block ${this.message.role}`;
        element.dataset.index = this.messageIndex.toString();

        const content = document.createElement('div');
        content.className = 'message-content';

        // FIX: 使用类型守卫来设置内容
        if (this.message.type === 'text') {
            content.textContent = this.message.content;
        } else { // this.message.type === 'agent_run'
            // 为 AgentRun 消息提供一个摘要或占位符
            content.innerHTML = `<strong>Agent Run: ${this.message.run.plan.agentName}</strong><br>Status: ${this.message.run.result.status}`;
            // 这里可以将来扩展为更复杂的渲染组件
        }

        element.appendChild(content);
        element.appendChild(this.createToolbar());

        return element;
    }

    private createToolbar(): HTMLElement {
        const toolbar = document.createElement('div');
        toolbar.className = 'message-toolbar';

        toolbar.appendChild(this.createButton('toggle-fold', 'Fold', 'codicon-chevron-up'));

        // Agent 运行消息也视为 assistant 角色
        if (this.message.role === 'assistant') {
            toolbar.appendChild(this.createButton('copy-content', 'Copy', 'codicon-copy'));
            // 仅为文本消息提供“重新生成”
            if (this.message.type === 'text') {
                toolbar.appendChild(this.createButton('regenerate-response', 'Regenerate', 'codicon-sync'));
            }
        } else { // user 角色
            toolbar.appendChild(this.createButton('copy-content', 'Copy', 'codicon-copy'));
            toolbar.appendChild(this.createButton('edit-message', 'Edit', 'codicon-pencil'));
        }

        return toolbar;
    }

    private createButton(action: string, title: string, icon: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = `icon-button`;
        button.title = title;
        button.dataset.action = action;
        button.innerHTML = `<i class="codicon ${icon}"></i>`;
        return button;
    }
}
