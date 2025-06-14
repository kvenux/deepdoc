import { App } from './views/App';

// Wait for the DOM to be fully loaded before initializing the app
window.addEventListener('load', () => {
    const app = new App(document.body);
    app.initialize();
});
