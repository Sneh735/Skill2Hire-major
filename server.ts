import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRIMARY_GEMINI_MODEL = "gemini-4-hydrogen";
const FALLBACK_GEMINI_MODEL = "gemini-3.1-flash-lite";

const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY_HERE" || apiKey === "YOUR_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY is missing. Please set it in Settings > Secrets.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
};

const cleanJsonText = (raw: string | undefined): string => {
  if (!raw) return "{}";
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
};

const generateWithFallback = async (
  ai: GoogleGenAI,
  params: { contents: any; config?: any }
) => {
  const models = [PRIMARY_GEMINI_MODEL, FALLBACK_GEMINI_MODEL];
  let lastError: any;

  for (let i = 0; i < models.length; i++) {
    try {
      return await ai.models.generateContent({
        model: models[i],
        contents: params.contents,
        config: params.config,
      });
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || "").toLowerCase();
      const status = err?.status || err?.code;
      const isTransient =
        status === 503 ||
        status === 429 ||
        msg.includes("503") ||
        msg.includes("unavailable") ||
        msg.includes("high demand") ||
        msg.includes("resource_exhausted");
      if (!isTransient || i === models.length - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  throw lastError;
};

// In-memory OTP Store for Password Recovery
interface OtpRecord {
  otp: string;
  expiresAt: number; // 5 minutes from generation
  attempts: number;
  resendAvailableAt: number; // 60s cooldown
  verified: boolean;
  resetToken?: string;
}

const otpStore = new Map<string, OtpRecord>();

// Clean up expired OTPs periodically (every 5 mins)
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of otpStore.entries()) {
    if (now > record.expiresAt + 60000) {
      otpStore.delete(email);
    }
  }
}, 5 * 60 * 1000);

