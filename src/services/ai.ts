import { Course, CandidateProfile } from "../types";

export interface ResumeAnalysis {
  candidateName: string;
  atsScore: number;
  matchPercentage: number;
  summary: string;
  formattingIssues: string[];
  keywordAnalysis: {
    foundKeywords: string[];
    missingKeywords: string[];
  };
  sectionFeedback: {
    education: string;
    experience: string;
    projects: string;
  };
  topStrengths: string[];
  actionableImprovements: string[];
}

export interface RoadmapStep {
  month: string;
  focus: string;
  topics: string[];
  resources: string[];
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 25000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Request failed with status ${response.status}`);
    }
    return data as T;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("AI request timed out. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const analyzeResume = async (text: string): Promise<ResumeAnalysis> => {
  return postJson<ResumeAnalysis>("/api/ai/analyze-resume", { text });
};

export const generateRoadmap = async (skills: string[], targetDomain: string): Promise<RoadmapStep[]> => {
  return postJson<RoadmapStep[]>("/api/ai/generate-roadmap", { skills, targetDomain });
};

export interface InterviewRoundSummary {
  roundNumber: number;
  scoreOutOf10: number;
  strengths: string;
  improvements: string;
  spokenSummary: string;
}

export interface InterviewFeedbackResponse {
  question: string;
  feedback?: string;
  answerScore?: number;
  roundSummary?: InterviewRoundSummary;
}

export const getInterviewFeedback = async (
  topic: string,
  history: { role: string; text: string }[],
  answeredCount?: number,
  recentScores?: number[]
): Promise<InterviewFeedbackResponse> => {
  return postJson<InterviewFeedbackResponse>("/api/ai/interview-feedback", {
    topic,
    history,
    answeredCount,
    recentScores,
  });
};

export const askCareerAssistant = async (
  prompt: string,
  history: { role: string; text: string }[] = []
): Promise<string> => {
  const res = await postJson<{ text: string }>("/api/ai/career-assistant", { prompt, history });
  return res.text;
};

export const generateCustomCourse = async (
  topic: string,
  category: "Technical" | "Non-Technical" = "Technical",
  difficulty: "Beginner" | "Intermediate" | "Advanced" = "Intermediate"
): Promise<Course> => {
  return postJson<Course>("/api/ai/generate-course", { topic, category, difficulty });
};

export const parseResumeWithAI = async (
  resumeText: string,
  fileName: string
): Promise<CandidateProfile> => {
  return postJson<CandidateProfile>("/api/ai/parse-resume", { resumeText, fileName });
};

export const askCourseAiTutor = async (
  courseTitle: string,
  moduleTitle: string,
  userQuestion: string,
  moduleSummary?: string,
  history: { role: 'user' | 'assistant'; text: string }[] = []
): Promise<string> => {
  const res = await postJson<{ text: string }>("/api/ai/course-tutor", {
    courseTitle,
    moduleTitle,
    userQuestion,
    moduleSummary,
    history,
  });
  return res.text;
};

export const transcribeAudio = async (
  audioBase64: string,
  mimeType = "audio/webm"
): Promise<string> => {
  const res = await postJson<{ text: string }>("/api/ai/transcribe-audio", {
    audioBase64,
    mimeType,
  });
  return res.text;
};

export const synthesizeSpeech = async (
  text: string,
  voiceName = "Zephyr"
): Promise<{ audioBase64: string; mimeType: string }> => {
  return postJson<{ audioBase64: string; mimeType: string }>(
    "/api/ai/tts",
    { text, voiceName },
    15000
  );
};
