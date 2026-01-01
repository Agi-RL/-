
export interface HistoryItem {
  url: string;
  base64: string;
  timestamp: string;
}

export interface ImageState {
  url: string | null;
  base64: string | null;
  timestamp: string | null;
  history: HistoryItem[];
}

export enum AppStatus {
  IDLE = 'IDLE',
  GENERATING = 'GENERATING',
  EDITING = 'EDITING',
  VOICE_CONNECTING = 'VOICE_CONNECTING',
  VOICE_ACTIVE = 'VOICE_ACTIVE'
}

export interface DesignAction {
  type: 'generate' | 'edit' | 'layout';
  prompt: string;
}

export interface TranscriptionItem {
  speaker: 'user' | 'ai';
  text: string;
}
