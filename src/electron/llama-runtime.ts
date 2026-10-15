import { BrowserWindow, ipcMain } from 'electron';
import { validateEventFrame } from './utils.js';
import { getSelectedModelForChat } from './model-manager/model-manager.js';

const baseUrl = 'http://127.0.0.1:11434';
let activeRequest: AbortController | null = null;

function emit(data: ChatEvent) {
  for (const window of BrowserWindowWindows()) {
    if (!window.isDestroyed()) window.webContents.send('chat:event', data);
  }
}

// Kept in a small helper so the runtime does not retain a BrowserWindow reference.
function BrowserWindowWindows() {
  return BrowserWindow.getAllWindows();
}

async function chat(prompt: unknown) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('Enter a prompt first.');
  if (prompt.length > 20000) throw new Error('Prompt is too long.');
  const selected = await getSelectedModelForChat();

  activeRequest?.abort();
  activeRequest = new AbortController();
  const requestSignal = activeRequest.signal;
  emit({ type: 'start', requestId: selected.id });
  try {
    const requestBody = {
      model: selected.runtimeTag,
      messages: [{ role: 'user', content: prompt.trim() }],
      stream: true,
    };
    let response = await requestOllama(requestBody, requestSignal);
    if (!response.ok) {
      const details = await readOllamaError(response);
      if (!isGpuStartupFailure(details)) {
        throw new Error(`Ollama returned HTTP ${response.status}${details ? `: ${details}` : '.'}`);
      }
      response = await requestOllama({ ...requestBody, options: { num_gpu: 0 } }, requestSignal);
      if (!response.ok) {
        const retryDetails = await readOllamaError(response);
        throw new Error(`Ollama could not start this model with GPU or CPU fallback (HTTP ${response.status})${retryDetails ? `: ${retryDetails}` : '.'}`);
      }
    }
    if (!response.body) throw new Error('Ollama returned an empty response.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let emittedDone = false;
    let streamError = '';
    const processLine = (line: string) => {
      const value = line.trim();
      if (!value || value === '[DONE]') return;
      try {
        const parsed = JSON.parse(value) as { message?: { content?: string }; done?: boolean; error?: string };
        if (parsed.error) {
          streamError = parsed.error;
          return;
        }
        if (parsed.message?.content) emit({ type: 'delta', requestId: selected.id, content: parsed.message.content });
        if (parsed.done && !emittedDone) {
          emittedDone = true;
          emit({ type: 'done', requestId: selected.id });
        }

      } catch {
        // Ollama sends one JSON object per line; retain incomplete data below.
      }
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(processLine);
    }
    if (buffer.trim()) processLine(buffer);
    if (streamError) throw new Error(`Ollama stream error: ${streamError}`);
    if (!emittedDone) emit({ type: 'done', requestId: selected.id });
    return { success: true };
  } catch (error) {
    if (requestSignal.aborted) return { success: false, cancelled: true };
    const message = error instanceof Error ? error.message : 'Generation failed.';
    emit({ type: 'error', requestId: selected.id, error: message });
    throw new Error(message, { cause: error });
  } finally {
    activeRequest = null;
  }
}

async function requestOllama(body: object, signal: AbortSignal) {
  return fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify(body),
  });
}

async function readOllamaError(response: Response) {
  const body = await response.text();
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error ?? body.slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function isGpuStartupFailure(details: string) {
  const normalized = details.toLowerCase();
  return normalized.includes('cuda') ||
    normalized.includes('shared object initialization failed') ||
    normalized.includes('llama-server process has terminated');
}

function cancelChat() {
  activeRequest?.abort();
  return true;
}

export function registerLlamaIpc() {
  ipcMain.handle('chat:send', (event, prompt) => {
    validateEventFrame(event.senderFrame);
    return chat(prompt);
  });
  ipcMain.handle('chat:cancel', (event) => {
    validateEventFrame(event.senderFrame);
    return cancelChat();
  });
}

type ChatEvent = {
  type: 'start' | 'delta' | 'done' | 'error';
  requestId: ModelId;
  content?: string;
  error?: string;
};

type ModelId = 'gemma-e2b' | 'gemma-e4b' | 'qwen-8b';
