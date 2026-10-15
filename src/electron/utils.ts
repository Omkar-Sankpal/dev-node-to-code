
import { ipcMain, WebContents, WebFrameMain } from 'electron';
import { getUIPath } from './pathResolver.js';
import { pathToFileURL } from 'url';

export function isDev(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function ipcMainHandle<Key extends keyof EventPayloadMapping>(
  key: Key,
  handler: () => EventPayloadMapping[Key]
) {
  ipcMain.handle(key, (event) => {
    validateEventFrame(event.senderFrame);
    return handler();
  });
}

export function ipcMainOn<Key extends keyof EventPayloadMapping>(
  key: Key,
  handler: (payload: EventPayloadMapping[Key]) => void
) {
  ipcMain.on(key, (event, payload) => {
    validateEventFrame(event.senderFrame);
    handler(payload);
  });
}

export function ipcWebContentsSend<Key extends keyof EventPayloadMapping>(
  key: Key,
  webContents: WebContents,
  payload: EventPayloadMapping[Key]
) {
  webContents.send(key, payload);
}

export function validateEventFrame(frame: WebFrameMain | null): void {
  // Reject requests if the sender frame no longer exists.
  if (!frame) {
    throw new Error('Malicious event: sender frame is null');
  }

  const frameUrl = new URL(frame.url);

  // Allow requests from the local development UI.
  if (
    isDev() &&
    frameUrl.protocol === 'http:' &&
    frameUrl.hostname === 'localhost' &&
    frameUrl.port === '5123'
  ) {
    return;
  }

  // Allow requests from the packaged application UI.
  const expectedUrl = pathToFileURL(getUIPath()).toString();

  if (frame.url !== expectedUrl) {
    throw new Error('Malicious event');
  }
}
