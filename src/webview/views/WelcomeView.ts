export class WelcomeView {
    constructor(private readonly parent: HTMLElement) {
        this.parent.innerHTML = this.render();
    }

    private render(): string {
        return `
            <div class="welcome-container">
                <h2>Welcome to CodeWiki</h2>
                <p>Your intelligent assistant for software design.</p>
                <button id="btn-new-chat">New Chat</button>
            </div>
        `;
    }
}
