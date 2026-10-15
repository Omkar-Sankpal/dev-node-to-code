import { app, BrowserWindow, ipcMain } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, createWriteStream, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateEventFrame } from '../utils.js';

type ModelId = 'gemma-e2b' | 'gemma-e4b' | 'qwen-8b';
type ModelDefinition = {
  id: ModelId;
  name: string;
  repository: string;
  quantization: string;
  url: string;
  fileName: string;
  sizeBytes: number;
  minRamGB: number;
  recommendedRamGB: number;
  minCores: number;
  minDiskFreeGB: number;
  supportedArchitectures: string[];
  sha256?: string;
};

const MODELS: ModelDefinition[] = [
  {
    id: 'gemma-e2b', name: 'Gemma 4 E2B', repository: 'ggml-org/gemma-4-E2B-GGUF',
    quantization: 'Q8_0', url: 'https://huggingface.co/ggml-org/gemma-4-E2B-GGUF/resolve/main/gemma-4-E2B-Q8_0.gguf',
    fileName: 'gemma-4-E2B-Q8_0.gguf', sizeBytes: 4.97e9, minRamGB: 8, recommendedRamGB: 12,
    minCores: 4, minDiskFreeGB: 6, supportedArchitectures: ['x64', 'arm64'],
  },
  {
    id: 'gemma-e4b', name: 'Gemma 4 E4B', repository: 'ggml-org/gemma-4-E4B-GGUF',
    quantization: 'Q8_0', url: 'https://huggingface.co/ggml-org/gemma-4-E4B-GGUF/resolve/main/gemma-4-E4B-Q8_0.gguf',
    fileName: 'gemma-4-E4B-Q8_0.gguf', sizeBytes: 8.03e9, minRamGB: 16, recommendedRamGB: 24,
    minCores: 6, minDiskFreeGB: 10, supportedArchitectures: ['x64', 'arm64'],
  },
  {
    id: 'qwen-8b', name: 'Qwen 8B', repository: 'Qwen/Qwen3-8B-GGUF',
    quantization: 'Q4_K_M',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/6a569868d07d3bd59e8b97fb001bf8c0b254bb20/Qwen3-8B-Q4_K_M.gguf',
    fileName: 'Qwen3-8B-Q4_K_M.gguf', sizeBytes: 5.03e9, minRamGB: 12, recommendedRamGB: 16,
    minCores: 6, minDiskFreeGB: 7, supportedArchitectures: ['x64', 'arm64'],
  },
];

const execFileAsync = promisify(execFile);
let mainWindow: BrowserWindow | null = null;
const downloads = new Map<ModelId, AbortController>();
let llamaInstallPromise: Promise<LlamaRuntimeStatus> | null = null;

const modelDirectory = () => path.join(app.getPath('userData'), 'models');
const statePath = () => path.join(modelDirectory(), 'state.json');
const modelPath = (model: ModelDefinition) => path.join(modelDirectory(), model.fileName);
const runtimeTag = (model: ModelDefinition) => `node-to-code-${model.id}`;
const preferredRuntimeTags = (model: ModelDefinition) => {
  if (model.id === 'gemma-e2b') return ['gemma4:e2b'];
  if (model.id === 'gemma-e4b') return ['gemma4:e4b'];
  return ['qwen3:8b'];
};
const findRuntimeTag = (models: string[], model: ModelDefinition) => preferredRuntimeTags(model)
  .find((tag) => models.some((name) => name === tag || name === `${tag}:latest`));
const llamaExecutableName = () => process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const llamaDirectory = () => path.join(app.getPath('userData'), 'llama');
const llamaExecutablePath = () => path.join(llamaDirectory(), llamaExecutableName());

function getModel(id: unknown): ModelDefinition {
  const model = MODELS.find((item) => item.id === id);
  if (!model) throw new Error('Unknown model ID');
  return model;
}

function emitProgress(data: ModelProgress) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('models:progress', data);
}

async function readState(): Promise<{ selectedModelId?: ModelId; installationPaths: Partial<Record<ModelId, string>> }> {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf8')) as { selectedModelId?: ModelId; installationPaths: Partial<Record<ModelId, string>> };
  } catch {
    return { installationPaths: {} };
  }
}

