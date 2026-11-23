import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send,
  User,
  Bot,
  Sparkles,
  RefreshCcw,
  Loader2,
  MessageSquare,
  AlertCircle,
  Mic,
  MicOff,
  Volume2,
  VolumeX
} from 'lucide-react';
import {
  getInterviewFeedback,
  transcribeAudio,
  synthesizeSpeech,
  InterviewRoundSummary
} from '../services/ai';
import { cn } from '../lib/utils';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  feedback?: string;
  answerScore?: number;
  roundSummary?: InterviewRoundSummary;
}

type MicMode = 'studio' | 'browser';
type AgentVoice = 'Zephyr' | 'Puck' | 'Kore' | 'Charon' | 'Fenrir';

const VOICE_OPTIONS: { id: AgentVoice; label: string }[] = [
  { id: 'Zephyr', label: 'Zephyr (Simple & Clear)' },
  { id: 'Puck', label: 'Puck (Friendly Male)' },
  { id: 'Charon', label: 'Charon (Calm Deep)' },
  { id: 'Kore', label: 'Kore (Warm Studio)' },
  { id: 'Fenrir', label: 'Fenrir (Direct & Crisp)' }
];

const FALLBACK_QUESTIONS: Record<string, string[]> = {
  default: [
    'Tell me about yourself and your primary technical skills.',
    'Can you describe a challenging project you built and how you solved a difficult problem in it?',
    'How do you handle debugging and troubleshooting when your code behaves unexpectedly?',
    'Where do you see yourself technically in the next 2 to 3 years?'
  ],
  web: [
    'Can you explain the difference between CSS Grid and Flexbox with a practical use case?',
    'How does the browser event loop handle microtasks versus macrotasks in JavaScript?',
    'What strategies do you use to optimize website load time and Core Web Vitals?'
  ],
  react: [
    'What is the difference between useEffect and useLayoutEffect, and when would you use each?',
    'How does React handle re-rendering, and when should you optimize with memoization?',
    'Explain how you design state management for large-scale frontend applications.'
  ],
  node: [
    'How does the Node.js event loop handle asynchronous I/O without blocking the main thread?',
    'How do you structure authentication, rate limiting, and error handling in Express APIs?',
    'What strategies do you use to handle database connection pooling and high concurrency?'
  ],
  java: [
    'What is the difference between JVM, JRE, and JDK, and how does Garbage Collection work in Java?',
    'Can you explain the difference between HashMap and ConcurrentHashMap?',
    'What are SOLID design principles, and how have you applied them in your code?'
  ],
  sql: [
    'What is the difference between Clustered and Non-Clustered Indexes in SQL?',
    'Can you explain ACID properties in database transactions and what happens during a rollback?',
    'How do you optimize a slow-running SQL query with multiple JOINs?'
  ],
  python: [
    'How do lists, tuples, sets, and dictionaries differ in Python under the hood?',
    'What is the Global Interpreter Lock (GIL), and when do you use multiprocessing vs asyncio?',
    'How do you prevent overfitting and evaluate model performance in a machine learning pipeline?'
  ]
};

const TOPICS = [
  'Web Development (HTML, CSS, JS)',
  'React & Frontend Architecture',
  'Node.js & Backend Systems',
  'SQL & Database Engineering',
  'Data Structures & Algorithms (DSA)',
  'Java Core & Spring Boot',
  'Python & AI/ML Systems'
];

function cleanUiError(err: any, fallback: string): string {
  const raw = String(err?.message || err || '').trim();
  if (!raw) return fallback;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const msg = parsed?.error?.message || parsed?.message;
      if (parsed?.error?.code === 503 || parsed?.error?.code === 429) {
        return 'Speech transcription service is briefly busy. Please retry or switch to Live Browser Mic.';
      }
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
    } catch {
      // fall through
    }
  }
  return raw;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Decodes browser MediaRecorder audio (webm/mp4/ogg), checks if microphone captured sound,
 * auto-normalizes quiet mic gain, and exports clean 16kHz Mono PCM WAV for accurate transcription.
 */
async function prepareNormalizedWav(
  blob: Blob,
  observedLivePeak: number
): Promise<{
  base64: string;
  mimeType: string;
  isSilent: boolean;
}> {
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    return {
      base64: uint8ToBase64(buf),
      mimeType: blob.type || 'audio/webm',
      isSilent: false
    };
  }

  const ctx = new AudioContextCtor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);

    for (let ch = 0; ch < numChannels; ch++) {
      const chData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        mono[i] += chData[i] / numChannels;
      }
    }

    let peak = 0;
    for (let i = 0; i < mono.length; i++) {
      const abs = Math.abs(mono[i]);
      if (abs > peak) peak = abs;
    }

    // Only reject if genuinely dead/muted digital silence across both decoder and live meter
    if (peak < 0.00015) {
      if (observedLivePeak >= 0.008) {
        const rawBuf = new Uint8Array(arrayBuffer);
        return {
          base64: uint8ToBase64(rawBuf),
          mimeType: blob.type || 'audio/webm',
          isSilent: false
        };
      }
      return { base64: '', mimeType: 'audio/wav', isSilent: true };
    }

    // Downsample to 16kHz mono
    const targetRate = 16000;
    const ratio = audioBuffer.sampleRate / targetRate;
    const outLen = Math.max(1, Math.floor(mono.length / ratio));
    const downsampled = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(mono.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      const count = Math.max(1, end - start);
      for (let j = start; j < end; j++) {
        sum += mono[j];
      }
      downsampled[i] = sum / count;
    }

    // Normalize gain cleanly so quiet laptop/headset mics become crisp
    const gain = Math.min(45, 0.85 / peak);

    const wavBuffer = new ArrayBuffer(44 + outLen * 2);
    const view = new DataView(wavBuffer);
    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + outLen * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, outLen * 2, true);

    let offset = 44;
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, downsampled[i] * gain));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    return {
      base64: uint8ToBase64(new Uint8Array(wavBuffer)),
      mimeType: 'audio/wav',
      isSilent: false
    };
  } catch {
    // Fallback to raw recorded blob if browser decodeAudioData fails for codec
    const buf = new Uint8Array(await blob.arrayBuffer());
    return {
      base64: uint8ToBase64(buf),
      mimeType: blob.type || 'audio/webm',
      isSilent: false
    };
  } finally {
    ctx.close().catch(() => {});
  }
}

