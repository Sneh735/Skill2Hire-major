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
import { getInterviewFeedback, transcribeAudio, synthesizeSpeech } from '../services/ai';
import { cn } from '../lib/utils';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  feedback?: string;
}

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
  const [isListening, setIsListening] = useState(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const isListeningRef = useRef(false);
  const shouldKeepListeningRef = useRef(false);
  const useMediaRecorderFallbackRef = useRef(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const sendAfterTranscribeRef = useRef(false);

  const baseInputRef = useRef('');
  const finalTranscriptRef = useRef('');
  const latestInputRef = useRef('');
  const speakTimerRef = useRef<number | null>(null);
  const resumeIntervalRef = useRef<number | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const ttsCacheRef = useRef<Map<string, string>>(new Map());
  const voiceEnabledRef = useRef(voiceEnabled);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

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
    if (resumeIntervalRef.current !== null) {
      window.clearInterval(resumeIntervalRef.current);
      resumeIntervalRef.current = null;
    }
  }, []);

  const stopAllAudioOutput = useCallback(() => {
    clearSpeechTimers();
    if (audioPlayerRef.current) {
      try {
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
  }, [clearSpeechTimers]);

  // Load browser TTS voices reactively
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices();
      if (available.length > 0) {
        setVoices(available);
      }
    };

    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

  const releaseMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  // Setup Web Speech API with automatic MediaRecorder fallback detection
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    const hasMediaRecorder =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== 'undefined';

    if (!SpeechRecognition) {
      if (hasMediaRecorder) {
        useMediaRecorderFallbackRef.current = true;
        setSpeechSupported(true);
      } else {
        setSpeechSupported(false);
      }
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListeningRef.current = true;
      setIsListening(true);
      setVoiceNotice(null);
    };

    recognition.onresult = (event: any) => {
      let sessionFinal = '';
      let sessionInterim = '';

      for (let i = 0; i < event.results.length; i++) {
        const piece = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) {
          sessionFinal += piece + ' ';
        } else {
          sessionInterim += piece;
        }
      }

      finalTranscriptRef.current = sessionFinal;
      const prefix = baseInputRef.current.trim();
      const spoken = (sessionFinal + sessionInterim).trim();
      const combined = [prefix, spoken].filter(Boolean).join(' ');
      latestInputRef.current = combined;
      setInput(combined);
    };

    recognition.onerror = (event: any) => {
      const code = event?.error;
      if (code === 'aborted') {
        isListeningRef.current = false;
        setIsListening(false);
        return;
      }

      if (code === 'network' && hasMediaRecorder) {
        // Switch automatically to MediaRecorder + Gemini transcription
        shouldKeepListeningRef.current = false;
        useMediaRecorderFallbackRef.current = true;
        isListeningRef.current = false;
        setIsListening(false);
        setVoiceNotice('Switched to high-accuracy AI voice recording mode. Tap Mic to record your answer.');
        return;
      }

      if (code === 'no-speech') {
        setVoiceNotice('No speech detected yet. Speak clearly into your microphone or type below.');
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        shouldKeepListeningRef.current = false;
        setVoiceNotice('Microphone permission blocked. Please allow mic access in your browser site settings or type your answer.');
      } else if (code === 'audio-capture') {
        shouldKeepListeningRef.current = false;
        setVoiceNotice('No microphone detected on this device. You can type your answer below.');
      } else {
        setVoiceNotice(`Voice capture paused (${code || 'unknown'}). Tap Mic to record again or type below.`);
      }

      isListeningRef.current = false;
      setIsListening(false);
    };

    recognition.onend = () => {
      isListeningRef.current = false;
      setIsListening(false);
      const finalized = [baseInputRef.current.trim(), finalTranscriptRef.current.trim()]
        .filter(Boolean)
        .join(' ');
      if (finalized) {
        baseInputRef.current = finalized;
        finalTranscriptRef.current = '';
      }

      if (shouldKeepListeningRef.current && !useMediaRecorderFallbackRef.current) {
        try {
          recognition.start();
        } catch {
          shouldKeepListeningRef.current = false;
        }
      }
    };

    recognitionRef.current = recognition;

    return () => {
      shouldKeepListeningRef.current = false;
      clearSpeechTimers();
      releaseMediaStream();
      try {
        recognition.abort();
      } catch {
        // ignore
      }
      stopAllAudioOutput();
    };
  }, [clearSpeechTimers, releaseMediaStream, stopAllAudioOutput]);

  const stopListening = useCallback(() => {
    shouldKeepListeningRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore stop error
      }
      setIsRecordingAudio(false);
    }
    if (recognitionRef.current && isListeningRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore stop error
      }
    }
    isListeningRef.current = false;
    setIsListening(false);
  }, []);

  // Unlock browser audio + speechSynthesis synchronously inside Start button click
  const unlockAudioOutputs = () => {
    if (!voiceEnabledRef.current || typeof window === 'undefined') return;
    try {
      if (!audioPlayerRef.current) {
        audioPlayerRef.current = new Audio();
      }
      // Silent tiny WAV data URI to unlock HTMLAudioElement playback after async calls
      audioPlayerRef.current.src =
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      audioPlayerRef.current.play().catch(() => {});
    } catch {
      // ignore unlock error
    }
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const primer = new SpeechSynthesisUtterance(' ');
        primer.volume = 0;
        window.speechSynthesis.speak(primer);
      }
    } catch {
      // ignore unlock error
    }
  };

  // Fallback browser speech synthesis
  const speakWithBrowserTts = useCallback(
    (cleanText: string) => {
      if (!voiceEnabledRef.current || typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setIsSpeaking(false);
        return;
      }

      clearSpeechTimers();
      window.speechSynthesis.cancel();

      speakTimerRef.current = window.setTimeout(() => {
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        const availableVoices =
          voices.length > 0 ? voices : window.speechSynthesis.getVoices();
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

        utterance.onstart = () => {
          setIsSpeaking(true);
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
        };

        try {
          window.speechSynthesis.speak(utterance);
        } catch {
          clearSpeechTimers();
          setIsSpeaking(false);
        }
      }, 70);
    },
    [voices, clearSpeechTimers]
  );

  // Primary AI Voice Output: Gemini 3.8 TTS with automatic browser SpeechSynthesis fallback
  const speakText = useCallback(
    async (text: string) => {
      if (!voiceEnabledRef.current || typeof window === 'undefined') return;
      const cleanText = text.replace(/[*_#`]/g, '').trim();
      if (!cleanText) return;

      stopAllAudioOutput();
      setIsSpeaking(true);

      try {
        let dataUri = ttsCacheRef.current.get(cleanText);
        if (!dataUri) {
          const res = await synthesizeSpeech(cleanText);
          if (!voiceEnabledRef.current) {
            setIsSpeaking(false);
            return;
          }
          dataUri = `data:${res.mimeType};base64,${res.audioBase64}`;
          ttsCacheRef.current.set(cleanText, dataUri);
        }

        if (!audioPlayerRef.current) {
          audioPlayerRef.current = new Audio();
        }
        const player = audioPlayerRef.current;
        player.src = dataUri;
        player.onended = () => setIsSpeaking(false);
        player.onerror = () => {
          setIsSpeaking(false);
          speakWithBrowserTts(cleanText);
        };
        await player.play();
      } catch {
        if (voiceEnabledRef.current) {
          speakWithBrowserTts(cleanText);
        } else {
          setIsSpeaking(false);
        }
      }
    },
    [stopAllAudioOutput, speakWithBrowserTts]
  );

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Failed to encode recorded audio.'));
      reader.readAsDataURL(blob);
    });
  };

  const startMediaRecorderCapture = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceNotice('Voice recording is not supported in this browser. Please type your answer below.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      sendAfterTranscribeRef.current = false;

      const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const chosenType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = chosenType ? new MediaRecorder(stream, { mimeType: chosenType }) : new MediaRecorder(stream);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          audioChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        setIsRecordingAudio(false);
        setIsListening(false);
        isListeningRef.current = false;
        releaseMediaStream();

        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];

        if (blob.size < 400) {
          setVoiceNotice('Recording was too short. Hold and speak your answer or type below.');
          return;
        }

        setIsTranscribing(true);
        try {
          const base64 = await blobToBase64(blob);
          const transcript = await transcribeAudio(base64, mimeType);
          if (transcript) {
            const combined = [baseInputRef.current.trim(), transcript.trim()]
              .filter(Boolean)
              .join(' ');
            baseInputRef.current = combined;
            latestInputRef.current = combined;
            setInput(combined);
            if (sendAfterTranscribeRef.current) {
              sendAfterTranscribeRef.current = false;
              await handleSend(undefined, combined);
            }
          } else {
            setVoiceNotice('Could not catch words clearly. Please speak closer to the mic or type below.');
          }
        } catch (err: any) {
          setVoiceNotice(err?.message || 'Voice transcription failed. Please type your answer.');
        } finally {
          sendAfterTranscribeRef.current = false;
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      isListeningRef.current = true;
      setIsRecordingAudio(true);
      setIsListening(true);
      setVoiceNotice(null);
    } catch (err: any) {
      releaseMediaStream();
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setVoiceNotice('Microphone permission was denied. Allow mic access in your browser settings or type your answer.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setVoiceNotice('No microphone device found. Connect a microphone or type your answer below.');
      } else {
        setVoiceNotice('Could not access microphone. You can type your answer below.');
      }
    }
  };

  const toggleListening = async () => {
    if (!speechSupported) {
      setVoiceNotice('Voice input is unavailable in this browser. Please type your answer below.');
      return;
    }

    if (isListeningRef.current || isRecordingAudio) {
      stopListening();
      return;
    }

    // Stop AI speech before listening
    stopAllAudioOutput();
    setVoiceNotice(null);

    baseInputRef.current = latestInputRef.current.trim();
    finalTranscriptRef.current = '';

    if (useMediaRecorderFallbackRef.current || !recognitionRef.current) {
      await startMediaRecorderCapture();
      return;
    }

    // Ensure mic permission is granted before starting Web Speech
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch (permErr: any) {
        const name = permErr?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setVoiceNotice('Microphone permission was denied. Please allow mic access in your browser or type your answer.');
          return;
        }
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          setVoiceNotice('No microphone detected. Connect a microphone or type your answer.');
          return;
        }
      }
    }

    shouldKeepListeningRef.current = true;
    try {
      recognitionRef.current.start();
    } catch (err: any) {
      if (err?.name === 'InvalidStateError') {
        try {
          recognitionRef.current.stop();
          window.setTimeout(() => {
            try {
              recognitionRef.current?.start();
            } catch {
              shouldKeepListeningRef.current = false;
              startMediaRecorderCapture();
            }
          }, 150);
        } catch {
          shouldKeepListeningRef.current = false;
        }
      } else {
        shouldKeepListeningRef.current = false;
        await startMediaRecorderCapture();
      }
    }
  };

  const getFallbackQuestion = (currentTopic: string, index: number) => {
    const key =
      Object.keys(FALLBACK_QUESTIONS).find((k) =>
        currentTopic.toLowerCase().includes(k)
      ) || 'default';
    const list = FALLBACK_QUESTIONS[key];
    return list[index % list.length];
  };

  const activeTopic = (customTopic.trim() || topic).trim();

  const handleStart = async () => {
    if (!activeTopic) return;
    unlockAudioOutputs();
    setTopic(activeTopic);
    setStarted(true);
    setLoading(true);
    setError(null);
    setVoiceNotice(null);

    try {
      let question = '';
      try {
        const response = await getInterviewFeedback(activeTopic, []);
        question = response.question;
      } catch (apiErr: any) {
        console.warn('Using fallback question due to API error:', apiErr);
        question = getFallbackQuestion(activeTopic, 0);
        setVoiceNotice('AI server was busy, so a curated starter question was loaded.');
      }

      setMessages([{ role: 'assistant', text: question }]);
      speakText(question);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to start mock interview. Please try again.');
      setStarted(false);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();

    if (isRecordingAudio) {
      sendAfterTranscribeRef.current = true;
      stopListening();
      return;
    }

    const answerText = (overrideText ?? latestInputRef.current).trim();
    if (!answerText || loading) return;

    stopListening();
    baseInputRef.current = '';
    finalTranscriptRef.current = '';
    latestInputRef.current = '';
    setInput('');

    const userMsg: ChatMessage = { role: 'user', text: answerText };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);
    setError(null);

    try {
      let nextQuestion = '';
      let feedback = '';

      try {
        const history = newMessages.map((m) => ({ role: m.role, text: m.text }));
        const response = await getInterviewFeedback(activeTopic, history);
        nextQuestion = response.question;
        feedback =
          response.feedback ||
          'Good technical explanation! Try adding concrete metrics or architectural trade-offs when possible.';
      } catch (apiErr: any) {
        console.warn('Using fallback question due to API error:', apiErr);
        feedback =
          'Solid response! Keep structuring your answers around problem, trade-offs, and real-world impact.';
        nextQuestion = getFallbackQuestion(activeTopic, newMessages.length);
      }

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: nextQuestion, feedback }
      ]);
      speakText(nextQuestion);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to get response from AI. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    stopAllAudioOutput();
    stopListening();
    releaseMediaStream();
    baseInputRef.current = '';
    finalTranscriptRef.current = '';
    latestInputRef.current = '';
    setInput('');
    setVoiceNotice(null);
    setError(null);
    setMessages([]);
    setStarted(false);
  };

  const filteredTopics = TOPICS.filter((t) =>
    t.toLowerCase().includes(customTopic.toLowerCase())
  );

  if (!started) {
    return (
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
    );
  }

  return (
    <div className="flex flex-col h-[750px] bg-white rounded-[32px] border border-brand-border/40 overflow-hidden shadow-[0_10px_40px_-10px_rgba(0,0,0,0.05)]">
      {/* Header */}
      <div className="p-6 bg-brand-blue-heading text-white flex justify-between items-center relative overflow-hidden">
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
            <div className="flex items-center gap-2">
              <h3 className="font-display font-bold text-[18px] leading-tight">
                AI Interviewer Protocol
              </h3>
              {isSpeaking && (
                <span className="text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Volume2 className="w-3 h-3 animate-pulse" /> Speaking
                </span>
              )}
            </div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-brand-blue-heading/70 mt-0.5 bg-white/90 px-2 py-0.5 rounded inline-block">
              Domain: {activeTopic}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 relative z-10">
          <button
            type="button"
            onClick={() => {
              const next = !voiceEnabled;
              setVoiceEnabled(next);
              voiceEnabledRef.current = next;
              if (!next) {
                stopAllAudioOutput();
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
          {messages.map((m, i) => (
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
                      onClick={() => speakText(m.text)}
                      title="Read question aloud"
                      className="ml-2 inline-flex items-center text-brand-muted hover:text-brand-blue transition-colors p-1"
                    >
                      <Volume2 className="w-3.5 h-3.5 inline" />
                    </button>
                  )}
                </div>
                {m.feedback && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-start gap-3"
                  >
                    <Sparkles className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <p className="text-[13px] font-bold text-emerald-800 italic leading-relaxed">
                      {m.feedback}
                    </p>
                  </motion.div>
                )}
              </div>
            </motion.div>
          ))}
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
      <form onSubmit={(e) => handleSend(e)} className="p-6 bg-white border-t border-brand-border">
        {voiceNotice && (
          <div className="mb-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-2xl flex items-center justify-between gap-2 text-amber-800 text-xs font-semibold">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>{voiceNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setVoiceNotice(null)}
              className="text-[11px] font-bold underline shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {(isListening || isRecordingAudio) && (
          <div className="mb-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-2xl flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-red-600 text-xs font-bold">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping" />
              {isRecordingAudio
                ? 'Recording voice answer... Speak clearly, then click Stop & Send or Stop Mic.'
                : 'Listening continuously... Speak your full answer, then click Stop or Send.'}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(input.trim() || isRecordingAudio) && (
                <button
                  type="button"
                  onClick={() => handleSend(undefined, latestInputRef.current)}
                  className="px-3 py-1 bg-brand-blue text-white rounded-xl text-[11px] font-bold hover:bg-brand-blue-dark"
                >
                  Stop & Send
                </button>
              )}
              <button
                type="button"
                onClick={stopListening}
                className="text-[11px] font-bold text-red-700 underline"
              >
                Stop Mic
              </button>
            </div>
          </div>
        )}

        {isTranscribing && (
          <div className="mb-3 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-2xl flex items-center gap-2 text-brand-blue text-xs font-bold">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Transcribing your voice answer...</span>
          </div>
        )}

        <div className="relative flex items-center gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              latestInputRef.current = val;
              baseInputRef.current = val;
              finalTranscriptRef.current = '';
              setInput(val);
            }}
            placeholder={
              isListening || isRecordingAudio
                ? 'Recording voice... speak now or type here'
                : 'Type or tap Mic to speak your answer...'
            }
            className="flex-1 bg-brand-cream/50 border border-brand-border rounded-2xl py-4 pl-6 pr-4 text-sm font-medium outline-none focus:border-brand-blue focus:bg-white transition-all"
          />

          {/* Voice Microphone Toggle */}
          <button
            type="button"
            onClick={toggleListening}
            disabled={isTranscribing}
            title={
              !speechSupported
                ? 'Voice recording not supported in this browser'
                : isListening || isRecordingAudio
                ? 'Stop Listening'
                : 'Speak Answer via Mic'
            }
            className={cn(
              'w-12 h-12 rounded-2xl flex items-center justify-center transition-all border shadow-sm shrink-0',
              isListening || isRecordingAudio
                ? 'bg-red-500 text-white border-red-600 animate-pulse shadow-red-200'
                : speechSupported
                ? 'bg-white text-brand-blue border-brand-border hover:bg-brand-blue/5 hover:border-brand-blue'
                : 'bg-slate-100 text-slate-400 border-slate-200'
            )}
          >
            {isListening || isRecordingAudio ? (
              <MicOff className="w-5 h-5" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>

          {/* Send Button */}
          <button
            type="submit"
            disabled={(!input.trim() && !isRecordingAudio) || loading || isTranscribing}
            className="w-12 h-12 bg-brand-blue text-white rounded-2xl flex items-center justify-center hover:bg-brand-blue-dark transition-all disabled:opacity-30 disabled:scale-95 shadow-md shadow-blue-200 shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <div className="flex justify-between items-center mt-3 text-[10px] font-bold uppercase tracking-widest text-brand-muted px-2">
          <span>
            {speechSupported
              ? 'Click Mic to speak or type to respond'
              : 'Type to respond (Voice input unavailable in this browser)'}
          </span>
          <span>AI Voice Synthesis + Speech Capture</span>
        </div>
      </form>
    </div>
  );
}
