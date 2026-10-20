'use strict';

/**
 * The only bridge between the window and the shell.
 *
 * The app runs with `contextIsolation: true` and `sandbox: true`: the renderer
 * has no Node, no `require`, and no filesystem. It needs exactly one capability
 * — the window controls — because the window is frameless and the title bar is
 * the application's own top bar. Those three verbs are the whole surface; there
 * is deliberately no generic `ipcRenderer.send(channel, …)` here, so a mistake in
 * the renderer cannot reach anything else the shell can do.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appWindow', {
  platform: process.platform,

  /** Title-bar buttons, in the order the shell implements them. */
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),

  /** Current maximised state, so the button can render Restore rather than Maximise. */
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  /**
   * Subscribe to maximise/restore. Returns the unsubscribe function, so a React
   * effect can clean up rather than accumulate listeners across remounts.
   */
  onMaximizedChange: (listener) => {
    const handler = (_event, maximized) => listener(Boolean(maximized));
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
});
