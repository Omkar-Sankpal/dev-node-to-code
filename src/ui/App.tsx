import { useEffect, useMemo, useState } from 'react';
import './App.css';
import { useStatistics } from './useStatistics';
import { Chart } from './Chart'

function App() {
  const staticData = useStaticData();
  const statistics = useStatistics(10);
  const [activeView, setActiveView] = useState<View>('CPU');
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [runtime, setRuntime] = useState<{ available: boolean; reason?: string }>({ available: false });
  const [progress, setProgress] = useState<Record<ModelId, ModelProgress>>({} as Record<ModelId, ModelProgress>);
  const [errors, setErrors] = useState<Record<ModelId, string>>({} as Record<ModelId, string>);
  const [chatOpen, setChatOpen] = useState(false);
  const cpuUsages = useMemo(
    () => statistics.map((stat) => stat.cpuUsage),
    [statistics]
  );
  const ramUsages = useMemo(
    () => statistics.map((stat) => stat.ramUsage),
    [statistics]
  );
  const storageUsages = useMemo(
    () => statistics.map((stat) => stat.storageUsage),
    [statistics]
  );
  const activeUsages = useMemo(() => {
    switch (activeView) {
      case 'CPU':
        return cpuUsages;
      case 'RAM':
        return ramUsages;
      case 'STORAGE':
        return storageUsages;
    }

  }, [activeView, cpuUsages, ramUsages, storageUsages]);

  useEffect(() => {
    return window.electron.subscribeChangeView((view) => setActiveView(view));
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const [detectedHardware, availableModels, runtimeStatus] = await Promise.all([
        window.electron.getModelHardware(),
        window.electron.getModels(),
        window.electron.getRuntimeStatus(),
      ]);
      if (!disposed) {
        setHardware(detectedHardware);
        setModels(availableModels);
        setRuntime(runtimeStatus);
      }
    };

    void refresh().catch((error: unknown) => {
      if (!disposed) setErrors((current) => ({ ...current, 'gemma-e2b': error instanceof Error ? error.message : 'Unable to load model information.' }));
    });
    const unsubscribe = window.electron.subscribeModelProgress((event) => {
      setProgress((current) => ({ ...current, [event.id]: event }));
      if (event.error) setErrors((current) => ({ ...current, [event.id]: event.error! }));
      if (event.complete || event.installed) void refresh();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const selectedModel = models.find((model) => model.selected);
  const recommendedModel = models.find((model) => model.recommended && model.compatible)
    ?? models.find((model) => model.compatible);
  const chatReady = Boolean(runtime.available && selectedModel?.runtimeUsable);

  const runModelAction = async (id: ModelId, action: 'download' | 'install' | 'select') => {
    setErrors((current) => ({ ...current, [id]: '' }));
    try {
      if (action === 'download') await window.electron.downloadModel(id);
      if (action === 'install') await window.electron.installModel(id);
      if (action === 'select') await window.electron.selectModel(id);
      setModels(await window.electron.getModels());
    } catch (error) {
      setErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : 'Model operation failed.' }));
    }
  };

  return (
    <div className="App">
      <Header />
      <button className={`chatTab ${chatOpen ? 'active' : ''}`} disabled={!chatReady} onClick={() => setChatOpen((open) => !open)}>
        <span className="chatTabIcon">✦</span>
        <span>Local Chat</span>
      </button>
      {chatOpen && chatReady && <ChatSidebar onClose={() => setChatOpen(false)} />}
      <div className="main dashboard">
        <section className="hardwarePanel">
          <h1>NodeToCode models</h1>
          <p className="muted">Choose a local model that fits this computer.</p>
          {hardware && <div className="hardwareGrid">
            <span><strong>{hardware.totalRamGB} GB</strong><small>RAM</small></span>
            <span><strong>{hardware.diskFreeGB} GB</strong><small>Free disk</small></span>
            <span><strong>{hardware.cpuCores}</strong><small>CPU threads</small></span>
            <span><strong>{hardware.gpu.vramGB ? `${hardware.gpu.vramGB} GB` : 'CPU'}</strong><small>{hardware.gpu.name ?? 'No GPU detected'}</small></span>
          </div>}
          {!runtime.available && <div className="notice warning">{runtime.reason ?? 'Local runtime unavailable.'}</div>}
        </section>
        {(!runtime.available || !selectedModel?.runtimeUsable) && <OnboardingPanel
          runtime={runtime}
          model={recommendedModel}
          modelProgress={recommendedModel ? progress[recommendedModel.id] : undefined}
          modelError={recommendedModel ? errors[recommendedModel.id] : undefined}
          onModelAction={recommendedModel ? (action) => void runModelAction(recommendedModel.id, action) : undefined}
        />}
        <section className="modelsPanel">
          <h2>Available models</h2>
          <div className="modelList">
            {models.map((model) => {
              const event = progress[model.id];
              const error = errors[model.id];
              return <article className={`modelCard ${!model.compatible ? 'incompatible' : ''}`} key={model.id}>
                <div className="modelHeading">
                  <div><h3>{model.name}</h3><span className="tag">{model.quantization}</span></div>
                  {model.selected && <span className="selected">Selected</span>}
                </div>
                <p className="muted">{model.downloadGB} GB download · {model.repository}</p>
                <p>Needs {model.requirements.minRamGB} GB RAM, {model.requirements.minCores}+ CPU threads, and {model.requirements.minDiskFreeGB} GB free disk.</p>
                {model.compatibilityReasons.length > 0 && <ul className="requirements">{model.compatibilityReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                {model.warning && model.compatible && <p className="muted">{model.warning}</p>}
                {event?.percent !== undefined && !event.complete && <div className="progress"><div style={{ width: `${event.percent}%` }} /><span>{event.installing ? 'Installing…' : `${event.percent}% downloaded`}</span></div>}
                {error && <div className="notice error">{error} <button onClick={() => void runModelAction(model.id, model.installed ? 'install' : 'download')}>Retry</button></div>}
                <div className="modelActions">
                  {!model.installed && <button className="primary" disabled={!model.compatible || model.downloading} onClick={() => void runModelAction(model.id, 'download')}>{model.downloading ? 'Downloading…' : 'Download'}</button>}
                  {model.installed && !model.selected && <button className="primary" disabled={!model.compatible} onClick={() => void runModelAction(model.id, 'select')}>Use with Ollama</button>}
                  {model.installed && !model.runtimeUsable && runtime.available && <button className="secondary" onClick={() => void runModelAction(model.id, 'install')}>Install in Ollama</button>}
                  {model.selected && <span className="ready">Ready for code generation</span>}
                </div>
              </article>;
            })}
          </div>
        </section>
        <section className="statsPanel">
          <h2>System activity</h2>
          <div className="main">
        <div>
          <SelectOption
            onClick={() => setActiveView('CPU')}
            title="CPU"
            view="CPU"
            subTitle={staticData?.cpuModel ?? ''}
            data={cpuUsages}
          />
          <SelectOption
            onClick={() => setActiveView('RAM')}
            title="RAM"
            view="RAM"
            subTitle={(staticData?.totalMemoryGB.toString() ?? '') + ' GB'}
            data={ramUsages}
          />
          <SelectOption
            onClick={() => setActiveView('STORAGE')}
            title="STORAGE"
            view="STORAGE"
            subTitle={(staticData?.totalStorage.toString() ?? '') + ' GB'}
            data={storageUsages}
          />
        </div>
        <div className="mainGrid">
          <Chart
            selectedView={activeView}
            data={activeUsages}
            maxDataPoints={10}
          />
        </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function OnboardingPanel(props: {
  runtime: { available: boolean; reason?: string };
  model?: ModelInfo;
  modelProgress?: ModelProgress;
  modelError?: string;
  onModelAction?: (action: 'download' | 'select' | 'install') => void;
}) {
  const runtimeReady = props.runtime.available;
  const modelReady = Boolean(props.model?.selected && props.model.runtimeUsable);
  return <section className="onboardingPanel">
    <div className="onboardingHeading">
      <div><span className="eyebrow">FIRST-TIME SETUP</span><h2>Get Ollama ready for local chat</h2><p className="muted">Chat uses Ollama on this computer. Start Ollama, then download and install a compatible model.</p></div>
      <span className="onboardingStep">{runtimeReady && modelReady ? 'Ready' : '2 steps'}</span>
    </div>
    <div className="setupSteps">
      <div className={`setupStep ${runtimeReady ? 'complete' : 'current'}`}>
        <span className="stepNumber">{runtimeReady ? '✓' : '1'}</span>
        <div><strong>Start Ollama</strong><p>{runtimeReady ? 'Ollama is running.' : props.runtime.reason ?? 'Start the Ollama application, then refresh this window.'}</p></div>
      </div>
      <div className={`setupStep ${modelReady ? 'complete' : runtimeReady ? 'current' : ''}`}>
        <span className="stepNumber">{modelReady ? '✓' : '2'}</span>
        <div><strong>Install a model in Ollama</strong><p>{props.model ? `${props.model.name} is recommended for this computer (${props.model.downloadGB} GB).` : 'Choose a compatible model below.'}</p>
          {runtimeReady && props.model && !props.model.installed && <button className="primary" disabled={props.model.downloading} onClick={() => props.onModelAction?.('download')}>{props.model.downloading ? 'Downloading…' : `Download ${props.model.name}`}</button>}
          {runtimeReady && props.model?.installed && !props.model.runtimeUsable && <button className="primary" onClick={() => props.onModelAction?.('install')}>Install in Ollama</button>}
          {runtimeReady && props.model?.runtimeUsable && !props.model.selected && <button className="primary" onClick={() => props.onModelAction?.('select')}>Use this model</button>}
          {props.modelProgress?.percent !== undefined && !props.modelProgress.complete && <div className="progress"><div style={{ width: `${props.modelProgress.percent}%` }} /><span>{props.modelProgress.percent}% downloaded</span></div>}
          {props.modelError && <div className="notice error">{props.modelError}</div>}
        </div>
      </div>
    </div>
  </section>;
}

function ChatSidebar(props: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => window.electron.subscribeChat((event) => {
    if (event.type === 'start') {
      setAnswer('');
      setError('');
      setBusy(true);
    } else if (event.type === 'delta') {
      setAnswer((current) => current + (event.content ?? ''));
    } else if (event.type === 'done' || event.type === 'error') {
      setBusy(false);
      if (event.error) setError(event.error);
    }
  }), []);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setError('');
    setAnswer('');
    setBusy(true);
    try {
      await window.electron.sendChatPrompt(prompt);
    } catch (requestError) {
      setBusy(false);
      setError(requestError instanceof Error ? requestError.message : 'Unable to generate a response.');
    }
  };

  return <aside className="chatSidebar">
    <div className="chatHeader">
      <div><strong>Local Chat</strong><small>Ollama · selected model</small></div>
      <button className="chatClose" onClick={props.onClose} aria-label="Close chat">×</button>
    </div>
    <div className="chatMessages">
      {!answer && !busy && <div className="chatEmpty"><span>✦</span><strong>Ask your local model</strong><p>Generate code, explain a file, or brainstorm without leaving the app.</p></div>}
      {answer && <div className="chatResponse">{answer}</div>}
      {busy && !answer && <div className="chatTyping"><i /><i /><i /> Thinking…</div>}
      {error && <div className="chatError">{error}</div>}
    </div>
    <div className="chatComposer">
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
      }} placeholder="Ask anything about your code…" rows={3} disabled={busy} />
      <div className="chatComposerFooter">
        <span>Enter to send · Shift+Enter for new line</span>
        {busy
          ? <button onClick={() => { void window.electron.cancelChat(); setBusy(false); }}>Stop</button>
          : <button className="sendButton" onClick={() => void submit()} disabled={!prompt.trim()}>↑</button>}
      </div>
    </div>
  </aside>;
}

function SelectOption(props: {
  title: string;
  view: View;
  subTitle: string;
  data: number[];
  onClick: () => void;
}) {
  return (
    <button className="selectOption" onClick={props.onClick}>
      <div className="selectOptionTitle">
        <div>{props.title}</div>
        <div>{props.subTitle}</div>
      </div>
      <div className="selectOptionChart">
        <Chart selectedView={props.view} data={props.data} maxDataPoints={10} />
      </div>
    </button>
  );
}

function Header() {
  return (
    <header>
      <button
        id="close"
        onClick={() => window.electron.sendFrameAction('CLOSE')}
      />
      <button
        id="minimize"
        onClick={() => window.electron.sendFrameAction('MINIMIZE')}
      />
      <button
        id="maximize"
        onClick={() => window.electron.sendFrameAction('MAXIMIZE')}
      />
    </header>
  );
}

function useStaticData() {
  const [staticData, setStaticData] = useState<StaticData | null>(null);

  useEffect(() => {
    (async () => {
      setStaticData(await window.electron.getStaticData());
    })();
  }, []);

  return staticData;
}

export default App;