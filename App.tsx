
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, Type, LiveServerMessage } from '@google/genai';
import { AppStatus, ImageState, HistoryItem } from './types';
import { encode, decode, decodeAudioData, createBlob } from './utils/audioUtils';

// --- 全中文系统指令：强化创意理解与隐藏转写逻辑 ---
const SYSTEM_INSTRUCTION = `你是一个拥有顶尖审美的 AI 创意导演。
你的核心任务是精准听取用户的【中文】语音指令，并将其转化为具体的图像创作或编辑动作。

规则：
1. 【精准理解】：深入理解用户的意图。如果用户说“让氛围更科幻”，你应该理解为增加霓虹灯、金属质感和深蓝/紫色调。
2. 【无感交互】：你不需要在回复中重复用户的原话，直接以导演的口吻告知你正在进行的艺术创作动作（例如：“正在为您重构赛博朋克光影...”）。
3. 【功能调用】：
   - 使用 generateImage(prompt) 创作全新作品。
   - 使用 editImage(prompt) 对当前画面进行局部重塑或整体风格迁移。
   - 使用 posterLayout(prompt, textContent) 进行平面排版设计。

你的声音应该是专业、充满艺术感的。`;

const getTimestamp = () => {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', { hour12: false });
};

export default function App() {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [imageState, setImageState] = useState<ImageState>({ 
    url: null, 
    base64: null, 
    timestamp: null,
    history: [] 
  });
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [aiResponseText, setAiResponseText] = useState<string>('');

  // Refs for audio and session
  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // --- 图像生成与编辑核心逻辑 ---
  const generateImage = async (prompt: string) => {
    setStatus(AppStatus.GENERATING);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `High quality, aesthetic, ${prompt}` }] },
        config: { imageConfig: { aspectRatio: "1:1" } }
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const url = `data:image/png;base64,${part.inlineData.data}`;
          const base64 = part.inlineData.data;
          const timestamp = getTimestamp();
          const newItem: HistoryItem = { url, base64, timestamp };
          
          setImageState(prev => ({ 
            ...prev, 
            url, 
            base64, 
            timestamp,
            history: [newItem, ...prev.history].slice(0, 10) 
          }));
          break;
        }
      }
    } catch (error) {
      console.error("生成失败:", error);
    } finally {
      setStatus(isLiveActive ? AppStatus.VOICE_ACTIVE : AppStatus.IDLE);
    }
  };

  const editImage = async (prompt: string) => {
    if (!imageState.base64) return;
    setStatus(AppStatus.EDITING);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            { inlineData: { data: imageState.base64, mimeType: 'image/png' } },
            { text: `Modify the image based on this: ${prompt}` }
          ]
        }
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const url = `data:image/png;base64,${part.inlineData.data}`;
          const base64 = part.inlineData.data;
          const timestamp = getTimestamp();
          const newItem: HistoryItem = { url, base64, timestamp };

          setImageState(prev => ({ 
            ...prev, 
            url, 
            base64, 
            timestamp,
            history: [newItem, ...prev.history].slice(0, 10) 
          }));
          break;
        }
      }
    } catch (error) {
      console.error("编辑失败:", error);
    } finally {
      setStatus(isLiveActive ? AppStatus.VOICE_ACTIVE : AppStatus.IDLE);
    }
  };

  // --- Live API 工具定义 ---
  const tools = [{
    functionDeclarations: [
      {
        name: 'generateImage',
        parameters: {
          type: Type.OBJECT,
          description: '生成一张全新的创意图片',
          properties: { prompt: { type: Type.STRING, description: '创意描述词' } },
          required: ['prompt'],
        },
      },
      {
        name: 'editImage',
        parameters: {
          type: Type.OBJECT,
          description: '基于当前图像进行创意重塑或修改',
          properties: { prompt: { type: Type.STRING, description: '重塑或修改的具体指令' } },
          required: ['prompt'],
        },
      },
      {
        name: 'posterLayout',
        parameters: {
          type: Type.OBJECT,
          description: '进行智能海报排版与设计',
          properties: {
            prompt: { type: Type.STRING, description: '版式风格描述' },
            textContent: { type: Type.STRING, description: '需要呈现在海报上的文字' }
          },
          required: ['prompt', 'textContent'],
        },
      }
    ]
  }];

  const startVoiceSession = async () => {
    if (isLiveActive) {
      stopVoiceSession();
      return;
    }

    setStatus(AppStatus.VOICE_CONNECTING);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
    
    const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    audioContextRef.current = { input: inputCtx, output: outputCtx };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      callbacks: {
        onopen: () => {
          setIsLiveActive(true);
          setStatus(AppStatus.VOICE_ACTIVE);
          
          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            sessionPromise.then(session => {
              if (sessionRef.current) { // Ensure session is still active
                session.sendRealtimeInput({ media: createBlob(inputData) });
              }
            });
          };
          source.connect(processor);
          processor.connect(inputCtx.destination);
        },
        onmessage: async (msg: LiveServerMessage) => {
          const audioBase64 = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audioBase64 && audioContextRef.current) {
            const ctx = audioContextRef.current.output;
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
            const buffer = await decodeAudioData(decode(audioBase64), ctx, 24000, 1);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += buffer.duration;
            sourcesRef.current.add(source);
          }

          if (msg.serverContent?.outputTranscription) {
            setAiResponseText(msg.serverContent.outputTranscription.text);
          }

          if (msg.toolCall) {
            for (const fc of msg.toolCall.functionCalls) {
              if (fc.name === 'generateImage') {
                generateImage(fc.args.prompt);
              } else if (fc.name === 'editImage' || fc.name === 'posterLayout') {
                editImage(fc.args.prompt + (fc.args.textContent ? `. Text to add: ${fc.args.textContent}` : ''));
              }
              
              sessionPromise.then(session => {
                if (sessionRef.current) {
                  session.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                  });
                }
              });
            }
          }

          if (msg.serverContent?.interrupted) {
            sourcesRef.current.forEach(s => {
              try { s.stop(); } catch(e) {}
            });
            sourcesRef.current.clear();
            nextStartTimeRef.current = 0;
          }
        },
        onerror: (e) => {
          console.error("Session Error:", e);
          stopVoiceSession();
        },
        onclose: () => {
          stopVoiceSession();
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM_INSTRUCTION,
        tools,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
        outputAudioTranscription: {}, 
      }
    });

    sessionRef.current = sessionPromise;
  };

  const stopVoiceSession = () => {
    // 1. Clean up session immediately to avoid re-entry via callbacks
    if (sessionRef.current) {
      sessionRef.current.then((s: any) => {
        try { s.close(); } catch(e) {}
      });
      sessionRef.current = null;
    }

    // 2. Stop microphone tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    // 3. Close AudioContexts safely
    if (audioContextRef.current) {
      const { input, output } = audioContextRef.current;
      
      // Prevent "Cannot close a closed AudioContext" by checking state
      if (input.state !== 'closed') {
        input.close().catch(() => {});
      }
      if (output.state !== 'closed') {
        output.close().catch(() => {});
      }
      audioContextRef.current = null;
    }

    // 4. Stop playing sources
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    // 5. Update UI state
    setIsLiveActive(false);
    setStatus(AppStatus.IDLE);
    setAiResponseText('');
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = (event.target?.result as string).split(',')[1];
        const url = event.target?.result as string;
        const timestamp = getTimestamp();
        setImageState({ 
          url, 
          base64, 
          timestamp,
          history: [{ url, base64, timestamp }, ...imageState.history].slice(0, 10) 
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const selectFromHistory = (item: HistoryItem) => {
    setImageState(prev => ({
      ...prev,
      url: item.url,
      base64: item.base64,
      timestamp: item.timestamp
    }));
  };

  return (
    <div className="min-h-screen bg-black text-white selection:bg-blue-500/30 font-sans overflow-hidden flex flex-col">
      {/* 氛围灯光 */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/10 blur-[120px] rounded-full" />
      </div>

      {/* 顶部导航 */}
      <header className="relative z-10 px-8 py-6 flex justify-between items-center border-b border-white/5 backdrop-blur-md bg-black/20">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-[0_0_30px_-5px_rgba(59,130,246,0.5)]">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/50">灵感画界</h1>
            <p className="text-[10px] text-white/30 font-mono tracking-widest uppercase">Inspiration Studio</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <label className="group flex items-center gap-3 glass-panel px-5 py-2.5 rounded-full border border-white/10 hover:border-white/30 cursor-pointer transition-all active:scale-95">
            <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
            <svg className="w-4 h-4 text-white/60 group-hover:text-white transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-5-8l-5-5m0 0l-5 5m5-5v12" />
            </svg>
            <span className="text-xs font-medium text-white/60 group-hover:text-white transition-colors">上传参考图</span>
          </label>
        </div>
      </header>

      {/* 主画布区域 */}
      <main className="flex-1 relative flex items-center justify-center p-6 md:p-12 overflow-hidden">
        <div className="relative w-full max-w-4xl aspect-square md:aspect-[4/3] flex items-center justify-center">
          {/* 画布边框装饰 */}
          <div className="absolute inset-[-2px] bg-gradient-to-br from-white/10 via-transparent to-white/10 rounded-[2.5rem] -z-1" />
          
          <div className="w-full h-full glass-panel rounded-[2.5rem] border border-white/10 overflow-hidden flex items-center justify-center relative shadow-2xl">
            {imageState.url ? (
              <>
                <img 
                  src={imageState.url} 
                  alt="AI Creation" 
                  className={`max-w-full max-h-full object-contain transition-all duration-1000 ${status !== AppStatus.IDLE && status !== AppStatus.VOICE_ACTIVE ? 'scale-95 opacity-50 grayscale' : 'scale-100'}`}
                />
                {/* 生成时间提示标志 */}
                {imageState.timestamp && (
                  <div className="absolute top-8 right-8 animate-in fade-in zoom-in duration-500">
                    <div className="glass-panel px-4 py-1.5 rounded-full border border-white/20 shadow-xl flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                      <span className="text-[10px] font-bold tracking-[0.1em] text-white/70 uppercase">生成于 {imageState.timestamp}</span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center space-y-6 max-w-sm px-6">
                <div className="w-24 h-24 mx-auto bg-white/5 rounded-full flex items-center justify-center animate-pulse border border-white/5">
                  <svg className="w-10 h-10 text-white/10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-medium text-white/60">等待您的艺术指令</h2>
                  <p className="text-sm text-white/20 mt-2 leading-relaxed">请开启麦克风，直接说出您的创意构思，AI 将为您即刻创作或重塑。</p>
                </div>
              </div>
            )}

            {/* AI 实时文字反馈 (导演旁白) */}
            {aiResponseText && (
              <div className="absolute bottom-12 left-0 right-0 flex justify-center px-8 pointer-events-none">
                <div className="bg-black/80 backdrop-blur-xl border border-white/10 px-6 py-3 rounded-2xl shadow-2xl max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <p className="text-sm text-blue-300 font-medium text-center leading-relaxed">
                    {aiResponseText}
                  </p>
                </div>
              </div>
            )}

            {/* 状态指示器 */}
            {(status === AppStatus.GENERATING || status === AppStatus.EDITING) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[2px] z-20">
                <div className="flex gap-1.5 items-end h-10 mb-6">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="w-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.1}s`, height: '60%' }} />
                  ))}
                </div>
                <p className="text-xs font-bold tracking-widest text-white/40 uppercase">AI 正在精准重绘中...</p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* 底部交互区 */}
      <footer className="relative z-10 px-8 py-10 flex flex-col items-center gap-8">
        {/* 历史记录微缩图 */}
        <div className="flex gap-4 p-2 glass-panel rounded-2xl border border-white/5 max-w-2xl overflow-x-auto no-scrollbar">
          {imageState.history.length === 0 && (
             <div className="w-14 h-14 rounded-lg bg-white/5 border border-dashed border-white/10 flex items-center justify-center text-white/10 text-[8px] uppercase tracking-tighter">无历史</div>
          )}
          {imageState.history.map((item, i) => (
            <button 
              key={i} 
              onClick={() => selectFromHistory(item)}
              className={`flex-shrink-0 w-14 h-14 rounded-lg border-2 overflow-hidden transition-all relative group/item ${imageState.url === item.url ? 'border-blue-500 scale-105 shadow-lg shadow-blue-500/20' : 'border-white/5 grayscale opacity-40 hover:grayscale-0 hover:opacity-100'}`}
            >
              <img src={item.url} alt="History" className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity">
                <span className="text-[7px] font-bold text-white tracking-tighter">{item.timestamp}</span>
              </div>
            </button>
          ))}
        </div>

        {/* 核心麦克风按钮 */}
        <div className="flex items-center gap-12">
          <button
            onClick={startVoiceSession}
            className={`group relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-700 ${
              isLiveActive 
              ? 'bg-red-500/10 border-red-500/50 shadow-[0_0_50px_-10px_rgba(239,68,68,0.4)]' 
              : 'bg-white/5 border-white/10 hover:border-blue-500/50 hover:bg-blue-500/10'
            } border-2 backdrop-blur-3xl`}
          >
            {/* 涟漪动画 */}
            {isLiveActive && (
              <>
                <div className="absolute inset-0 rounded-full border-2 border-red-500/30 animate-[ping_1.5s_infinite]" />
                <div className="absolute inset-2 rounded-full border-2 border-red-500/20 animate-[ping_2s_infinite]" />
              </>
            )}

            {isLiveActive ? (
              <svg className="w-8 h-8 text-red-500" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-white transition-all group-hover:scale-110 group-active:scale-95" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
            
            {/* 状态提示 */}
            <div className={`absolute -top-12 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-bold tracking-[0.2em] uppercase transition-all duration-500 ${isLiveActive ? 'text-red-500 opacity-100' : 'text-white/20 opacity-0 group-hover:opacity-100'}`}>
              {isLiveActive ? '正在倾听灵感' : '开启艺术对话'}
            </div>
          </button>
        </div>

        {/* 提示信息 */}
        <div className="text-[10px] text-white/20 flex gap-6 uppercase tracking-widest font-medium">
          <span className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-blue-500" /> 全中文语义理解</span>
          <span className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-purple-500" /> 毫秒级视觉重塑</span>
          <span className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-indigo-500" /> 隐私安全交互</span>
        </div>
      </footer>
    </div>
  );
}
