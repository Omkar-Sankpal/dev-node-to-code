const electron = require('electron');

electron.contextBridge.exposeInMainWorld('electron', {
  subscribeStatistics: (callback) =>
    ipcOn('statistics', (stats) => {
      callback(stats);
    }),
  subscribeChangeView: (callback) =>
    ipcOn('changeView', (view) => {
      callback(view);
    }),
  getStaticData: () => ipcInvoke('getStaticData'),
  sendFrameAction: (payload) => ipcSend('sendFrameAction', payload),
  getModelHardware: () => ipcInvoke('models:get-hardware'),
  getModels: () => ipcInvoke('models:list'),
  getRuntimeStatus: () => ipcInvoke('models:runtime'),
  getLlamaStatus: () => ipcInvoke('llama:status'),
  installLlama: () => ipcInvoke('llama:install'),
  downloadModel: (id) => ipcInvoke('models:download', id),
  installModel: (id) => ipcInvoke('models:install', id),
  selectModel: (id) => ipcInvoke('models:select', id),
  cancelModelDownload: (id) => ipcInvoke('models:cancel', id),
  subscribeModelProgress: (callback) => ipcOn('models:progress', callback),
  subscribeLlamaProgress: (callback) => ipcOn('llama:progress', callback),
  sendChatPrompt: (prompt) => ipcInvoke('chat:send', prompt),
  cancelChat: () => ipcInvoke('chat:cancel'),
  subscribeChat: (callback) => ipcOn('chat:event', callback),
} satisfies Window['electron']);

function ipcInvoke<Key extends keyof EventPayloadMapping>(
  key: Key,
  payload?: unknown
): Promise<EventPayloadMapping[Key]> {
  return electron.ipcRenderer.invoke(key, payload);
}

function ipcOn<Key extends keyof EventPayloadMapping>(
  key: Key,
  callback: (payload: EventPayloadMapping[Key]) => void
) {
  const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload);
  electron.ipcRenderer.on(key, cb);
  return () => electron.ipcRenderer.off(key, cb);
}

function ipcSend<Key extends keyof EventPayloadMapping>(
  key: Key,
  payload: EventPayloadMapping[Key]
) {
  electron.ipcRenderer.send(key, payload);
}