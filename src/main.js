import { createApp } from './app.js';
createApp(document, window, () => import('./sdk.js'));
