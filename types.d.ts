type Statistics = {
  cpuUsage: number;
  ramUsage: number;
  storageUsage: number;
};

type StaticData = {
  totalStorage: number;
  cpuModel: string;
  totalMemoryGB: number;
};

type View = 'CPU' | 'RAM' | 'STORAGE';

type FrameWindowAction = 'CLOSE' | 'MAXIMIZE' | 'MINIMIZE';

type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  changeView: View;
  sendFrameAction: FrameWindowAction;
  'models:progress': ModelProgress;
  'models:get-hardware': HardwareInfo;
  'models:list': ModelInfo[];
  'models:runtime': RuntimeStatus;
  'llama:status': LlamaRuntimeStatus;
  'llama:install': LlamaRuntimeStatus;
  'llama:progress': LlamaProgress;
  'models:download': DownloadResult;
  'models:install': InstallationResult;
  'models:select': InstallationResult;
  'models:cancel': boolean;
  'chat:event': ChatEvent;
  'chat:send': ChatResult;
  'chat:cancel': boolean;
};

type ChatEvent = {
  type: 'start' | 'delta' | 'done' | 'error';
  requestId: ModelId;
  content?: string;
  error?: string;
};
type ChatResult = { success: boolean; cancelled?: boolean };

type ModelProgress = {
  id: ModelId;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  complete?: boolean;
  cancelled?: boolean;
  error?: string;
  installing?: boolean;
  installed?: boolean;
};

type ModelId = 'gemma-e2b' | 'gemma-e4b' | 'qwen-8b';
type HardwareInfo = {
  totalRamGB: number; freeRamGB: number; diskFreeGB: number; cpuCores: number;
  cpuModel: string; platform: string; architecture: string;
  gpu: { name: string | null; vramGB: number | null; available: boolean };
};
type ModelInfo = {
  id: ModelId; name: string; repository: string; quantization: string; downloadGB: number;
  requirements: { minRamGB: number; recommendedRamGB: number; minCores: number; minDiskFreeGB: number; supportedArchitectures: string[] };
  compatible: boolean; compatibilityReasons: string[]; recommended: boolean; warning?: string;
  installed: boolean; downloading: boolean; selected: boolean; runtimeUsable: boolean;
};
type RuntimeStatus = { available: boolean; reason?: string; models?: string[] };
type LlamaRuntimeStatus = { available: boolean; executablePath?: string; reason?: string; installable: boolean; installing?: boolean; percent?: number };
type LlamaProgress = { percent: number; installing: boolean };
type DownloadResult = { success: boolean; id?: ModelId; cancelled?: boolean };
type InstallationResult = { success: boolean; id: ModelId };

type UnsubscribeFunction = () => void;

interface Window {
  electron: {
    subscribeStatistics: (
      callback: (statistics: Statistics) => void
    ) => UnsubscribeFunction;
    getStaticData: () => Promise<StaticData>;
    subscribeChangeView: (
      callback: (view: View) => void
    ) => UnsubscribeFunction;
    sendFrameAction: (payload: FrameWindowAction) => void;
    getModelHardware: () => Promise<HardwareInfo>;
    getModels: () => Promise<ModelInfo[]>;
    getRuntimeStatus: () => Promise<{ available: boolean; reason?: string; models?: string[] }>;
    getLlamaStatus: () => Promise<LlamaRuntimeStatus>;
    installLlama: () => Promise<LlamaRuntimeStatus>;
    downloadModel: (id: ModelId) => Promise<{ success: boolean; id?: ModelId; cancelled?: boolean }>;
    installModel: (id: ModelId) => Promise<{ success: boolean; id: ModelId }>;
    selectModel: (id: ModelId) => Promise<{ success: boolean; id: ModelId }>;
    cancelModelDownload: (id: ModelId) => Promise<boolean>;
    subscribeModelProgress: (callback: (progress: ModelProgress) => void) => UnsubscribeFunction;
    subscribeLlamaProgress: (callback: (progress: LlamaProgress) => void) => UnsubscribeFunction;
    sendChatPrompt: (prompt: string) => Promise<ChatResult>;
    cancelChat: () => Promise<boolean>;
    subscribeChat: (callback: (event: ChatEvent) => void) => UnsubscribeFunction;
  };
}