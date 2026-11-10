'use strict';

/**
 * The only surface the renderer has onto the system. It is deliberately a
 * list of verbs: the renderer names a game by id and the main process decides
 * what file or command that means. No path or argv ever comes from the page.
 */
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('megashelf', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  launch: (gameId, options) => ipcRenderer.invoke('game:launch', gameId, options),
  patchGame: (gameId, changes) => ipcRenderer.invoke('game:patch', gameId, changes),
  createCollection: (name) => ipcRenderer.invoke('collections:create', name),
  deleteCollection: (id) => ipcRenderer.invoke('collections:delete', id),
  toggleInCollection: (collectionId, gameId) => ipcRenderer.invoke('collections:toggle', collectionId, gameId),
  setArt: (gameId, slot, bytes) => ipcRenderer.invoke('art:set', gameId, slot, bytes),
  pickArt: (gameId, slot) => ipcRenderer.invoke('art:pick', gameId, slot),
  resetArt: (gameId, mode) => ipcRenderer.invoke('art:reset', gameId, mode),
  terminate: () => ipcRenderer.invoke('session:terminate'),
  saveAtlas: (gameId, key, version, bytes) => ipcRenderer.invoke('art:saveAtlas', gameId, key, version, bytes),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  pickEmulator: (emulatorId) => ipcRenderer.invoke('settings:pickEmulator', emulatorId),
  addRomDir: (systemId) => ipcRenderer.invoke('settings:addRomDir', systemId),
  removeRomDir: (systemId, dir) => ipcRenderer.invoke('settings:removeRomDir', systemId, dir),
  setOption: (name, value) => ipcRenderer.invoke('settings:setOption', name, value),
  quit: () => ipcRenderer.invoke('app:quit'),

  onLibraryChanged: subscribe('library:changed'),
  onStatus: subscribe('library:status'),
  onArtUpdated: subscribe('art:updated'),
  onGameUpdated: subscribe('game:updated'),
  onAppUpdate: subscribe('app:update'),
  onSessionStarted: subscribe('session:started'),
  onSessionEnded: subscribe('session:ended'),
});