async function writeState(state: { selectedModelId?: ModelId; installationPaths: Partial<Record<ModelId, string>> }) {
  await fs.mkdir(modelDirectory(), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

async function getDiskFreeBytes() {
  const stats = await fs.statfs(modelDirectory());
  return Number(stats.bavail) * Number(stats.bsize);
}

async function getGpuInfo() {
  try {
    const info = await app.getGPUInfo('basic') as { gpuDevice?: Array<{ memory?: number; deviceString?: string }> };
    const devices = info.gpuDevice ?? [];
    const vramBytes = devices.reduce((max, device) => Math.max(max, Number(device.memory ?? 0)), 0);
    return { name: devices[0]?.deviceString ?? null, vramGB: vramBytes ? Number((vramBytes / 2 ** 30).toFixed(1)) : null, available: devices.length > 0 };
  } catch {
    return { name: null, vramGB: null, available: false };
  }
}

export async function getHardwareInfo() {
  await fs.mkdir(modelDirectory(), { recursive: true });
  const gpu = await getGpuInfo();
  const diskFreeGB = Number((await getDiskFreeBytes() / 1e9).toFixed(1));
  const totalRamGB = os.totalmem() / 2 ** 30;
  const freeRamGB = os.freemem() / 2 ** 30;
  const cpuCores = os.availableParallelism?.() ?? os.cpus().length;
  return {
    totalRamGB: Number(totalRamGB.toFixed(1)), freeRamGB: Number(freeRamGB.toFixed(1)),
    diskFreeGB, cpuCores, cpuModel: os.cpus()[0]?.model ?? 'Unknown CPU',
    platform: process.platform, architecture: process.arch, gpu,
  };
}

async function runtimeStatus() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags');
    if (!response.ok) return { available: false, reason: `Ollama returned HTTP ${response.status}` };
    const body = await response.json() as { models?: Array<{ name?: string }> };
    return { available: true, models: (body.models ?? []).map((model) => model.name ?? '') };
  } catch {
    return { available: false, reason: 'Ollama is not running. Install or start Ollama to use downloaded models.' };
  }
}

  type LlamaRuntimeStatus = {
    available: boolean;
    executablePath?: string;
    reason?: string;
    installable: boolean;
    installing?: boolean;
    percent?: number;
  };

  async function findLlamaExecutable() {
    const configured = process.env.LLAMA_SERVER_PATH;
    const candidates = [
      configured ? path.resolve(configured) : null,
      llamaExecutablePath(),
      path.join(process.resourcesPath, 'llama', llamaExecutableName()),
      path.join(app.getAppPath(), 'llama', llamaExecutableName()),
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch {
        // Try the next supported location.
      }
    }
    try {
      const command = process.platform === 'win32' ? 'where.exe' : 'which';
      const result = await execFileAsync(command, [llamaExecutableName()], { windowsHide: true });
      const pathFromEnvironment = result.stdout.trim().split(/\r?\n/)[0];
      if (pathFromEnvironment && (await fs.stat(pathFromEnvironment)).isFile()) return pathFromEnvironment;
    } catch {
      // PATH does not contain llama-server.
    }
    return null;
  }

  export async function getLlamaRuntimeStatus(): Promise<LlamaRuntimeStatus> {
    const executablePath = await findLlamaExecutable();
    return {
      available: Boolean(executablePath),
      executablePath: executablePath ?? undefined,
      reason: executablePath ? undefined : 'llama.cpp is not installed yet.',
      installable: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux',
      installing: Boolean(llamaInstallPromise),
    };
  }

  async function downloadArchive(url: string, destination: string, onProgress: (percent: number) => void) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`llama.cpp download failed (HTTP ${response.status}).`);
    const total = Number(response.headers.get('content-length') ?? 0);
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (total) onProgress(Math.min(99, Math.floor(received / total * 100)));
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(destination));
  }

  async function installLlamaRuntime(): Promise<LlamaRuntimeStatus> {
    if (llamaInstallPromise) return llamaInstallPromise;
    llamaInstallPromise = (async () => {
      if (process.platform === 'aix' || process.platform === 'freebsd' || process.platform === 'openbsd' || process.platform === 'sunos') {
        throw new Error(`Automatic llama.cpp setup is not supported on ${process.platform}.`);
      }
      const releaseResponse = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20', {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'node-to-code' },
      });
      if (!releaseResponse.ok) throw new Error(`Could not find a llama.cpp release (HTTP ${releaseResponse.status}).`);
      const releases = await releaseResponse.json() as Array<{ assets?: Array<{ name: string; browser_download_url: string }> }>;
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
      const asset = releases
        .flatMap((release) => release.assets ?? [])
        .find((item) => {
          const name = item.name.toLowerCase();
          if (process.platform === 'win32') return name.includes(`-bin-win-cpu-${architecture}.zip`);
          if (process.platform === 'darwin') return name.includes(`-bin-macos-${architecture}.tar.gz`);
          return name.includes(`-bin-ubuntu-${architecture}.tar.gz`);
        });
      if (!asset) throw new Error(`No compatible llama.cpp release was found for ${process.platform} ${process.arch}.`);

      const temporaryDirectory = path.join(app.getPath('temp'), `node-to-code-llama-${Date.now()}`);
      const archivePath = path.join(temporaryDirectory, asset.name);
      const extractionDirectory = path.join(temporaryDirectory, 'extracted');
      await fs.mkdir(extractionDirectory, { recursive: true });
      try {
        await downloadArchive(asset.browser_download_url, archivePath, (percent) => emitLlamaProgress(percent));
        if (asset.name.endsWith('.zip')) {
          await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive', '-LiteralPath', archivePath, '-DestinationPath', extractionDirectory, '-Force'], { windowsHide: true });
        } else {
          await execFileAsync('tar', ['-xzf', archivePath, '-C', extractionDirectory]);
        }
        const executable = await findFile(extractionDirectory, llamaExecutableName());
        if (!executable) throw new Error('The llama.cpp archive did not contain llama-server.');
        await fs.rm(llamaDirectory(), { recursive: true, force: true });
        await fs.mkdir(llamaDirectory(), { recursive: true });
        await fs.cp(path.dirname(executable), llamaDirectory(), { recursive: true });
        emitLlamaProgress(100);
        return await getLlamaRuntimeStatus();
      } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    })().finally(() => { llamaInstallPromise = null; });
    return llamaInstallPromise;
  }

  async function findFile(directory: string, fileName: string): Promise<string | null> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return entryPath;
      if (entry.isDirectory()) {
        const found = await findFile(entryPath, fileName);
        if (found) return found;
      }
    }
    return null;
  }

  function emitLlamaProgress(percent: number) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('llama:progress', { percent, installing: percent < 100 });
  }

