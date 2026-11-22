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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }
  return data as T;
}

export const analyzeResume = async (text: string): Promise<ResumeAnalysis> => {
  return postJson<ResumeAnalysis>("/api/ai/analyze-resume", { text });
};

export const generateRoadmap = async (skills: string[], targetDomain: string): Promise<RoadmapStep[]> => {
  return postJson<RoadmapStep[]>("/api/ai/generate-roadmap", { skills, targetDomain });
};

export const getInterviewFeedback = async (
  topic: string,
  history: { role: string; text: string }[]
): Promise<{ question: string; feedback?: string }> => {
  return postJson<{ question: string; feedback?: string }>("/api/ai/interview-feedback", {
    topic,
    history,
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
  userQuestion: string
): Promise<string> => {
  const res = await postJson<{ text: string }>("/api/ai/course-tutor", {
    courseTitle,
    moduleTitle,
    userQuestion,
  });
  return res.text;
};
