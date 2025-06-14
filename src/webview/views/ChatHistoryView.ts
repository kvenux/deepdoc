import { Conversation } from "../../common/types";
import { vscode } from "../vscode";

export class ChatHistoryView {
    private conversations: Conversation[] = [];
    private historyContainer: HTMLElement;

    constructor(
        private readonly parent: HTMLElement,
        private readonly navigate: (view: string, conversationId?: string) => void
    ) {
        this.parent.innerHTML = `<div class="history-container"><h2>Chat History</h2><ul class="history-list"></ul></div>`;
        this.historyContainer = this.parent.querySelector('.history-list') as HTMLElement;
    }

    public setConversations(conversations: Conversation[]) {
        // Sort conversations by date, newest first
        this.conversations = conversations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        this.render();
    }

    private render() {
        this.historyContainer.innerHTML = '';
        if (this.conversations.length === 0) {
            this.historyContainer.innerHTML = `<li class="history-empty">No chat history found.</li>`;
            return;
        }

        this.conversations.forEach(conv => {
            const li = document.createElement('li');
            li.className = 'history-item';
            li.dataset.id = conv.id;
            li.addEventListener('click', () => {
                this.navigate('chat', conv.id);
            });

            const content = document.createElement('div');
            content.className = 'history-item-content';

            const timestamp = document.createElement('div');
            timestamp.className = 'history-item-timestamp';
            timestamp.textContent = this.formatDate(conv.createdAt);

            const title = document.createElement('div');
            title.className = 'history-item-title';
            title.textContent = conv.title;

            content.appendChild(timestamp);
            content.appendChild(title);

            const actions = document.createElement('div');
            actions.className = 'history-item-actions';
            
            const deleteButton = document.createElement('button');
            deleteButton.className = 'icon-button';
            deleteButton.title = 'Delete';
            deleteButton.innerHTML = `<i class="codicon codicon-trash"></i>`;
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'deleteConversation', payload: { id: conv.id } });
            });

            const exportButton = document.createElement('button');
            exportButton.className = 'icon-button';
            exportButton.title = 'Export';
            exportButton.innerHTML = `<i class="codicon codicon-export"></i>`;
            exportButton.addEventListener('click', (e) => {
                e.stopPropagation();
                // Placeholder for export functionality
                vscode.postMessage({ command: 'info', payload: 'Export functionality is not yet implemented.' });
            });

            actions.appendChild(deleteButton);
            actions.appendChild(exportButton);

            li.appendChild(content);
            li.appendChild(actions);

            this.historyContainer.appendChild(li);
        });
    }

    private formatDate(dateString: string): string {
        const date = new Date(dateString);
        const options: Intl.DateTimeFormatOptions = {
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            hour12: true
        };
        return date.toLocaleString('en-US', options).replace(',', '');
    }
}