async function isInstalled(model: ModelDefinition) {
  try {
    const stat = await fs.stat(modelPath(model));
    return stat.isFile() && stat.size > model.sizeBytes * 0.95;
  } catch {
    return false;
  }
}

export async function getSelectedModelForChat() {
  const state = await readState();
  if (!state.selectedModelId) throw new Error('Select and install a model before opening chat.');
  const model = getModel(state.selectedModelId);
  const runtime = await runtimeStatus();
  if (!runtime.available) throw new Error('Ollama is not running. Start Ollama and retry.');
  const selectedRuntimeTag = findRuntimeTag(runtime.models ?? [], model);
  if (!selectedRuntimeTag) {
    throw new Error(`${model.name} is not installed in Ollama. Install the native Ollama model and retry.`);
  }
  return { id: model.id, path: modelPath(model), name: model.name, runtimeTag: selectedRuntimeTag };
}

async function getModelList() {
  const hardware = await getHardwareInfo();
  const state = await readState();
  const runtime = await runtimeStatus();
  return Promise.all(MODELS.map(async (model) => {
    const reasons: string[] = [];
    if (hardware.totalRamGB < model.minRamGB) reasons.push(`Requires at least ${model.minRamGB} GB RAM; this computer has ${hardware.totalRamGB} GB.`);
    if (hardware.cpuCores < model.minCores) reasons.push(`Requires ${model.minCores} CPU cores; this computer has ${hardware.cpuCores}.`);
    if (!model.supportedArchitectures.includes(hardware.architecture)) reasons.push(`CPU architecture ${hardware.architecture} is not supported.`);
    if (hardware.diskFreeGB < model.minDiskFreeGB) reasons.push(`Requires ${model.minDiskFreeGB} GB free disk space; only ${hardware.diskFreeGB} GB is available.`);
    return {
      id: model.id, name: model.name, repository: model.repository, quantization: model.quantization,
      downloadGB: Number((model.sizeBytes / 1e9).toFixed(2)), requirements: {
        minRamGB: model.minRamGB, recommendedRamGB: model.recommendedRamGB, minCores: model.minCores,
        minDiskFreeGB: model.minDiskFreeGB, supportedArchitectures: model.supportedArchitectures,
      },
      compatible: reasons.length === 0, compatibilityReasons: reasons,
      recommended: reasons.length === 0 && hardware.totalRamGB >= model.recommendedRamGB,
      warning: hardware.totalRamGB < model.recommendedRamGB ? 'May compete with your IDE and build processes for memory.' : undefined,
      installed: (await isInstalled(model)) || Boolean(findRuntimeTag(runtime.models ?? [], model)), downloading: downloads.has(model.id),
      selected: state.selectedModelId === model.id,
      runtimeUsable: runtime.available && Boolean(findRuntimeTag(runtime.models ?? [], model)),
    };
  }));
}

async function verifyHash(filePath: string, expected?: string) {
  if (!expected) return;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (hash.digest('hex').toLowerCase() !== expected.toLowerCase()) throw new Error('SHA-256 verification failed.');
}

