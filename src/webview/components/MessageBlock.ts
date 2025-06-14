import { ChatMessage } from "../../common/types";

export class MessageBlock {
    constructor(private readonly message: ChatMessage, private readonly messageIndex: number) {}

    public render(): HTMLElement {
        const element = document.createElement('div');
        element.className = `message-block ${this.message.role}`;
        element.dataset.index = this.messageIndex.toString();

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = this.message.content;
        
        element.appendChild(content);
        element.appendChild(this.createToolbar());

        return element;
    }

    private createToolbar(): HTMLElement {
        const toolbar = document.createElement('div');
        toolbar.className = 'message-toolbar';

        toolbar.appendChild(this.createButton('toggle-fold', 'Fold', 'codicon-chevron-up'));

        if (this.message.role === 'assistant') {
            toolbar.appendChild(this.createButton('copy-content', 'Copy', 'codicon-copy'));
            toolbar.appendChild(this.createButton('regenerate-response', 'Regenerate', 'codicon-sync'));
        } else {
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