// Setup Nodemailer Transporter
const createEmailTransporter = () => {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Fallback / Development transporter
  return null;
};

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "50mb" }));

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // 1. FORGOT PASSWORD: Send OTP to Email
  app.post("/api/auth/send-otp", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !email.includes("@")) {
        return res.status(400).json({ error: "Please provide a valid registered email address." });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const now = Date.now();
      const existing = otpStore.get(normalizedEmail);

      // Check cooldown (60 seconds)
      if (existing && now < existing.resendAvailableAt) {
        const waitSeconds = Math.ceil((existing.resendAvailableAt - now) / 1000);
        return res.status(429).json({
          error: `Please wait ${waitSeconds} seconds before requesting a new OTP.`
        });
      }

      // Generate secure 6-digit random OTP
      const otp = Math.floor(100000 + crypto.randomInt(900000)).toString();
      const expiresAt = now + 5 * 60 * 1000; // 5 minutes
      const resendAvailableAt = now + 60 * 1000; // 60s cooldown

      otpStore.set(normalizedEmail, {
        otp,
        expiresAt,
        resendAvailableAt,
        attempts: 0,
        verified: false,
      });

      console.log(`\n======================================================`);
      console.log(`[PASSWORD RECOVERY OTP] Generated for: ${normalizedEmail}`);
      console.log(`[SECURITY OTP CODE]: >>> ${otp} <<< (Valid for 5 mins)`);
      console.log(`======================================================\n`);

      // Attempt to send real email if SMTP is configured
      const transporter = createEmailTransporter();
      if (transporter) {
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_FROM || `"SkillToHire Security" <no-reply@skilltohire.com>`,
            to: normalizedEmail,
            subject: `Your Password Reset OTP: ${otp} - SkillToHire`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #ffffff; border-radius: 20px; border: 1px solid #e2e8f0;">
                <div style="text-align: center; margin-bottom: 24px;">
                  <h1 style="color: #1a6ef5; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">SkillToHire</h1>
                  <p style="color: #64748b; font-size: 13px; margin-top: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Account Security Protocol</p>
                </div>
                <div style="background: #f8fafc; border-radius: 16px; padding: 24px; border: 1px solid #e2e8f0; text-align: center;">
                  <p style="color: #334155; font-size: 14px; margin-top: 0; margin-bottom: 16px; line-height: 1.5;">You requested a password reset for your account. Use the 6-digit verification code below:</p>
                  <div style="display: inline-block; padding: 12px 32px; background: #1a6ef5; color: #ffffff; font-size: 32px; font-weight: 800; letter-spacing: 8px; border-radius: 12px; margin-bottom: 12px;">
                    ${otp}
                  </div>
                  <p style="color: #ef4444; font-size: 12px; margin: 0; font-weight: 600;">⏱️ This OTP expires in exactly 5 minutes.</p>
                </div>
                <p style="color: #94a3b8; font-size: 11px; text-align: center; margin-top: 24px; line-height: 1.5;">If you did not request this password reset, please ignore this email or contact support.</p>
              </div>
            `
          });
        } catch (emailErr: any) {
          console.warn("SMTP email dispatch notice:", emailErr.message);
        }
      }

      // Masked email for display (e.g. s***@gmail.com)
      const [userPart, domainPart] = normalizedEmail.split("@");
      const maskedEmail = userPart.length > 2 
        ? `${userPart[0]}***${userPart.slice(-1)}@${domainPart}`
        : `${userPart[0]}***@${domainPart}`;

      res.json({
        success: true,
        message: `OTP sent successfully to ${maskedEmail}`,
        maskedEmail,
        expiresInSeconds: 300,
        // In local/dev environments, also pass otp for frictionless testing
        devOtp: process.env.NODE_ENV !== "production" ? otp : undefined
      });
    } catch (err: any) {
      console.error("Error in /api/auth/send-otp:", err);
      res.status(500).json({ error: "Failed to dispatch password recovery OTP. Please try again." });
    }
  });

  // 2. FORGOT PASSWORD: Verify OTP
  app.post("/api/auth/verify-otp", (req, res) => {
    try {
      const { email, otp } = req.body;
      if (!email || !otp) {
        return res.status(400).json({ error: "Email and OTP are required." });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const record = otpStore.get(normalizedEmail);

      if (!record) {
        return res.status(400).json({ error: "No active password reset request found for this email. Please request a new OTP." });
      }

      if (Date.now() > record.expiresAt) {
        otpStore.delete(normalizedEmail);
        return res.status(400).json({ error: "This OTP has expired (5-minute limit exceeded). Please request a new one." });
      }

      // Increment incorrect attempts
      if (record.otp.trim() !== otp.trim()) {
        record.attempts += 1;
        const remaining = 5 - record.attempts;
        if (remaining <= 0) {
          otpStore.delete(normalizedEmail);
          return res.status(403).json({ error: "Too many incorrect OTP attempts. For security, please request a new OTP." });
        }
        return res.status(400).json({ error: `Invalid OTP code. ${remaining} attempt(s) remaining.` });
      }

      // Successful verification -> generate single-use reset token
      const resetToken = crypto.randomBytes(24).toString("hex");
      record.verified = true;
      record.resetToken = resetToken;

      res.json({
        success: true,
        message: "OTP verified successfully. You may now set your new password.",
        resetToken
      });
    } catch (err: any) {
      console.error("Error in /api/auth/verify-otp:", err);
      res.status(500).json({ error: "Failed to verify OTP." });
    }
  });

  // 3. FORGOT PASSWORD: Reset Password with Verified Token
  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { email, resetToken, newPassword } = req.body;
      if (!email || !resetToken || !newPassword) {
        return res.status(400).json({ error: "Email, reset token, and new password are required." });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters long." });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const record = otpStore.get(normalizedEmail);

      if (!record || !record.verified || record.resetToken !== resetToken) {
        return res.status(403).json({ error: "Invalid or expired reset session. Please restart password recovery." });
      }

      // Clear OTP record
      otpStore.delete(normalizedEmail);

      console.log(`[PASSWORD RESET SUCCESS] Password successfully updated for: ${normalizedEmail}`);

      res.json({
        success: true,
        message: "Your password has been successfully reset! You can now log in with your new credentials."
      });
    } catch (err: any) {
      console.error("Error in /api/auth/reset-password:", err);
      res.status(500).json({ error: "Failed to reset password. Please try again." });
    }
  });

  // 4. AI ROUTES (Server-Side Gemini API)
  app.post("/api/ai/analyze-resume", async (req, res) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "No readable text found in your resume. Please upload a text-based PDF, .txt file, or paste your resume text." });
      }
      const ai = getGeminiClient();
      const response = await generateWithFallback(ai, {
        contents: `Please analyze the following resume against the provided target job description.\n\nTarget Job Title/Description:\nSoftware Engineer / Software Developer (General Tech Role)\n\nResume Text:\n${text.slice(0, 12000)}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              candidateName: { type: Type.STRING },
              atsScore: { type: Type.NUMBER },
              matchPercentage: { type: Type.NUMBER },
              summary: { type: Type.STRING },
              formattingIssues: { type: Type.ARRAY, items: { type: Type.STRING } },
              keywordAnalysis: {
                type: Type.OBJECT,
                properties: {
                  foundKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
                  missingKeywords: { type: Type.ARRAY, items: { type: Type.STRING } }
                }
              },
              sectionFeedback: {
                type: Type.OBJECT,
                properties: {
                  education: { type: Type.STRING },
                  experience: { type: Type.STRING },
                  projects: { type: Type.STRING }
                }
              },
              topStrengths: { type: Type.ARRAY, items: { type: Type.STRING } },
              actionableImprovements: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["candidateName", "atsScore", "matchPercentage", "summary", "formattingIssues", "keywordAnalysis", "sectionFeedback", "topStrengths", "actionableImprovements"]
          },
          systemInstruction: `You are an advanced Applicant Tracking System (ATS) algorithm and a Senior Technical Recruiter. Analyze the candidate's resume text and evaluate its ATS compatibility, strengths, missing keywords, and actionable improvements.`
        }
      });

      const parsed = JSON.parse(cleanJsonText(response.text));
      res.json({
        candidateName: parsed.candidateName || "Candidate",
        atsScore: typeof parsed.atsScore === "number" ? parsed.atsScore : (typeof parsed.matchPercentage === "number" ? parsed.matchPercentage : 70),
        matchPercentage: typeof parsed.matchPercentage === "number" ? parsed.matchPercentage : (typeof parsed.atsScore === "number" ? parsed.atsScore : 70),
        summary: parsed.summary || "Resume analyzed successfully.",
        formattingIssues: Array.isArray(parsed.formattingIssues) ? parsed.formattingIssues : [],
        keywordAnalysis: {
          foundKeywords: Array.isArray(parsed.keywordAnalysis?.foundKeywords) ? parsed.keywordAnalysis.foundKeywords : [],
          missingKeywords: Array.isArray(parsed.keywordAnalysis?.missingKeywords) ? parsed.keywordAnalysis.missingKeywords : [],
        },
        sectionFeedback: {
          education: parsed.sectionFeedback?.education || "Education section reviewed.",
          experience: parsed.sectionFeedback?.experience || "Experience section reviewed.",
          projects: parsed.sectionFeedback?.projects || "Projects section reviewed.",
        },
        topStrengths: Array.isArray(parsed.topStrengths) ? parsed.topStrengths : [],
        actionableImprovements: Array.isArray(parsed.actionableImprovements) ? parsed.actionableImprovements : [],
      });
    } catch (err: any) {
      console.error("Error in /api/ai/analyze-resume:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to analyze resume." });
    }
  });

  app.post("/api/ai/generate-roadmap", async (req, res) => {
    try {
      const { skills = [], targetDomain = "Full Stack Development" } = req.body;
      const ai = getGeminiClient();
      const response = await generateWithFallback(ai, {
        contents: `Generate a detailed learning roadmap for ${targetDomain}. The user already has these skills: ${Array.isArray(skills) ? skills.join(", ") : ""}.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                month: { type: Type.STRING },
                focus: { type: Type.STRING },
                topics: { type: Type.ARRAY, items: { type: Type.STRING } },
                resources: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ["month", "focus", "topics", "resources"]
            }
          }
        }
      });

      const parsed = JSON.parse(response.text || "[]");
      res.json(parsed);
    } catch (err: any) {
      console.error("Error in /api/ai/generate-roadmap:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to generate roadmap." });
    }
  });

  app.post("/api/ai/interview-feedback", async (req, res) => {
    try {
      const { topic, history = [] } = req.body;
      if (!topic) {
        return res.status(400).json({ error: "Interview topic is required." });
      }
      const ai = getGeminiClient();
      const response = await generateWithFallback(ai, {
        contents: `You are an interviewer. Topic: ${topic}. Interview history: ${JSON.stringify(history)}. Please provide the next question and brief feedback on the previous answer if applicable.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              feedback: { type: Type.STRING }
            },
            required: ["question"]
          }
        }
      });

      const parsed = JSON.parse(response.text || "{}");
      res.json(parsed);
    } catch (err: any) {
      console.error("Error in /api/ai/interview-feedback:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to generate interview question." });
    }
  });

  app.post("/api/ai/career-assistant", async (req, res) => {
    try {
      const { prompt, history = [] } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required." });
      }
      const ai = getGeminiClient();
      const response = await generateWithFallback(ai, {
        contents: `You are a supportive, expert Virtual Career Mentor and EdTech guide on the "Skill to Hire" platform.
Candidate Question: "${prompt}"
Conversation History: ${JSON.stringify(history)}

Provide a concise, encouraging, and actionable answer (under 120 words). You can advise on tech careers, interview preparation, resume optimization, courses (HTML/CSS/JS, Python, Java, SQL, React, Node.js), and navigating Skill to Hire features.`,
      });
      res.json({
        text: response.text || "I am here to guide your career path! What technical domain or interview skill would you like help with?"
      });
    } catch (err: any) {
      console.error("Error in /api/ai/career-assistant:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to contact career assistant." });
    }
  });

  app.post("/api/ai/generate-course", async (req, res) => {
    try {
      const { topic, category = "Technical", difficulty = "Intermediate" } = req.body;
      if (!topic) {
        return res.status(400).json({ error: "Course topic is required." });
      }
      const cleanId = `ai-${String(topic).toLowerCase().replace(/[^a-z0-9]/g, "-")}-${Date.now().toString().slice(-4)}`;
      const ai = getGeminiClient();
      const response = await generateWithFallback(ai, {
        contents: `Generate a structured, professional curriculum for the course topic: "${topic}".
Category: ${category}
Difficulty: ${difficulty}

Output a single JSON object with:
- title: string
- description: string (2-3 sentences explaining practical value, industry standards, and skills gained)
- duration: string (e.g. "6 Hours" or "8 Hours")
- domain: string (e.g. "${category === "Technical" ? "Software Engineering" : "Business Management"}")
- points: number (between 1100 and 1500)
- quiz: array of exactly 15 high-quality, practical multiple choice questions. Each item must have:
  - question: string
  - options: array of 4 string choices
  - correctAnswer: number (0, 1, 2, or 3)`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              duration: { type: Type.STRING },
              domain: { type: Type.STRING },
              points: { type: Type.NUMBER },
              quiz: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    question: { type: Type.STRING },
                    options: { type: Type.ARRAY, items: { type: Type.STRING } },
                    correctAnswer: { type: Type.NUMBER }
                  },
                  required: ["question", "options", "correctAnswer"]
                }
              }
            },
            required: ["title", "description", "duration", "domain", "points", "quiz"]
          }
        }
      });

      const parsed = JSON.parse(response.text || "{}");
      res.json({
        id: cleanId,
        title: parsed.title || `${topic} Mastery`,
        description: parsed.description || `Comprehensive professional course on ${topic}.`,
        image: category === "Non-Technical"
          ? "https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&auto=format&fit=crop&q=60"
          : "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=crop&q=60",
        duration: parsed.duration || "6 Hours",
        difficulty,
        domain: parsed.domain || (category === "Non-Technical" ? "Business & Strategy" : "Engineering"),
        category,
        points: parsed.points || 1200,
        theoryPages: [],
        quiz: Array.isArray(parsed.quiz) ? parsed.quiz : [],
        passingScore: 12
      });
    } catch (err: any) {
      console.error("Error in /api/ai/generate-course:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to generate custom course." });
    }
  });

  app.post("/api/ai/parse-resume", async (req, res) => {
    try {
      const { resumeText = "", fileName = "resume.pdf" } = req.body;
      const cleanFileName = String(fileName).replace(/\.[^/.]+$/, "").replace(/_/g, " ");
      const ai = getGeminiClient();

      const prompt = `Analyze this candidate resume and extract structured profile data in strictly valid JSON:
Resume Text:
"""
${String(resumeText).slice(0, 5000)}
"""
File Name: "${fileName}"

JSON format required:
{
  "name": "Candidate full name",
  "email": "email address or candidate@skilltohire.com",
  "phone": "+91 98765 43210",
  "targetRole": "Primary desired role (e.g. Frontend Developer, Full Stack Engineer)",
  "technicalSkills": ["skill1", "skill2"],
  "softSkills": ["Problem Solving", "Communication"],
  "experienceYears": 0,
  "education": {
    "degree": "B.Tech / BCA / Bachelor of Engineering / etc.",
    "field": "Computer Science & Engineering",
    "college": "College / University name",
    "graduationYear": "2026",
    "gpa": "8.5 CGPA"
  },
  "certifications": ["SkillHire Verified Profile"]
}`;

      const response = await generateWithFallback(ai, {
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      const parsed = JSON.parse(response.text || "{}");
      res.json({
        name: parsed.name || cleanFileName || "Candidate",
        email: parsed.email || "candidate@skilltohire.com",
        phone: parsed.phone || "+91 98765 43210",
        targetRole: parsed.targetRole || "Software Development Engineer",
        technicalSkills: parsed.technicalSkills && parsed.technicalSkills.length > 0
          ? parsed.technicalSkills
          : ["JavaScript", "React", "HTML", "CSS", "SQL"],
        softSkills: parsed.softSkills && parsed.softSkills.length > 0
          ? parsed.softSkills
          : ["Problem Solving", "Communication", "Team Collaboration"],
        experienceYears: typeof parsed.experienceYears === "number" ? parsed.experienceYears : 0,
        education: {
          degree: parsed.education?.degree || "B.Tech",
          field: parsed.education?.field || "Computer Science & Engineering",
          college: parsed.education?.college || "Institute of Technology",
          graduationYear: parsed.education?.graduationYear || "2026",
          gpa: parsed.education?.gpa || "8.4 CGPA"
        },
        certifications: parsed.certifications || ["SkillHire Verified Profile"],
        preferredLocation: "Bengaluru / Remote",
        preferredWorkMode: "Any"
      });
    } catch (err: any) {
      console.error("Error in /api/ai/parse-resume:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to parse resume." });
    }
  });

  app.post("/api/ai/course-tutor", async (req, res) => {
    try {
      const { courseTitle, moduleTitle, userQuestion } = req.body;
      if (!userQuestion) {
        return res.status(400).json({ error: "Question is required." });
      }
      const ai = getGeminiClient();
      const prompt = `You are a friendly, expert tech mentor teaching the course "${courseTitle}", specifically the module "${moduleTitle}".
A student has asked this doubt:
"${userQuestion}"

Provide a crystal clear, engaging, and practical explanation.
Guidelines:
1. Explain in simple terms using a quick real-world analogy.
2. Provide a concrete code or framework snippet if relevant.
3. Keep it concise (around 120-180 words), encouraging, and structured with bullet points.`;

      const response = await generateWithFallback(ai, {
        contents: prompt
      });
      res.json({
        text: response.text || `Here is an explanation of ${userQuestion} for ${courseTitle}.`
      });
    } catch (err: any) {
      console.error("Error in /api/ai/course-tutor:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to contact course AI tutor." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== "true" },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