export async function downloadModel(id: unknown) {
  const model = getModel(id);
  const list = await getModelList();
  const entry = list.find((item) => item.id === model.id);
  if (!entry?.compatible) throw new Error(entry?.compatibilityReasons.join(' ') ?? 'Model is not compatible.');
  if (downloads.has(model.id)) throw new Error('This model is already downloading.');
  if (await isInstalled(model)) return { success: true, id: model.id, alreadyExists: true };

  const freeBytes = await getDiskFreeBytes();
  if (freeBytes < model.minDiskFreeGB * 1e9) throw new Error(`Not enough disk space. At least ${model.minDiskFreeGB} GB is required.`);
  const controller = new AbortController();
  downloads.set(model.id, controller);
  const destination = modelPath(model);
  const partialPath = `${destination}.part`;
  try {
    const response = await fetch(model.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}).`);
    const totalBytes = Number(response.headers.get('content-length') ?? model.sizeBytes);
    let downloadedBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        emitProgress({ id: model.id, downloadedBytes, totalBytes, percent: Math.min(100, Math.floor(downloadedBytes / totalBytes * 100)) });
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partialPath), { signal: controller.signal });
    if (downloadedBytes < model.sizeBytes * 0.95) throw new Error('The downloaded model is incomplete.');
    await verifyHash(partialPath, model.sha256);
    await fs.rename(partialPath, destination);
    emitProgress({ id: model.id, percent: 100, complete: true });
    return { success: true, id: model.id };
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    if (controller.signal.aborted) {
      emitProgress({ id: model.id, cancelled: true });
      return { success: false, cancelled: true };
    }
    const message = error instanceof Error ? error.message : 'Download failed.';
    emitProgress({ id: model.id, error: message });
    throw new Error(message, { cause: error });
  } finally {
    downloads.delete(model.id);
  }
}

async function installModel(id: unknown) {
  const model = getModel(id);
  if (!(await isInstalled(model))) throw new Error('Download the model before installing it.');
  const runtime = await runtimeStatus();
  if (!runtime.available) throw new Error(runtime.reason);
  const modelfile = path.join(modelDirectory(), `${model.id}.Modelfile`);
  await fs.writeFile(modelfile, `FROM ${modelPath(model)}\nPARAMETER temperature 0.2\n`, 'utf8');
  emitProgress({ id: model.id, installing: true });
  try {
    await execFileAsync('ollama', ['create', runtimeTag(model), '-f', modelfile], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const state = await readState();
    state.installationPaths[model.id] = modelPath(model);
    await writeState(state);
    emitProgress({ id: model.id, installed: true });
    return { success: true, id: model.id };
  } catch (error) {
    throw new Error('Ollama could not install this model. Check that Ollama is running and retry.', { cause: error });
  } finally {
    await fs.rm(modelfile, { force: true });
  }
}

async function selectModel(id: unknown) {
  const model = getModel(id);
  const entry = (await getModelList()).find((item) => item.id === model.id);
  if (!entry?.compatible) throw new Error(entry?.compatibilityReasons.join(' ') ?? 'Model is not compatible.');
  if (!entry.installed) throw new Error('Download the model before selecting it.');
  const state = await readState();
  state.selectedModelId = model.id;
  await writeState(state);
  return { success: true, id: model.id };
}

export function cancelModelDownload(id: unknown) {
  const model = getModel(id);
  const controller = downloads.get(model.id);
  if (!controller) return false;
  controller.abort();
  return true;
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent) {
  validateEventFrame(event.senderFrame);
}

export function setModelManagerWindow(window: BrowserWindow) { mainWindow = window; }

export function registerModelIpc() {
  ipcMain.handle('models:get-hardware', (event) => { assertTrustedSender(event); return getHardwareInfo(); });
  ipcMain.handle('models:list', (event) => { assertTrustedSender(event); return getModelList(); });
  ipcMain.handle('models:runtime', (event) => { assertTrustedSender(event); return runtimeStatus(); });
  ipcMain.handle('llama:status', (event) => { assertTrustedSender(event); return getLlamaRuntimeStatus(); });
  ipcMain.handle('llama:install', (event) => { assertTrustedSender(event); return installLlamaRuntime(); });
  ipcMain.handle('models:download', (event, id) => { assertTrustedSender(event); return downloadModel(id); });
  ipcMain.handle('models:install', (event, id) => { assertTrustedSender(event); return installModel(id); });
  ipcMain.handle('models:select', (event, id) => { assertTrustedSender(event); return selectModel(id); });
  ipcMain.handle('models:cancel', (event, id) => { assertTrustedSender(event); return cancelModelDownload(id); });
}

type ModelProgress = {
  id: ModelId; downloadedBytes?: number; totalBytes?: number; percent?: number;
  complete?: boolean; cancelled?: boolean; error?: string; installing?: boolean; installed?: boolean;
};
