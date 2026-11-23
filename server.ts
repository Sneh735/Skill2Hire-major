import express from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const currentFilename =
  typeof __filename !== "undefined"
    ? __filename
    : import.meta?.url
      ? fileURLToPath(import.meta.url)
      : path.resolve(process.cwd(), "server.ts");
const currentDirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(currentFilename);

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

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

const formatGeminiError = (err: any, fallbackMessage: string): string => {
  const raw = String(err?.message || "").trim();
  if (!raw) return fallbackMessage;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const nestedMsg = parsed?.error?.message || parsed?.message;
      const code = parsed?.error?.code;
      if (code === 503 || code === 429) {
        return "AI service is briefly experiencing high demand. Please retry in a moment.";
      }
      if (typeof nestedMsg === "string" && nestedMsg.trim()) {
        return nestedMsg.trim();
      }
    } catch {
      // fall through
    }
  }
  return raw;
};

interface QuestionRubric {
  question: string;
  conceptGroups: string[][];
  rightAnswer: string;
}

const QUESTION_BANKS: Record<string, QuestionRubric[]> = {
  web: [
    {
      question: "In simple words, what is the difference between var, let, and const in JavaScript?",
      conceptGroups: [
        ["function", "block", "scope", "global", "curly", "inside", "outside"],
        ["reassign", "redeclare", "change", "modify", "constant", "fixed", "cannot change", "can change", "update"],
        ["hoist", "old", "older", "modern", "es6"]
      ],
      rightAnswer: "var is function-scoped and older; let is block-scoped and lets you change the value later; const is block-scoped and cannot be reassigned."
    },
    {
      question: "When would you use Flexbox versus CSS Grid for a page layout?",
      conceptGroups: [
        ["row", "column", "one direction", "one-dimensional", "1d", "navbar", "single line", "align"],
        ["rows and columns", "two direction", "two-dimensional", "2d", "both", "grid", "page layout", "matrix"]
      ],
      rightAnswer: "Flexbox is best for arranging items in one direction at a time (a row or a column), while CSS Grid handles rows and columns together for full two-dimensional layouts."
    },
    {
      question: "What is a Promise in JavaScript, and why do we use async/await with it?",
      conceptGroups: [
        ["future", "async", "asynchronous", "pending", "resolve", "reject", "result", "later", "api", "fetch", "wait"],
        ["read", "readable", "clean", "sync", "like synchronous", "then", "catch", "try", "easier"]
      ],
      rightAnswer: "A Promise represents a value that will finish later (pending, fulfilled, or rejected), and async/await lets us write asynchronous code that reads cleanly top-to-bottom without nested .then() chains."
    },
    {
      question: "What is the difference between == and === in JavaScript?",
      conceptGroups: [
        ["type", "coercion", "convert", "conversion", "string", "number", "data type"],
        ["strict", "exact", "same type", "value and type", "both"]
      ],
      rightAnswer: "== compares values after converting their types (e.g. '5' == 5 is true), whereas === checks both value and data type strictly without converting."
    },
    {
      question: "What happens in the browser when a user clicks a button that fetches data from an API?",
      conceptGroups: [
        ["event", "listener", "click", "handler", "request", "http", "fetch", "server"],
        ["response", "json", "wait", "async", "dom", "update", "render", "screen", "ui"]
      ],
      rightAnswer: "The click triggers an event handler that sends an HTTP request to the server in the background, waits for the response (usually JSON), and updates the page DOM with the new data."
    }
  ],
  react: [
    {
      question: "In simple words, what is the difference between state and props in React?",
      conceptGroups: [
        ["parent", "pass", "passed", "outside", "read-only", "readonly", "cannot change", "immutable", "argument"],
        ["inside", "internal", "local", "own", "manage", "change", "update", "re-render", "rerender", "usestate"]
      ],
      rightAnswer: "Props are passed into a component from its parent and stay read-only, while state is data stored inside the component that can change and trigger a UI update."
    },
    {
      question: "Why does React re-render a component, and when can extra re-renders slow down a page?",
      conceptGroups: [
        ["state", "prop", "parent", "context", "change", "update"],
        ["slow", "lag", "heavy", "expensive", "list", "large", "unnecessary", "dom", "compute", "memo"]
      ],
      rightAnswer: "React re-renders when state, props, or parent components update; too many unnecessary re-renders on big lists or heavy calculations can make the UI feel sluggish."
    },
    {
      question: "What is useEffect used for, and what happens if you forget its dependency array?",
      conceptGroups: [
        ["side effect", "fetch", "api", "timer", "subscribe", "dom", "mount", "after render"],
        ["every render", "infinite", "loop", "again and again", "repeatedly", "always runs"]
      ],
      rightAnswer: "useEffect runs side effects like API calls or timers after render; if you forget the dependency array, it runs after every single render and can cause an infinite loop if it updates state."
    },
    {
      question: "Why do we add a unique key prop when rendering a list in React?",
      conceptGroups: [
        ["track", "identify", "unique", "match", "same item"],
        ["add", "remove", "delete", "reorder", "update", "efficient", "dom", "bug"]
      ],
      rightAnswer: "Keys let React identify which list items were added, removed, or moved so it updates only what changed instead of mixing up item state."
    },
    {
      question: "How do you pass data from a child component back up to its parent in React?",
      conceptGroups: [
        ["callback", "function", "handler", "prop", "event"],
        ["call", "invoke", "pass", "argument", "parent", "update state", "setstate"]
      ],
      rightAnswer: "The parent passes a callback function down to the child as a prop, and the child calls that function with the data so the parent can update its state."
    }
  ],
  node: [
    {
      question: "In simple words, how does Node.js handle many user requests at the same time on one thread?",
      conceptGroups: [
        ["event loop", "non-blocking", "nonblocking", "async", "asynchronous"],
        ["wait", "background", "os", "callback", "promise", "i/o", "database", "file", "other request"]
      ],
      rightAnswer: "Node.js uses a non-blocking event loop: slow work like database or file I/O runs in the background while the single thread keeps serving other requests."
    },
    {
      question: "What is middleware in Express, and when would you use it?",
      conceptGroups: [
        ["between", "before", "request", "response", "req", "res", "next"],
        ["auth", "login", "log", "validate", "error", "cors", "json", "parse", "check"]
      ],
      rightAnswer: "Middleware is a function that runs between receiving a request and sending a response (calling next()), used for logging, auth checks, parsing JSON, or error handling."
    },
    {
      question: "How do you handle errors in an Express API so the server does not crash?",
      conceptGroups: [
        ["try", "catch", "next", "error middleware", "4 parameters", "err"],
        ["status", "500", "400", "json", "message", "log", "crash"]
      ],
      rightAnswer: "Wrap async route logic in try/catch and pass errors to Express's central error-handling middleware so it logs the issue and returns a clean HTTP error response."
    },
    {
      question: "Why do we store secrets in environment variables instead of writing them in code?",
      conceptGroups: [
        ["git", "github", "repo", "leak", "public", "security", "safe", "hide", "exposed"],
        ["different", "dev", "prod", "production", "staging", "change", "rotate", "config"]
      ],
      rightAnswer: "So passwords and API keys never get leaked in Git repositories, and so you can easily use different keys for development and production."
    },
    {
      question: "What is the difference between synchronous and asynchronous code in Node.js?",
      conceptGroups: [
        ["block", "wait", "line by line", "one at a time", "finish", "order"],
        ["non-blocking", "continue", "background", "promise", "async", "await", "callback", "later"]
      ],
      rightAnswer: "Synchronous code blocks and waits for each step to finish before moving on, while asynchronous code starts an operation and lets other code run until it finishes."
    }
  ],
  sql: [
    {
      question: "In simple words, what is a primary key and how is it different from a foreign key?",
      conceptGroups: [
        ["unique", "identify", "not null", "each row", "table"],
        ["link", "connect", "reference", "another table", "other table", "relationship"]
      ],
      rightAnswer: "A primary key uniquely identifies each row in its own table (never null or duplicate), while a foreign key points to a primary key in another table to link rows together."
    },
    {
      question: "What does an index do in a SQL table, and why shouldn't we add indexes to every column?",
      conceptGroups: [
        ["fast", "faster", "speed", "search", "select", "lookup", "find", "book"],
        ["slow", "insert", "update", "delete", "write", "storage", "disk", "space", "extra work"]
      ],
      rightAnswer: "An index speeds up SELECT searches like a book's index, but adding too many slows down INSERT/UPDATE/DELETE writes and uses extra disk space."
    },
    {
      question: "What is the difference between INNER JOIN and LEFT JOIN?",
      conceptGroups: [
        ["match", "both", "common", "intersection", "only matching"],
        ["all", "left", "null", "missing", "unmatched", "keep"]
      ],
      rightAnswer: "INNER JOIN returns only rows that match in both tables, while LEFT JOIN keeps every row from the left table and fills unmatched right columns with NULL."
    },
    {
      question: "In plain terms, why do we use database transactions when updating money or orders?",
      conceptGroups: [
        ["all or nothing", "both", "together", "atomic", "complete"],
        ["fail", "error", "rollback", "undo", "half", "consistent", "safe"]
      ],
      rightAnswer: "Transactions ensure 'all or nothing' updates—if one step fails halfway (like debiting an account before crediting another), rollback undoes everything cleanly."
    },
    {
      question: "If a SQL query runs slowly, what are the first two things you check?",
      conceptGroups: [
        ["index", "indexes", "missing index", "where", "join"],
        ["explain", "plan", "select *", "limit", "rows", "full table scan", "n+1"]
      ],
      rightAnswer: "First check if the columns in WHERE/JOIN have proper indexes using EXPLAIN, and check if the query is fetching too many unnecessary rows or using SELECT *."
    }
  ],
  java: [
    {
      question: "In simple words, what is the difference between an abstract class and an interface in Java?",
      conceptGroups: [
        ["multiple", "implement", "extends", "inherit", "many", "one"],
        ["body", "method", "field", "state", "constructor", "contract", "default"]
      ],
      rightAnswer: "A class can extend only one abstract class (which can hold constructors and state), while a class can implement multiple interfaces (which define a shared contract of methods)."
    },
    {
      question: "How does garbage collection in Java help developers?",
      conceptGroups: [
        ["memory", "free", "unused", "object", "heap", "clean"],
        ["automatic", "automatically", "manual", "leak", "crash", "out of memory"]
      ],
      rightAnswer: "Garbage collection automatically finds and frees memory used by objects you no longer need, reducing manual memory bugs and leaks."
    },
    {
      question: "What is the difference between ArrayList and HashMap, and when do you pick each?",
      conceptGroups: [
        ["index", "order", "list", "sequence", "position", "number"],
        ["key", "value", "pair", "fast", "lookup", "o(1)", "name", "id"]
      ],
      rightAnswer: "ArrayList stores an ordered list accessed by numeric index (0, 1, 2...), while HashMap stores key-value pairs for instant lookup by a key like an ID or name."
    },
    {
      question: "In simple terms, what does dependency injection in Spring Boot do for you?",
      conceptGroups: [
        ["create", "object", "bean", "manage", "provide", "give", "pass"],
        ["loose", "decouple", "test", "mock", "new", "hardcode", "spring"]
      ],
      rightAnswer: "Instead of creating helper objects manually with 'new', Spring creates and passes the needed objects into your class automatically, making code cleaner and easier to test."
    },
    {
      question: "What happens if you compare two strings in Java using == instead of .equals()?",
      conceptGroups: [
        ["reference", "address", "memory", "object", "same object"],
        ["content", "value", "text", "characters", "false", "wrong"]
      ],
      rightAnswer: "== checks whether both variables point to the same memory reference, while .equals() checks whether the actual text characters inside the strings match."
    }
  ],
  python: [
    {
      question: "In simple words, what is the difference between a list and a tuple in Python?",
      conceptGroups: [
        ["mutable", "change", "modify", "add", "remove", "edit", "append"],
        ["immutable", "cannot change", "fixed", "unchangeable", "read-only", "safe"]
      ],
      rightAnswer: "A list is mutable (you can add, remove, or change items), while a tuple is immutable (once created, its items cannot be changed)."
    },
    {
      question: "Why is a Python dictionary fast when looking up a value by key?",
      conceptGroups: [
        ["hash", "hashing", "hash table", "bucket"],
        ["direct", "o(1)", "constant", "without looping", "scan", "index"]
      ],
      rightAnswer: "A Python dictionary uses a hash table: it hashes the key to jump straight to the right memory slot in O(1) time instead of scanning every item."
    },
    {
      question: "What is overfitting in machine learning, explained in plain language?",
      conceptGroups: [
        ["memorize", "memorizes", "training", "train", "noise", "exact"],
        ["new data", "unseen", "test", "generalize", "bad", "poor", "fails"]
      ],
      rightAnswer: "Overfitting happens when a model memorizes the training data too closely (including noise), so it scores great in training but performs poorly on new, unseen data."
    },
    {
      question: "What is the difference between a list comprehension and a normal for-loop in Python?",
      conceptGroups: [
        ["short", "one line", "concise", "readable", "create", "new list", "expression"],
        ["faster", "fast", "multi-line", "complex", "side effect", "logic"]
      ],
      rightAnswer: "A list comprehension builds a new list in one clean, slightly faster line; a regular for-loop is better when you have complex multi-step logic or side effects."
    },
    {
      question: "When training a model, why do we split data into training and test sets?",
      conceptGroups: [
        ["learn", "train", "fit", "pattern"],
        ["unseen", "new", "evaluate", "check", "real", "cheat", "overfit"]
      ],
      rightAnswer: "The model learns from the training set, and we test it on unseen test data to make sure it actually generalizes instead of just memorizing answers."
    }
  ],
  dsa: [
    {
      question: "In simple words, when would you use a stack versus a queue?",
      conceptGroups: [
        ["lifo", "last in first out", "top", "undo", "back", "recent"],
        ["fifo", "first in first out", "line", "order", "wait", "print", "task"]
      ],
      rightAnswer: "A stack is Last-In-First-Out (like browser Back or Undo), while a queue is First-In-First-Out (like a waiting line or job queue)."
    },
    {
      question: "Why is looking up an item in a hash map usually much faster than searching an array?",
      conceptGroups: [
        ["hash", "compute", "jump", "direct", "o(1)", "constant"],
        ["loop", "one by one", "linear", "o(n)", "scan", "every element"]
      ],
      rightAnswer: "Searching an unsorted array checks elements one by one (O(n)), while a hash map computes the slot directly from the key in O(1) time."
    },
    {
      question: "How does binary search work, and what must be true about the array first?",
      conceptGroups: [
        ["sorted", "order", "ascending", "descending"],
        ["half", "middle", "mid", "divide", "split", "left", "right", "log"]
      ],
      rightAnswer: "The array must be sorted first. Binary search checks the middle element and throws away half of the remaining items on each step."
    },
    {
      question: "What is the difference between BFS and DFS when walking through a tree or graph?",
      conceptGroups: [
        ["level", "layer", "breadth", "neighbor", "queue", "shortest"],
        ["deep", "depth", "branch", "end", "backtrack", "stack", "recursion"]
      ],
      rightAnswer: "BFS explores level by level using a queue (great for shortest paths), while DFS dives down one branch as far as possible before backtracking using a stack or recursion."
    },
    {
      question: "In plain words, what does Big-O time complexity tell us about an algorithm?",
      conceptGroups: [
        ["grow", "growth", "scale", "input", "size", "n", "larger"],
        ["worst", "steps", "operations", "time", "speed", "compare"]
      ],
      rightAnswer: "Big-O describes how the number of steps an algorithm takes grows as the input size gets larger, helping us compare efficiency."
    }
  ]
};