export default function MockInterview() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [topic, setTopic] = useState(TOPICS[0]);
  const [customTopic, setCustomTopic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);

  // Voice states
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [autoplayBlockedText, setAutoplayBlockedText] = useState<string | null>(null);
  const [micSupported, setMicSupported] = useState(true);
  const [hasMediaRecorderApi, setHasMediaRecorderApi] = useState(false);
  const [hasBrowserStt, setHasBrowserStt] = useState(false);
  const [micMode, setMicMode] = useState<MicMode>('studio');
  const [agentVoice, setAgentVoice] = useState<AgentVoice>('Zephyr');
  const [answerScores, setAnswerScores] = useState<number[]>([]);
  const [roundSummaries, setRoundSummaries] = useState<InterviewRoundSummary[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const answerScoresRef = useRef<number[]>([]);
  const recognitionRef = useRef<any>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const isRecordingRef = useRef(false);
  const micModeRef = useRef<MicMode>('studio');
  const agentVoiceRef = useRef<AgentVoice>('Zephyr');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const sendAfterStopRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const maxPeakObservedRef = useRef(0);

  const baseInputRef = useRef('');
  const latestInputRef = useRef('');
  const speakTimerRef = useRef<number | null>(null);
  const speechWatchdogRef = useRef<number | null>(null);
  const resumeIntervalRef = useRef<number | null>(null);
  const ttsCacheRef = useRef<Map<string, string>>(new Map());
  const voiceEnabledRef = useRef(voiceEnabled);
  const browserTtsTriggeredRef = useRef(false);
  const speakRequestIdRef = useRef(0);
  const submitAnswerTextRef = useRef<(text: string) => Promise<void>>(async () => {});

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  useEffect(() => {
    micModeRef.current = micMode;
  }, [micMode]);

  useEffect(() => {
    latestInputRef.current = input;
  }, [input]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, isTranscribing]);

  const clearSpeechTimers = useCallback(() => {
    if (speakTimerRef.current !== null) {
      window.clearTimeout(speakTimerRef.current);
      speakTimerRef.current = null;
    }
    if (speechWatchdogRef.current !== null) {
      window.clearTimeout(speechWatchdogRef.current);
      speechWatchdogRef.current = null;
    }
    if (resumeIntervalRef.current !== null) {
      window.clearInterval(resumeIntervalRef.current);
      resumeIntervalRef.current = null;
    }
  }, []);

  const stopMeter = useCallback(() => {
    if (levelRafRef.current !== null) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setAudioLevel(0);
    setRecordingSeconds(0);
  }, []);

  const releaseMediaStream = useCallback(() => {
    stopMeter();
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, [stopMeter]);

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stopAllAudioOutput = useCallback(() => {
    speakRequestIdRef.current += 1;
    clearSpeechTimers();
    browserTtsTriggeredRef.current = false;
    if (audioPlayerRef.current) {
      try {
        audioPlayerRef.current.onended = null;
        audioPlayerRef.current.onerror = null;
        audioPlayerRef.current.pause();
        audioPlayerRef.current.currentTime = 0;
      } catch {
        // ignore audio reset error
      }
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
    setAutoplayBlockedText(null);
  }, [clearSpeechTimers]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices();
      if (available.length > 0) {
        voicesRef.current = available;
      }
    };

    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

  // Initialize both MediaRecorder capability and SpeechRecognition (used independently, never concurrently)
  useEffect(() => {
    const canMediaRecorder =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== 'undefined';

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    setHasMediaRecorderApi(canMediaRecorder);
    setHasBrowserStt(Boolean(SpeechRecognition));

    if (canMediaRecorder) {
      setMicMode('studio');
      micModeRef.current = 'studio';
      setMicSupported(true);
    } else if (SpeechRecognition) {
      setMicMode('browser');
      micModeRef.current = 'browser';
      setMicSupported(true);
    } else {
      setMicSupported(false);
    }

    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        let spoken = '';
        for (let i = 0; i < event.results.length; i++) {
          spoken += (event.results[i][0]?.transcript || '') + ' ';
        }
        const combined = [baseInputRef.current.trim(), spoken.trim()].filter(Boolean).join(' ');
        latestInputRef.current = combined;
        setInput(combined);
      };

      recognition.onerror = (ev: any) => {
        isRecordingRef.current = false;
        setIsRecording(false);
        const code = ev?.error || '';
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setVoiceNotice(
            'Microphone permission is blocked in this browser/preview. Allow Microphone in site settings or open the app in a new tab.'
          );
        } else if (code === 'no-speech') {
          setVoiceNotice(
            'Browser Speech-to-Text did not detect speech. Speak closer to your mic or switch to Studio AI Mic.'
          );
        } else if (code !== 'aborted') {
          setVoiceNotice(
            'Browser speech recognition stopped. Try Studio AI Mic or type your answer below.'
          );
        }
      };

      recognition.onend = () => {
        if (isRecordingRef.current) {
          isRecordingRef.current = false;
          setIsRecording(false);
          if (sendAfterStopRef.current) {
            sendAfterStopRef.current = false;
            const textToSend = latestInputRef.current.trim();
            if (textToSend) {
              submitAnswerTextRef.current(textToSend);
            }
          }
        }
      };

      recognitionRef.current = recognition;
    }

    return () => {
      clearSpeechTimers();
      releaseMediaStream();
      revokeObjectUrl();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
      stopAllAudioOutput();
    };
  }, [clearSpeechTimers, releaseMediaStream, revokeObjectUrl, stopAllAudioOutput]);

  const unlockAudioElement = () => {
    if (!voiceEnabledRef.current || !audioPlayerRef.current) return;
    try {
      const player = audioPlayerRef.current;
      if (!player.paused && player.currentTime > 0) return;
      player.muted = true;
      player.src =
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      const p = player.play();
      if (p) {
        p.then(() => {
          player.pause();
          player.muted = false;
        }).catch(() => {
          player.muted = false;
        });
      }
    } catch {
      // ignore unlock error
    }
  };

  const speakWithBrowserTts = useCallback(
    (cleanText: string, reqId: number) => {
      if (browserTtsTriggeredRef.current || reqId !== speakRequestIdRef.current) return;
      browserTtsTriggeredRef.current = true;

      if (!voiceEnabledRef.current || typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setIsSpeaking(false);
        setAutoplayBlockedText(cleanText);
        return;
      }

      clearSpeechTimers();
      window.speechSynthesis.cancel();

      speakTimerRef.current = window.setTimeout(() => {
        if (reqId !== speakRequestIdRef.current || !voiceEnabledRef.current) {
          setIsSpeaking(false);
          return;
        }

        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.rate = 0.96;
        utterance.pitch = 1.0;

        const availableVoices =
          voicesRef.current.length > 0 ? voicesRef.current : window.speechSynthesis.getVoices();
        const englishVoice =
          availableVoices.find(
            (v) =>
              v.lang.startsWith('en') &&
              (v.name.includes('Google') ||
                v.name.includes('Natural') ||
                v.name.includes('Samantha'))
          ) || availableVoices.find((v) => v.lang.startsWith('en'));

        if (englishVoice) {
          utterance.voice = englishVoice;
        }

        let didStart = false;

        utterance.onstart = () => {
          didStart = true;
          if (speechWatchdogRef.current !== null) {
            window.clearTimeout(speechWatchdogRef.current);
            speechWatchdogRef.current = null;
          }
          setIsSpeaking(true);
          setAutoplayBlockedText(null);
          resumeIntervalRef.current = window.setInterval(() => {
            if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
              window.speechSynthesis.pause();
              window.speechSynthesis.resume();
            }
          }, 10000);
        };

        utterance.onend = () => {
          clearSpeechTimers();
          setIsSpeaking(false);
        };

        utterance.onerror = () => {
          clearSpeechTimers();
          setIsSpeaking(false);
          if (!didStart) {
            setAutoplayBlockedText(cleanText);
          }
        };

        // Safety watchdog in case browser silently ignores speechSynthesis without firing events
        speechWatchdogRef.current = window.setTimeout(() => {
          if (!didStart && !window.speechSynthesis.speaking) {
            clearSpeechTimers();
            setIsSpeaking(false);
            setAutoplayBlockedText(cleanText);
          }
        }, 1500);

        try {
          window.speechSynthesis.speak(utterance);
        } catch {
          clearSpeechTimers();
          setIsSpeaking(false);
          setAutoplayBlockedText(cleanText);
        }
      }, 60);
    },
    [clearSpeechTimers]
  );

  const speakText = useCallback(
    async (text: string) => {
      if (!voiceEnabledRef.current || typeof window === 'undefined') return;
      const cleanText = text.replace(/[*_#`]/g, '').trim();
      if (!cleanText) return;

      stopAllAudioOutput();
      const reqId = speakRequestIdRef.current;
      const activeVoice = agentVoiceRef.current;
      const cacheKey = `${activeVoice}:${cleanText}`;
      setIsSpeaking(true);
      setAutoplayBlockedText(null);

      try {
        let base64 = ttsCacheRef.current.get(cacheKey);
        if (!base64) {
          const res = await synthesizeSpeech(cleanText, activeVoice);
          if (reqId !== speakRequestIdRef.current || !voiceEnabledRef.current) {
            setIsSpeaking(false);
            return;
          }
          base64 = res.audioBase64;
          ttsCacheRef.current.set(cacheKey, base64);
        }

        if (reqId !== speakRequestIdRef.current || !voiceEnabledRef.current) {
          setIsSpeaking(false);
          return;
        }

        revokeObjectUrl();
        const wavBlob = base64ToBlob(base64, 'audio/wav');
        const url = URL.createObjectURL(wavBlob);
        objectUrlRef.current = url;

        const player = audioPlayerRef.current || new Audio();
        audioPlayerRef.current = player;
        player.muted = false;
        player.src = url;
        player.onended = () => setIsSpeaking(false);
        player.onerror = () => {
          setIsSpeaking(false);
          speakWithBrowserTts(cleanText, reqId);
        };
        await player.play();
      } catch (err: any) {
        if (reqId !== speakRequestIdRef.current) return;
        if (err?.name === 'NotAllowedError') {
          setIsSpeaking(false);
          setAutoplayBlockedText(cleanText);
        } else if (voiceEnabledRef.current) {
          speakWithBrowserTts(cleanText, reqId);
        } else {
          setIsSpeaking(false);
        }
      }
    },
    [stopAllAudioOutput, revokeObjectUrl, speakWithBrowserTts]
  );

  const startLiveAudioMeter = (stream: MediaStream) => {
    try {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextCtor) return;
      const ctx = new AudioContextCtor();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      maxPeakObservedRef.current = 0;

      const updateLevel = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        if (peak > maxPeakObservedRef.current) {
          maxPeakObservedRef.current = peak;
        }
        setAudioLevel(Math.min(100, Math.round(peak * 260)));
        levelRafRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();
    } catch {
      // Visual meter only
    }
  };

  const activeTopic = (customTopic.trim() || topic).trim();

  const submitAnswerText = useCallback(
    async (answerTextRaw: string) => {
      const answerText = answerTextRaw.trim();
      if (!answerText || loading) return;

      baseInputRef.current = '';
      latestInputRef.current = '';
      setInput('');

      const userMsg: ChatMessage = { role: 'user', text: answerText };
      const newMessages = [...messagesRef.current, userMsg];
      const totalAnswered = newMessages.filter((m) => m.role === 'user').length;
      const priorScores = answerScoresRef.current;

      messagesRef.current = newMessages;
      setMessages(newMessages);
      setLoading(true);
      setError(null);

      try {
        let nextQuestion = '';
        let feedback = '';
        let answerScore: number | undefined;
        let roundSummary: InterviewRoundSummary | undefined;

        try {
          const history = newMessages.map((m) => ({ role: m.role, text: m.text }));
          const response = await getInterviewFeedback(
            activeTopic,
            history,
            totalAnswered,
            priorScores
          );
          nextQuestion = response.question;
          feedback = response.feedback || '';
          answerScore = response.answerScore;
          roundSummary = response.roundSummary;
        } catch (apiErr: any) {
          console.warn('Using fallback question due to API error:', apiErr);
          feedback =
            'Could not reach the AI grader right now, so here is your next practice question.';
          nextQuestion = getFallbackQuestion(activeTopic, totalAnswered);
        }

        if (typeof answerScore === 'number' && Number.isFinite(answerScore)) {
          const updatedScores = [...answerScoresRef.current, answerScore];
          answerScoresRef.current = updatedScores;
          setAnswerScores(updatedScores);
        }

        if (roundSummary) {
          setRoundSummaries((prev) => [...prev, roundSummary!]);
        }

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          text: nextQuestion,
          feedback,
          answerScore,
          roundSummary
        };
        setMessages((prev) => [...prev, assistantMsg]);

        const spokenParts = [
          feedback,
          roundSummary ? roundSummary.spokenSummary : '',
          `Next question: ${nextQuestion}`
        ].filter(Boolean);
        speakText(spokenParts.join(' '));
      } catch (err: any) {
        console.error(err);
        setError(cleanUiError(err, 'Failed to get response from AI. Please try again.'));
      } finally {
        setLoading(false);
      }
    },
    [activeTopic, loading, speakText]
  );

  useEffect(() => {
    submitAnswerTextRef.current = submitAnswerText;
  }, [submitAnswerText]);

  const stopRecording = useCallback((autoSend = false) => {
    sendAfterStopRef.current = autoSend;

    if (micModeRef.current === 'studio' && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        if (mediaRecorderRef.current.state === 'recording') {
          try {
            mediaRecorderRef.current.requestData();
          } catch {
            // ignore requestData not supported
          }
        }
        mediaRecorderRef.current.stop();
      } catch {
        isRecordingRef.current = false;
        setIsRecording(false);
        releaseMediaStream();
      }
    } else if (micModeRef.current === 'browser' && recognitionRef.current && isRecordingRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        isRecordingRef.current = false;
        setIsRecording(false);
      }
    }
  }, [releaseMediaStream]);

  const startRecording = async (overrideMode?: MicMode) => {
    if (!micSupported) {
      setVoiceNotice('Voice recording is not available in this browser. Please type your answer below.');
      return;
    }

    const activeMode = overrideMode || micModeRef.current;
    stopAllAudioOutput();
    setVoiceNotice(null);
    baseInputRef.current = latestInputRef.current.trim();
    sendAfterStopRef.current = false;

    if (activeMode === 'browser' && recognitionRef.current) {
      try {
        recognitionRef.current.start();
        isRecordingRef.current = true;
        setIsRecording(true);
        setRecordingSeconds(0);
        if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = window.setInterval(() => {
          setRecordingSeconds((s) => s + 1);
        }, 1000);
      } catch {
        setVoiceNotice(
          hasMediaRecorderApi
            ? 'Could not start browser speech recognition. Switching to Studio AI Mic.'
            : 'Could not start speech recognition. Please type your answer below.'
        );
        if (hasMediaRecorderApi) {
          setMicMode('studio');
          micModeRef.current = 'studio';
        }
      }
      return;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (constraintErr: any) {
        if (
          constraintErr?.name === 'OverconstrainedError' ||
          constraintErr?.name === 'ConstraintNotSatisfiedError'
        ) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw constraintErr;
        }
      }

      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      startLiveAudioMeter(stream);
      setRecordingSeconds(0);
      if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);

      const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      const chosenType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = chosenType
        ? new MediaRecorder(stream, { mimeType: chosenType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          audioChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        isRecordingRef.current = false;
        setIsRecording(false);
        const observedPeak = maxPeakObservedRef.current;
        releaseMediaStream();

        const shouldSend = sendAfterStopRef.current;
        sendAfterStopRef.current = false;

        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];

        if (blob.size < 200) {
          setVoiceNotice('Recording was too short. Click Speak Answer, speak a full sentence, then click Stop.');
          return;
        }

        setIsTranscribing(true);
        let textToAutoSend = '';
        try {
          const normalized = await prepareNormalizedWav(blob, observedPeak);
          if (normalized.isSilent) {
            setVoiceNotice(
              'Your microphone captured silence (0% audio level). Check that your device mic is unmuted in browser/OS settings, or type below.'
            );
            return;
          }

          const transcript = await transcribeAudio(normalized.base64, normalized.mimeType);
          if (transcript) {
            const finalText = [baseInputRef.current.trim(), transcript.trim()]
              .filter(Boolean)
              .join(' ');
            baseInputRef.current = finalText;
            latestInputRef.current = finalText;
            setInput(finalText);
            if (shouldSend) {
              textToAutoSend = finalText;
            }
          } else {
            setVoiceNotice(
              'Could not recognize words from the recording. Try speaking slightly closer to the mic, switch to Live Browser Mic, or type below.'
            );
          }
        } catch (err: any) {
          setVoiceNotice(
            cleanUiError(err, 'Could not transcribe audio. Please try again or type your answer below.')
          );
        } finally {
          setIsTranscribing(false);
        }

        if (textToAutoSend) {
          await submitAnswerTextRef.current(textToAutoSend);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      isRecordingRef.current = true;
      setIsRecording(true);
    } catch (err: any) {
      releaseMediaStream();
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setVoiceNotice(
          'Microphone permission is blocked in this browser/preview. Allow Microphone in site settings (or open the app in a new tab), or type your answer below.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setVoiceNotice('No microphone detected on this device. Connect a mic or type your answer below.');
      } else {
        setVoiceNotice('Could not access microphone. You can still type your answer below.');
      }
    }
  };

  const toggleRecording = async () => {
    unlockAudioElement();
    if (isRecordingRef.current) {
      stopRecording(false);
    } else {
      await startRecording();
    }
  };

  const switchMicMode = (nextMode: MicMode) => {
    if (isRecordingRef.current) {
      stopRecording(false);
    }
    setMicMode(nextMode);
    micModeRef.current = nextMode;
    setVoiceNotice(null);
  };

  const getFallbackQuestion = (currentTopic: string, index: number) => {
    const key =
      Object.keys(FALLBACK_QUESTIONS).find((k) =>
        currentTopic.toLowerCase().includes(k)
      ) || 'default';
    const list = FALLBACK_QUESTIONS[key];
    return list[index % list.length];
  };

  const handleStart = async () => {
    if (!activeTopic) return;
    unlockAudioElement();
    setTopic(activeTopic);
    setStarted(true);
    setLoading(true);
    setError(null);
    setVoiceNotice(null);
    setAutoplayBlockedText(null);

    try {
      let question = '';
      try {
        const response = await getInterviewFeedback(activeTopic, []);
        question = response.question;
      } catch (apiErr: any) {
        console.warn('Using fallback question due to API error:', apiErr);
        question = getFallbackQuestion(activeTopic, 0);
      }

      setMessages([{ role: 'assistant', text: question }]);
      speakText(question);
    } catch (err: any) {
      console.error(err);
      setError(cleanUiError(err, 'Failed to start mock interview. Please try again.'));
      setStarted(false);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    unlockAudioElement();

    if (isRecordingRef.current) {
      stopRecording(true);
      return;
    }

    await submitAnswerText(latestInputRef.current);
  };

  const handleReset = () => {
    stopAllAudioOutput();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
    }
    releaseMediaStream();
    isRecordingRef.current = false;
    setIsRecording(false);
    setIsTranscribing(false);
    baseInputRef.current = '';
    latestInputRef.current = '';
    setInput('');
    setVoiceNotice(null);
    setError(null);
    setAutoplayBlockedText(null);
    answerScoresRef.current = [];
    setAnswerScores([]);
    setRoundSummaries([]);
    setMessages([]);
    setStarted(false);
  };

  const filteredTopics = TOPICS.filter((t) =>
    t.toLowerCase().includes(customTopic.toLowerCase())
  );

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${mins}:${rem < 10 ? '0' : ''}${rem}`;
  };

  return (
    <>
      <audio ref={audioPlayerRef} className="hidden" playsInline />
      {!started ? (
        <div className="bg-white p-8 md:p-12 rounded-[32px] border border-brand-border/40 text-center space-y-8 max-w-2xl mx-auto shadow-sm">
          <div className="w-20 h-20 bg-brand-blue/5 rounded-[24px] flex items-center justify-center mx-auto border border-brand-blue/10 shadow-sm relative">
            <MessageSquare className="w-10 h-10 text-brand-blue" />
            <div className="absolute -bottom-1 -right-1 bg-emerald-500 w-6 h-6 rounded-full border-2 border-white flex items-center justify-center">
              <Mic className="w-3.5 h-3.5 text-white" />
            </div>
          </div>
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand-blue/10 text-brand-blue rounded-full text-xs font-bold uppercase tracking-wider">
              <Mic className="w-3.5 h-3.5" /> AI Voice & Audio Enabled
            </div>
            <h2 className="text-[28px] md:text-[32px] font-display font-bold text-brand-blue-heading tracking-tight leading-tight">
              AI Voice Interview Simulator
            </h2>
            <p className="text-brand-muted text-[15px] font-medium leading-relaxed">
              Practice real technical interviews by speaking or typing your answers. The AI speaks questions aloud and gives instant feedback.
            </p>
          </div>

          <div className="space-y-4">
            <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted block">
              Select or Enter Target Domain
            </label>
            <input
              type="text"
              value={customTopic}
              onChange={(e) => setCustomTopic(e.target.value)}
              placeholder="Filter presets or type any custom interview topic..."
              className="w-full px-5 py-4 bg-brand-cream/30 border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue focus:ring-4 focus:ring-brand-blue/5 outline-none transition-all"
            />
            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {(filteredTopics.length > 0 ? filteredTopics : TOPICS).map((t) => {
                const isSelected = !customTopic.trim() && topic === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setTopic(t);
                      setCustomTopic('');
                    }}
                    className={cn(
                      'px-4 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-tight transition-all border',
                      isSelected
                        ? 'bg-brand-blue border-brand-blue text-white shadow-lg active:scale-95'
                        : 'bg-white border-brand-border text-brand-muted hover:border-brand-blue/40'
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            <p className="text-xs font-semibold text-brand-blue">
              Selected Domain: {activeTopic}
            </p>
          </div>

          <button
            type="button"
            onClick={handleStart}
            disabled={!activeTopic}
            className="w-full py-5 bg-brand-blue text-white rounded-2xl font-bold text-[15px] shadow-[0_20px_40px_-10px_rgba(26,110,245,0.4)] hover:bg-brand-blue-dark transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Mic className="w-5 h-5" /> Start Voice Interview Simulation
          </button>
        </div>
      ) : (
        <div className="flex flex-col h-[750px] bg-white rounded-[32px] border border-brand-border/40 overflow-hidden shadow-[0_10px_40px_-10px_rgba(0,0,0,0.05)]">
          {/* Header */}
          <div className="p-6 bg-brand-blue-heading text-white flex flex-wrap justify-between items-center gap-4 relative overflow-hidden">
            <div className="absolute inset-0 bg-brand-blue/10 opacity-30 pointer-events-none" />
            <div className="flex items-center gap-4 relative z-10">
              <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center border border-white/20 backdrop-blur-md relative">
                <Bot className="w-7 h-7 text-white" />
                {isSpeaking && (
                  <span className="absolute -top-1 -right-1 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                  </span>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-display font-bold text-[18px] leading-tight">
                    Simple English Coach
                  </h3>
                  <span className="text-[10px] font-bold bg-white/15 text-white border border-white/20 px-2.5 py-0.5 rounded-full">
                    Round Q {(messages.filter((m) => m.role === 'user').length % 5) + 1}/5
                  </span>
                  {roundSummaries.length > 0 && (
                    <span className="text-[10px] font-bold bg-amber-400/20 text-amber-200 border border-amber-300/40 px-2.5 py-0.5 rounded-full">
                      Latest Score: {roundSummaries[roundSummaries.length - 1].scoreOutOf10}/10
                    </span>
                  )}
                  {isSpeaking && (
                    <span className="text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <Volume2 className="w-3 h-3 animate-pulse" /> Speaking
                    </span>
                  )}
                </div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-brand-blue-heading/70 mt-1 bg-white/90 px-2 py-0.5 rounded inline-block">
                  Domain: {activeTopic}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 relative z-10">
              <select
                value={agentVoice}
                onChange={(e) => {
                  const nextVoice = e.target.value as AgentVoice;
                  setAgentVoice(nextVoice);
                  agentVoiceRef.current = nextVoice;
                  stopAllAudioOutput();
                }}
                aria-label="Select AI voice"
                title="Change interviewer voice"
                className="bg-white/15 text-white text-xs font-bold px-3 py-2 rounded-xl border border-white/25 outline-none cursor-pointer"
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id} className="text-slate-900 bg-white">
                    Voice: {v.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const next = !voiceEnabled;
                  setVoiceEnabled(next);
                  voiceEnabledRef.current = next;
                  if (!next) {
                    stopAllAudioOutput();
                  } else {
                    unlockAudioElement();
                  }
                }}
                title={voiceEnabled ? 'Mute AI Voice' : 'Enable AI Voice'}
                className={cn(
                  'p-2.5 rounded-xl transition-all border',
                  voiceEnabled
                    ? 'bg-white/20 text-white border-white/30 hover:bg-white/30'
                    : 'bg-red-500/20 text-red-200 border-red-500/40'
                )}
              >
                {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={handleReset}
                title="Restart Session"
                className="p-2.5 hover:bg-white/10 rounded-xl transition-all border border-white/10 group active:rotate-90"
              >
                <RefreshCcw className="w-4 h-4 group-hover:text-white transition-opacity text-white/70" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 md:p-10 space-y-8 bg-[#f8fafc]">
            <AnimatePresence initial={false}>
              {messages.map((m, i) => {
                const spokenBundle =
                  m.role === 'assistant'
                    ? [
                        m.feedback || '',
                        m.roundSummary ? m.roundSummary.spokenSummary : '',
                        m.text
                      ]
                        .filter(Boolean)
                        .join(' ')
                    : m.text;

                const isLowScore = typeof m.answerScore === 'number' && m.answerScore <= 3;
                const isMidScore =
                  typeof m.answerScore === 'number' && m.answerScore > 3 && m.answerScore < 7;

                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      'flex gap-4 md:gap-5 max-w-[90%]',
                      m.role === 'user' ? 'ml-auto flex-row-reverse' : ''
                    )}
                  >
                    <div
                      className={cn(
                        'w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 mt-1 shadow-md border',
                        m.role === 'user'
                          ? 'bg-white border-brand-border'
                          : 'bg-brand-blue border-brand-blue shadow-brand-blue/20'
                      )}
                    >
                      {m.role === 'user' ? (
                        <User className="w-5 h-5 text-brand-blue" />
                      ) : (
                        <Bot className="w-5 h-5 text-white" />
                      )}
                    </div>
                    <div className="space-y-3">
                      {m.feedback && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className={cn(
                            'p-4 border rounded-2xl flex items-start gap-3',
                            isLowScore
                              ? 'bg-red-50 border-red-200'
                              : isMidScore
                              ? 'bg-amber-50 border-amber-200'
                              : 'bg-emerald-50 border-emerald-200'
                          )}
                        >
                          <Sparkles
                            className={cn(
                              'w-4 h-4 shrink-0 mt-0.5',
                              isLowScore
                                ? 'text-red-600'
                                : isMidScore
                                ? 'text-amber-600'
                                : 'text-emerald-600'
                            )}
                          />
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'text-[10px] font-black uppercase tracking-widest',
                                  isLowScore
                                    ? 'text-red-700'
                                    : isMidScore
                                    ? 'text-amber-700'
                                    : 'text-emerald-700'
                                )}
                              >
                                Honest Review
                              </span>
                              {typeof m.answerScore === 'number' && (
                                <span
                                  className={cn(
                                    'text-[10px] font-bold px-2 py-0.5 rounded-full',
                                    isLowScore
                                      ? 'bg-red-100 text-red-800'
                                      : isMidScore
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-emerald-100 text-emerald-800'
                                  )}
                                >
                                  {m.answerScore}/10
                                </span>
                              )}
                            </div>
                            <p
                              className={cn(
                                'text-[13px] font-semibold leading-relaxed',
                                isLowScore
                                  ? 'text-red-900'
                                  : isMidScore
                                  ? 'text-amber-900'
                                  : 'text-emerald-900'
                              )}
                            >
                              {m.feedback}
                            </p>
                          </div>
                        </motion.div>
                      )}

                      {m.roundSummary && (
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="p-5 bg-slate-900 text-white rounded-[24px] border border-slate-700 shadow-md space-y-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-sky-300">
                                5-Question Checkpoint · Round {m.roundSummary.roundNumber}
                              </p>
                              <h4 className="text-base font-display font-bold">
                                Preparation Score Report
                              </h4>
                            </div>
                            <div
                              className={cn(
                                'px-3.5 py-1.5 rounded-2xl text-lg font-extrabold font-display border',
                                m.roundSummary.scoreOutOf10 < 5
                                  ? 'bg-red-500/20 text-red-200 border-red-400/40'
                                  : m.roundSummary.scoreOutOf10 < 7.5
                                  ? 'bg-amber-500/20 text-amber-200 border-amber-400/40'
                                  : 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40'
                              )}
                            >
                              {m.roundSummary.scoreOutOf10} / 10
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                            <div className="p-3 bg-white/5 rounded-xl border border-white/10">
                              <p className="font-bold text-emerald-300 uppercase tracking-wider text-[10px] mb-1">
                                What You Got Right
                              </p>
                              <p className="text-white/90 leading-relaxed">
                                {m.roundSummary.strengths}
                              </p>
                            </div>
                            <div className="p-3 bg-white/5 rounded-xl border border-white/10">
                              <p className="font-bold text-amber-300 uppercase tracking-wider text-[10px] mb-1">
                                Focus For Next Prep
                              </p>
                              <p className="text-white/90 leading-relaxed">
                                {m.roundSummary.improvements}
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )}

                      <div
                        className={cn(
                          'p-5 rounded-[24px] text-[15px] font-medium leading-relaxed shadow-sm border relative group',
                          m.role === 'user'
                            ? 'bg-brand-blue text-white rounded-tr-none border-brand-blue'
                            : 'bg-white text-brand-blue-heading border-brand-border/60 rounded-tl-none'
                        )}
                      >
                        {m.text}
                        {m.role === 'assistant' && (
                          <button
                            type="button"
                            onClick={() => {
                              unlockAudioElement();
                              speakText(spokenBundle);
                            }}
                            title="Play aloud"
                            className="ml-2 inline-flex items-center gap-1 text-brand-blue hover:text-brand-blue-dark transition-colors px-2 py-0.5 rounded-lg bg-brand-blue/5 hover:bg-brand-blue/10 text-xs font-bold"
                          >
                            <Volume2 className="w-3.5 h-3.5 inline" />
                            <span>Listen</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
              {loading && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex gap-4 max-w-[85%]"
                >
                  <div className="w-8 h-8 rounded-full bg-brand-blue flex items-center justify-center shrink-0 shadow-sm">
                    <Loader2 className="w-4 h-4 text-white animate-spin" />
                  </div>
                  <div className="p-4 bg-white border border-brand-border rounded-3xl rounded-tl-none flex gap-1">
                    <span className="w-1.5 h-1.5 bg-brand-muted/30 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-1.5 h-1.5 bg-brand-muted/30 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-1.5 h-1.5 bg-brand-muted/30 rounded-full animate-bounce" />
                  </div>
                </motion.div>
              )}
              {error && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex justify-center my-4"
                >
                  <div className="flex items-start gap-4 p-6 bg-red-50 text-red-700 rounded-[32px] text-xs font-medium border border-red-100 shadow-lg max-w-md">
                    <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <div className="space-y-2">
                      <p className="font-black uppercase tracking-widest text-red-800">Note</p>
                      <p className="whitespace-pre-wrap leading-relaxed">{error}</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Input & Voice Controls */}
          <form onSubmit={handleSend} className="p-6 bg-white border-t border-brand-border space-y-3">
            {autoplayBlockedText && (
              <div className="px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-2xl flex items-center justify-between gap-3 text-xs font-semibold text-brand-blue-heading">
                <span>Browser paused auto-audio playback.</span>
                <button
                  type="button"
                  onClick={() => {
                    unlockAudioElement();
                    speakText(autoplayBlockedText);
                  }}
                  className="px-3 py-1 bg-brand-blue text-white rounded-xl font-bold flex items-center gap-1.5 hover:bg-brand-blue-dark shrink-0"
                >
                  <Volume2 className="w-3.5 h-3.5" /> Play Interviewer Voice
                </button>
              </div>
            )}

            {voiceNotice && (
              <div className="px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-2xl flex flex-wrap items-center justify-between gap-2 text-amber-800 text-xs font-semibold">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>{voiceNotice}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {micMode === 'studio' && hasBrowserStt && (
                    <button
                      type="button"
                      onClick={() => switchMicMode('browser')}
                      className="px-2.5 py-1 bg-amber-600 text-white rounded-lg text-[11px] font-bold hover:bg-amber-700"
                    >
                      Switch to Live Browser Mic
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setVoiceNotice(null)}
                    className="text-[11px] font-bold underline shrink-0"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {isRecording && (
              <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-2xl flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 text-red-600 text-xs font-bold">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping" />
                  <span>
                    {micMode === 'browser'
                      ? `Live speech-to-text active (${formatDuration(recordingSeconds)})...`
                      : audioLevel > 3
                      ? `Voice detected (${formatDuration(recordingSeconds)}) — recording...`
                      : `Mic open (${formatDuration(recordingSeconds)}) — speak clearly...`}
                  </span>
                  {micMode === 'studio' && (
                    <div className="flex items-end gap-0.5 h-4">
                      {[0.25, 0.5, 0.85, 0.6, 0.35].map((scale, idx) => (
                        <span
                          key={idx}
                          className="w-1 rounded-full bg-red-500 transition-all duration-75"
                          style={{
                            height: `${Math.max(20, Math.min(100, audioLevel * scale + 15))}%`
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => stopRecording(true)}
                    className="px-3.5 py-1.5 bg-brand-blue text-white rounded-xl text-[11px] font-bold hover:bg-brand-blue-dark shadow-sm"
                  >
                    Stop & Send Answer
                  </button>
                  <button
                    type="button"
                    onClick={() => stopRecording(false)}
                    className="px-2.5 py-1.5 bg-white border border-red-200 text-red-700 rounded-xl text-[11px] font-bold hover:bg-red-100"
                  >
                    Stop & Edit
                  </button>
                </div>
              </div>
            )}

            {isTranscribing && (
              <div className="px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-2xl flex items-center gap-2 text-brand-blue text-xs font-bold">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Converting your speech to text...</span>
              </div>
            )}

            <div className="relative flex items-center gap-3">
              <button
                type="button"
                onClick={toggleRecording}
                disabled={isTranscribing || loading}
                className={cn(
                  'px-4 h-12 rounded-2xl flex items-center justify-center gap-2 transition-all border shadow-sm shrink-0 text-xs font-bold',
                  isRecording
                    ? 'bg-red-500 text-white border-red-600 animate-pulse shadow-red-200'
                    : micSupported
                    ? 'bg-brand-blue/10 text-brand-blue border-brand-blue/30 hover:bg-brand-blue hover:text-white'
                    : 'bg-slate-100 text-slate-400 border-slate-200'
                )}
              >
                {isRecording ? (
                  <>
                    <MicOff className="w-4 h-4" />
                    <span className="hidden sm:inline">Stop</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4" />
                    <span className="hidden sm:inline">Speak Answer</span>
                  </>
                )}
              </button>

              <input
                type="text"
                value={input}
                onChange={(e) => {
                  const val = e.target.value;
                  latestInputRef.current = val;
                  baseInputRef.current = val;
                  setInput(val);
                }}
                placeholder={
                  isRecording
                    ? 'Recording... click Stop & Send Answer when done'
                    : 'Click "Speak Answer" or type your answer...'
                }
                className="flex-1 bg-brand-cream/50 border border-brand-border rounded-2xl py-3.5 px-5 text-sm font-medium outline-none focus:border-brand-blue focus:bg-white transition-all"
              />

              <button
                type="submit"
                disabled={(!input.trim() && !isRecording) || loading || isTranscribing}
                className="w-12 h-12 bg-brand-blue text-white rounded-2xl flex items-center justify-center hover:bg-brand-blue-dark transition-all disabled:opacity-30 disabled:scale-95 shadow-md shadow-blue-200 shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-wrap justify-between items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-brand-muted px-2">
              <span>
                {micSupported
                  ? 'Click "Speak Answer" to talk, then "Stop & Send Answer"'
                  : 'Type to respond (Voice input unavailable in this browser)'}
              </span>
              {hasMediaRecorderApi && hasBrowserStt ? (
                <button
                  type="button"
                  onClick={() => switchMicMode(micMode === 'studio' ? 'browser' : 'studio')}
                  className="text-brand-blue hover:underline font-bold"
                  title="Switch microphone transcription mode"
                >
                  {micMode === 'studio'
                    ? 'Mic Mode: Studio AI (Switch to Live Browser)'
                    : 'Mic Mode: Live Browser (Switch to Studio AI)'}
                </button>
              ) : (
                <span>
                  {micMode === 'studio' ? 'Auto-Normalized Studio Mic + AI Voice' : 'Live Browser Speech + AI Voice'}
                </span>
              )}
            </div>
          </form>
        </div>
      )}
    </>
  );
}