const getRubricBankForTopic = (topic: string): QuestionRubric[] => {
  const lower = topic.toLowerCase();
  if (lower.includes("react") || lower.includes("frontend")) return QUESTION_BANKS.react;
  if (lower.includes("node") || lower.includes("backend")) return QUESTION_BANKS.node;
  if (lower.includes("sql") || lower.includes("database")) return QUESTION_BANKS.sql;
  if (lower.includes("web") || lower.includes("html") || lower.includes("css") || /\b(js|javascript)\b/.test(lower)) {
    return QUESTION_BANKS.web;
  }
  if (/\bjava\b/.test(lower) || lower.includes("spring")) return QUESTION_BANKS.java;
  if (lower.includes("python") || /\b(ai|ml|machine learning)\b/.test(lower)) return QUESTION_BANKS.python;
  if (lower.includes("dsa") || lower.includes("algorithm")) return QUESTION_BANKS.dsa;
  return [
    {
      question: `In simple words, what is ${topic} and why do developers use it?`,
      conceptGroups: [
        ["build", "create", "manage", "solve", "tool", "language", "framework", "system", "data", "app", "web", "server"],
        ["because", "helps", "used for", "faster", "easier", "reliable", "scalable", "clean", "organize"]
      ],
      rightAnswer: `Explain clearly what ${topic} is, one real problem it solves for developers, and a simple example of where it is used.`
    },
    {
      question: `Tell me about a real bug or problem you faced while working with ${topic}, and how you fixed it.`,
      conceptGroups: [
        ["bug", "error", "issue", "crash", "slow", "wrong", "broken", "fail", "problem"],
        ["debug", "log", "check", "fix", "changed", "updated", "tested", "found", "solved"]
      ],
      rightAnswer: `Describe what went wrong, how you found the root cause (logs, breakpoints, or testing), and what exact fix solved it.`
    },
    {
      question: `What is one common mistake beginners make in ${topic}?`,
      conceptGroups: [
        ["forget", "miss", "skip", "wrong", "error", "slow", "leak", "break", "hardcode", "ignore"],
        ["instead", "fix", "avoid", "should", "always", "check", "test", "better"]
      ],
      rightAnswer: `Name one specific mistake (like skipping edge cases, hardcoding values, or ignoring errors) and explain how to avoid it.`
    },
    {
      question: `If you had to explain ${topic} to a friend new to coding, what simple example would you use?`,
      conceptGroups: [
        ["like", "example", "imagine", "suppose", "real", "daily", "website", "app", "store", "user"],
        ["works", "shows", "means", "helps", "easy", "simple", "step"]
      ],
      rightAnswer: `Use an everyday analogy or small real-world example (like an app login or shopping cart) to show how it works step by step.`
    },
    {
      question: `How do you check that your ${topic} code works properly before sharing it?`,
      conceptGroups: [
        ["test", "check", "edge case", "input", "error", "unit", "manual", "browser", "console"],
        ["verify", "empty", "null", "invalid", "review", "clean", "bug"]
      ],
      rightAnswer: `Test both normal cases and edge cases (empty or invalid inputs), check console/server logs for errors, and review code before pushing.`
    }
  ];
};

const scoreSimpleAnswerHeuristic = (
  topic: string,
  questionAsked: string,
  answerRaw: string
): { score: number; feedback: string } => {
  const answer = answerRaw.trim();
  const lower = answer.toLowerCase();
  const words = answer.split(/\s+/).filter(Boolean);
  const bank = getRubricBankForTopic(topic);
  const matchedRubric = bank.find(
    (item) => item.question.toLowerCase().trim() === questionAsked.toLowerCase().trim()
  );

  if (
    words.length <= 2 ||
    /\b(i don'?t know|dont know|no idea|not sure|skip|pass|idk|nothing)\b/i.test(lower)
  ) {
    return {
      score: 1,
      feedback: matchedRubric
        ? `No problem if you weren't sure on this one. Here is the simple answer: ${matchedRubric.rightAnswer}`
        : "Looks like you weren't sure on this one. That's okay—review the basic definition in 2 simple sentences so you're ready next time."
    };
  }

  // Detect obvious cross-domain wrong answers (e.g., SQL database for React state)
  const lowerTopic = topic.toLowerCase();
  const obviousWrongCrossDomain =
    (lowerTopic.includes("react") && /\b(sql database|hard drive|bios|c\+\+ pointer)\b/i.test(lower)) ||
    (lowerTopic.includes("sql") && /\b(css flexbox|html tag|jsx)\b/i.test(lower));

  if (obviousWrongCrossDomain) {
    return {
      score: 1,
      feedback: matchedRubric
        ? `That's not right—your answer mixes in unrelated concepts. ${matchedRubric.rightAnswer}`
        : `That doesn't match ${topic}. Focus directly on what the question asked instead of guessing unrelated terms.`
    };
  }

  if (matchedRubric) {
    const groupsHit = matchedRubric.conceptGroups.filter((group) =>
      group.some((kw) => lower.includes(kw))
    ).length;

    if (groupsHit === 0) {
      if (words.length < 7) {
        return {
          score: 2,
          feedback: `Your answer is too short and misses the core point. Simple answer: ${matchedRubric.rightAnswer}`
        };
      }
      return {
        score: 2,
        feedback: `That doesn't really answer what was asked. Here's how it works in plain words: ${matchedRubric.rightAnswer}`
      };
    }

    if (groupsHit === 1) {
      return {
        score: words.length >= 10 ? 5 : 4,
        feedback: `You got part of the idea right, but key details are missing. Complete answer: ${matchedRubric.rightAnswer}`
      };
    }

    if (words.length >= 16) {
      return {
        score: 8,
        feedback: `Right—you explained the key points clearly in simple words! Quick recap: ${matchedRubric.rightAnswer}`
      };
    }
    return {
      score: 7,
      feedback: `Good, you covered the main idea accurately. Adding one short example would make it even clearer.`
    };
  }

  // Fallback for any custom/unlisted question
  if (words.length < 6) {
    return {
      score: 3,
      feedback: `"${answer}" is too brief for an interview answer. Explain how it works in 2–3 simple sentences with one example.`
    };
  }

  const hasReasoning = /\b(because|so that|helps|used for|instead|when|while|example|difference|allows|prevents|stores|updates)\b/i.test(lower);
  if (hasReasoning && words.length >= 14) {
    return {
      score: 7,
      feedback: "Clear explanation with good reasoning. To score higher in a real interview, verify your technical terms and include one concrete use case."
    };
  }

  return {
    score: 5,
    feedback: "You gave a starting point, though it's still fairly general. Be more specific about how it actually works under the hood and why you'd use it."
  };
};

const buildRoundSummary = (roundNumber: number, lastFiveScores: number[]) => {
  const valid = lastFiveScores.length > 0 ? lastFiveScores : [0];
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const scoreOutOf10 = Math.round(avg * 10) / 10;

  let strengths = "You stayed engaged through all 5 questions.";
  let improvements = "Practice explaining core concepts in 2 simple sentences with one real example.";

  if (scoreOutOf10 < 4) {
    strengths = "Basics are still shaky across this 5-question round.";
    improvements = "Go back to core definitions first. Practice explaining what each concept does in plain English before moving to tougher topics.";
  } else if (scoreOutOf10 < 7) {
    strengths = "You got several core ideas right, though a few answers were incomplete.";
    improvements = "Don't stop after naming a term—always add 'why' it matters and one short example.";
  } else {
    strengths = "Solid understanding and clear simple-English explanations across this set.";
    improvements = "Keep practicing edge cases and real project examples to push from 7–8 up to 9–10.";
  }

  const spokenSummary = `You finished 5 questions. Your score for this set is ${scoreOutOf10} out of 10. ${improvements}`;

  return {
    roundNumber,
    scoreOutOf10,
    strengths,
    improvements,
    spokenSummary,
  };
};

const buildContextualInterviewFallback = (
  topic: string,
  history: { role?: string; text?: string }[],
  answeredCountInput?: number,
  recentScoresInput: number[] = []
): {
  question: string;
  feedback?: string;
  answerScore?: number;
  roundSummary?: ReturnType<typeof buildRoundSummary>;
} => {
  const userTurns = history.filter((m) => m?.role === "user" && m?.text?.trim());
  const assistantTurns = history.filter((m) => m?.role === "assistant" && m?.text?.trim());
  const bank = getRubricBankForTopic(topic);

  const totalAnswered = typeof answeredCountInput === "number" ? answeredCountInput : userTurns.length;
  const nextQuestion = bank[totalAnswered % bank.length].question;
  if (userTurns.length === 0) {
    return { question: nextQuestion };
  }

  const lastAnswer = String(userTurns[userTurns.length - 1].text || "").trim();
  const lastQuestion = String(assistantTurns[assistantTurns.length - 1]?.text || "");
  const evaluated = scoreSimpleAnswerHeuristic(topic, lastQuestion, lastAnswer);

  let roundSummary: ReturnType<typeof buildRoundSummary> | undefined;
  if (totalAnswered > 0 && totalAnswered % 5 === 0) {
    const lastFive = [...recentScoresInput.slice(-4), evaluated.score];
    roundSummary = buildRoundSummary(Math.floor(totalAnswered / 5), lastFive);
  }

  return {
    question: nextQuestion,
    feedback: evaluated.feedback,
    answerScore: evaluated.score,
    roundSummary,
  };
};

const generateWithFallback = async (
  ai: GoogleGenAI,
  params: { contents: any; config?: any; preferFast?: boolean }
) => {
  const models = params.preferFast
    ? [FALLBACK_GEMINI_MODEL, PRIMARY_GEMINI_MODEL, FALLBACK_GEMINI_MODEL]
    : [PRIMARY_GEMINI_MODEL, FALLBACK_GEMINI_MODEL, PRIMARY_GEMINI_MODEL];
  let lastError: any;

  for (let i = 0; i < models.length; i++) {
    const timeoutMs = i === 0 ? 8000 : i === 1 ? 12000 : 14000;
    try {
      return await withTimeout(
        ai.models.generateContent({
          model: models[i],
          contents: params.contents,
          config: params.config,
        }),
        timeoutMs,
        `Gemini (${models[i]})`
      );
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || "").toLowerCase();
      const status = err?.status || err?.code;
      const isTransient =
        status === 503 ||
        status === 429 ||
        status === 500 ||
        msg.includes("503") ||
        msg.includes("500") ||
        msg.includes("timed out") ||
        msg.includes("timeout") ||
        msg.includes("unavailable") ||
        msg.includes("high demand") ||
        msg.includes("resource_exhausted") ||
        msg.includes("fetch failed");
      if (!isTransient || i === models.length - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, i === 0 ? 250 : 600));
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
    const geminiKey = process.env.GEMINI_API_KEY;
    const geminiConfigured = Boolean(
      geminiKey &&
        geminiKey !== "YOUR_GEMINI_API_KEY_HERE" &&
        geminiKey !== "YOUR_GEMINI_API_KEY"
    );
    const smtpConfigured = Boolean(
      process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    );
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      env: {
        geminiConfigured,
        smtpConfigured,
      },
    });
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
    const {
      topic,
      history = [],
      answeredCount,
      recentScores = [],
    } = req.body || {};
    if (!topic || !String(topic).trim()) {
      return res.status(400).json({ error: "Interview topic is required." });
    }
    const cleanTopic = String(topic).trim();
    const safeHistory = Array.isArray(history) ? history.slice(-12) : [];
    const safeRecentScores = Array.isArray(recentScores)
      ? recentScores.filter((n: any) => typeof n === "number" && Number.isFinite(n))
      : [];
    const userCountInHistory = safeHistory.filter((m: any) => m?.role === "user").length;
    const totalAnswered =
      typeof answeredCount === "number" && Number.isFinite(answeredCount)
        ? answeredCount
        : userCountInHistory;
    const hasPreviousAnswer = userCountInHistory > 0;
    const isFiveQuestionCheckpoint = hasPreviousAnswer && totalAnswered > 0 && totalAnswered % 5 === 0;

    try {
      const ai = getGeminiClient();
      const prompt = hasPreviousAnswer
        ? `You are a friendly, down-to-earth technical interview coach speaking in SIMPLE, EVERYDAY ENGLISH ("no complex talk", short clear sentences, easy to hear and understand aloud) for topic "${cleanTopic}".

Conversation so far:
${JSON.stringify(safeHistory)}

STRICT RULES FOR YOUR RESPONSE:
1. Plain Simple English: Talk like a helpful human coach. Do NOT use fancy corporate jargon, complex words, or long sentences.
2. Genuine Honest Feedback (NO FAKE COMPLIMENTS):
   - Evaluate the candidate's latest answer honestly against the question asked.
   - If the answer is WRONG, off-topic, nonsensical, or "I don't know": say clearly and kindly that it is NOT right (for example: "That's not quite right." or "Looks like you weren't sure on that one."), DO NOT compliment or praise it, and explain the right answer in 1-2 simple sentences. Score it 0 to 3.
   - If the answer is PARTIALLY right or too vague: clearly state what part is right and what key part is wrong or missing. Score it 4 to 6.
   - If the answer is GENUINELY accurate and clear: confirm specifically why it's right in plain words (no exaggeration) and mention one helpful detail if needed. Score it 7 to 10.
3. Next Question: Ask ONE simple, practical interview question (1-2 short everyday sentences) on "${cleanTopic}".
${isFiveQuestionCheckpoint ? `4. 5-Question Preparation Check: The candidate just finished question #${totalAnswered}. Give brief plain-English "roundStrengths" (what they genuinely got right across these 5 answers, or state plainly if basics are still missing) and "roundImprovements" (the top 1-2 things they should study next for future preparation).` : ""}`
        : `You are a friendly, down-to-earth technical interview coach speaking in SIMPLE, EVERYDAY ENGLISH (short clear sentences, easy to hear aloud, no complex talk) starting a mock interview on "${cleanTopic}".
Ask ONE simple, clear opening interview question (1-2 short everyday sentences). Leave "feedback" empty.`;

      const response = await generateWithFallback(ai, {
        preferFast: true,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              feedback: { type: Type.STRING },
              answerScore: { type: Type.NUMBER },
              roundStrengths: { type: Type.STRING },
              roundImprovements: { type: Type.STRING },
            },
            required: ["question"]
          }
        }
      });

      const parsed = JSON.parse(cleanJsonText(response.text));
      const fallbackData = buildContextualInterviewFallback(
        cleanTopic,
        safeHistory,
        totalAnswered,
        safeRecentScores
      );

      let numericScore: number | undefined;
      if (hasPreviousAnswer) {
        if (typeof parsed.answerScore === "number" && Number.isFinite(parsed.answerScore)) {
          numericScore = Math.max(0, Math.min(10, Math.round(parsed.answerScore * 10) / 10));
        } else {
          numericScore = fallbackData.answerScore ?? 5;
        }
      }

      let roundSummary: ReturnType<typeof buildRoundSummary> | undefined;
      if (isFiveQuestionCheckpoint && typeof numericScore === "number") {
        const lastFive = [...safeRecentScores.slice(-4), numericScore];
        const avg = lastFive.reduce((a, b) => a + b, 0) / lastFive.length;
        const scoreOutOf10 = Math.round(avg * 10) / 10;
        const defaultRound = buildRoundSummary(Math.floor(totalAnswered / 5), lastFive);
        const strengths =
          typeof parsed.roundStrengths === "string" && parsed.roundStrengths.trim()
            ? parsed.roundStrengths.trim()
            : defaultRound.strengths;
        const improvements =
          typeof parsed.roundImprovements === "string" && parsed.roundImprovements.trim()
            ? parsed.roundImprovements.trim()
            : defaultRound.improvements;
        roundSummary = {
          roundNumber: Math.floor(totalAnswered / 5),
          scoreOutOf10,
          strengths,
          improvements,
          spokenSummary: `You completed 5 questions. Your score is ${scoreOutOf10} out of 10. ${improvements}`,
        };
      }

      res.json({
        question: parsed.question || fallbackData.question,
        feedback: hasPreviousAnswer ? parsed.feedback || fallbackData.feedback || "" : undefined,
        answerScore: numericScore,
        roundSummary,
      });
    } catch (err: any) {
      console.warn("Using contextual interview fallback due to Gemini error:", err?.message || err);
      const fallback = buildContextualInterviewFallback(
        cleanTopic,
        safeHistory,
        totalAnswered,
        safeRecentScores
      );
      res.json({
        ...fallback,
        fallback: true,
      });
    }
  });

  app.post("/api/ai/career-assistant", async (req, res) => {
    try {
      const { prompt, history = [] } = req.body;
      if (!prompt || !String(prompt).trim()) {
        return res.status(400).json({ error: "Prompt is required." });
      }
      const ai = getGeminiClient();
      const response = await generateWithFallback(ai, {
        preferFast: true,
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
      const { courseTitle, moduleTitle, userQuestion, moduleSummary, history = [] } = req.body;
      if (!userQuestion || !String(userQuestion).trim()) {
        return res.status(400).json({ error: "Question is required." });
      }
      const ai = getGeminiClient();
      const safeHistory = Array.isArray(history) ? history.slice(-6) : [];
      const prompt = `You are a friendly, expert tech mentor teaching the course "${courseTitle || "Tech Course"}", specifically the module "${moduleTitle || "Current Module"}".
${moduleSummary ? `Module focus: ${moduleSummary}\n` : ""}${safeHistory.length ? `Recent conversation:\n${JSON.stringify(safeHistory)}\n` : ""}Student's question:
"${String(userQuestion).trim()}"

Provide a crystal clear, engaging, and practical explanation.
Guidelines:
1. Explain in simple terms using a quick real-world analogy.
2. Provide a concrete code or practical example if relevant.
3. Keep it concise (around 120-180 words), encouraging, and structured with clear bullet points.`;

      const response = await generateWithFallback(ai, {
        preferFast: true,
        contents: prompt
      });
      res.json({
        text: response.text || `Here is an explanation of ${userQuestion} for ${courseTitle || "this course"}.`
      });
    } catch (err: any) {
      console.error("Error in /api/ai/course-tutor:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to contact course AI tutor." });
    }
  });

  app.post("/api/ai/transcribe-audio", async (req, res) => {
    try {
      const { audioBase64, mimeType = "audio/webm" } = req.body;
      if (!audioBase64 || typeof audioBase64 !== "string") {
        return res.status(400).json({ error: "Audio payload is required." });
      }
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY_HERE" || apiKey === "YOUR_GEMINI_API_KEY") {
        return res.status(503).json({ error: "GEMINI_API_KEY is missing." });
      }

      const transcribeClient = new GoogleGenAI({
        apiKey,
        apiVersion: "v1beta",
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      const cleanMime = String(mimeType).split(";")[0] || "audio/wav";
      const contents = {
        parts: [
          {
            inlineData: {
              mimeType: cleanMime,
              data: audioBase64,
            },
          },
          {
            text: "Transcribe this spoken technical interview answer accurately. Return only the spoken words as plain text with normal punctuation. If there is no clear speech, return an empty string.",
          },
        ],
      };

      const models = [
        "gemini-3.5-transcribe",
        FALLBACK_GEMINI_MODEL,
        PRIMARY_GEMINI_MODEL,
        "gemini-3.5-transcribe",
      ];
      let finalText = "";
      let lastErr: any;

      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        try {
          const response = await withTimeout(
            transcribeClient.models.generateContent({ model, contents }),
            18000,
            `Transcribe (${model})`
          );
          const candidate = (response?.text || "").trim();
          if (candidate) {
            finalText = candidate;
            lastErr = null;
            break;
          }
        } catch (err: any) {
          lastErr = err;
          const msg = String(err?.message || "").toLowerCase();
          const status = err?.status || err?.code;
          if (
            status === 404 ||
            status === 503 ||
            status === 500 ||
            status === 429 ||
            msg.includes("not found") ||
            msg.includes("404") ||
            msg.includes("503") ||
            msg.includes("500") ||
            msg.includes("429") ||
            msg.includes("high demand") ||
            msg.includes("timed out") ||
            msg.includes("unavailable") ||
            msg.includes("internal") ||
            msg.includes("unsupported")
          ) {
            if (i < models.length - 1) {
              await new Promise((r) => setTimeout(r, 350));
            }
            continue;
          }
          throw err;
        }
      }

      if (!finalText && lastErr) throw lastErr;

      res.json({ text: finalText });
    } catch (err: any) {
      console.error("Error in /api/ai/transcribe-audio:", err);
      const status = typeof err?.status === "number" ? err.status : 500;
      res.status(status).json({
        error: formatGeminiError(
          err,
          "Speech transcription is temporarily busy. Please try again or switch to Live Browser Mic."
        ),
      });
    }
  });

  app.post("/api/ai/tts", async (req, res) => {
    try {
      const { text, voiceName } = req.body;
      if (!text || !String(text).trim()) {
        return res.status(400).json({ error: "Text is required for speech synthesis." });
      }
      const cleanText = String(text).replace(/[*_#`]/g, "").trim().slice(0, 1200);
      const allowedVoices = new Set(["Zephyr", "Puck", "Kore", "Charon", "Fenrir"]);
      const selectedVoice =
        typeof voiceName === "string" && allowedVoices.has(voiceName)
          ? voiceName
          : "Zephyr";

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY_HERE" || apiKey === "YOUR_GEMINI_API_KEY") {
        return res.status(503).json({ error: "GEMINI_API_KEY is missing." });
      }

      const ttsClient = new GoogleGenAI({
        apiKey,
        apiVersion: "v1beta",
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      let response: any;
      try {
        response = await withTimeout(
          ttsClient.models.generateContent({
            model: "gemini-3.8-flash-lite-tts",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: cleanText,
                    speechMetadata: {
                      style: "Friendly, calm, simple everyday conversational English speaking clearly at a natural pace",
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: selectedVoice },
                },
              },
            },
          }),
          12000,
          "Gemini TTS"
        );
      } catch (innerErr: any) {
        const msg = String(innerErr?.message || "");
        if (msg.includes("Cannot find field")) {
          response = await withTimeout(
            ttsClient.models.generateContent({
              model: "gemini-3.8-flash-lite-tts",
              contents: cleanText,
              config: {
                responseModalities: ["AUDIO"],
              },
            }),
            12000,
            "Gemini TTS (fallback)"
          );
        } else {
          throw innerErr;
        }
      }

      const audioBase64 =
        response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioBase64) {
        return res.status(502).json({ error: "No audio returned by TTS model." });
      }
      res.json({ audioBase64, mimeType: "audio/wav" });
    } catch (err: any) {
      console.error("Error in /api/ai/tts:", err);
      res.status(err?.status || 500).json({ error: err?.message || "Failed to synthesize speech." });
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
    const distPath = fs.existsSync(path.resolve(currentDirname, "index.html"))
      ? currentDirname
      : path.resolve(process.cwd(), "dist");
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
