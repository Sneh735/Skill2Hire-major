import React, { useState } from 'react';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { analyzeResume, ResumeAnalysis } from '../services/ai';
import { cn } from '../lib/utils';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface ResumeUploaderProps {
  onAnalysisComplete: (analysis: ResumeAnalysis) => void;
}

export default function ResumeUploader({ onAnalysisComplete }: ResumeUploaderProps) {
  const [mode, setMode] = useState<'upload' | 'paste'>('upload');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState('');

  const extractTextFromPdf = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((item: any) => item.str).join(' ') + '\n';
    }
    return text.trim();
  };

  const runAnalysis = async (text: string) => {
    if (!text.trim()) {
      setError('No readable text found in your resume. Please upload a text-based PDF, .txt file, or paste your resume text.');
      return;
    }

    setIsAnalyzing(true);
    setError(null);

    try {
      const analysis = await analyzeResume(text);
      onAnalysisComplete(analysis);
    } catch (err: any) {
      console.error(err);
      let errMsg = 'Failed to analyze resume. Please try again.';
      if (err instanceof Error) {
        errMsg = err.message;
        try {
          const parsed = JSON.parse(errMsg);
          if (parsed?.error?.message) {
            errMsg = parsed.error.message;
          }
        } catch {
          // keep original message
        }
      }
      setError(errMsg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf');
    const isTxt = file.type === 'text/plain' || lowerName.endsWith('.txt');

    if (!isPdf && !isTxt) {
      setError('Please upload a PDF (.pdf) or text (.txt) resume file.');
      return;
    }

    setUploadedFileName(file.name);
    setIsAnalyzing(true);
    setError(null);

    try {
      const text = isPdf ? await extractTextFromPdf(file) : (await file.text()).trim();
      if (!text) {
        setError('This PDF has no selectable text (it may be scanned as an image). Please use a text-based PDF or switch to "Paste Resume Text".');
        setIsAnalyzing(false);
        return;
      }
      await runAnalysis(text);
    } catch (err: any) {
      console.error(err);
      setError(err?.message || 'Failed to read resume file. Please try another file or paste your resume text.');
      setIsAnalyzing(false);
    }
  };

  const handlePasteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadedFileName(null);
    await runAnalysis(pastedText);
  };

  return (
    <div className="w-full flex flex-col items-center text-center space-y-6">
      <div className="inline-flex p-1 bg-slate-100 rounded-2xl border border-slate-200">
        <button
          type="button"
          onClick={() => {
            setMode('upload');
            setError(null);
          }}
          className={cn(
            'px-4 py-2 rounded-xl text-xs font-bold transition-all',
            mode === 'upload' ? 'bg-white text-brand-blue shadow-sm' : 'text-slate-600 hover:text-slate-900'
          )}
        >
          Upload PDF / TXT
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('paste');
            setError(null);
          }}
          className={cn(
            'px-4 py-2 rounded-xl text-xs font-bold transition-all',
            mode === 'paste' ? 'bg-white text-brand-blue shadow-sm' : 'text-slate-600 hover:text-slate-900'
          )}
        >
          Paste Resume Text
        </button>
      </div>

      {mode === 'upload' ? (
        <div
          className={cn(
            'w-full p-10 border-2 border-dashed rounded-[32px] transition-all duration-300 relative group',
            isAnalyzing ? 'border-brand-blue bg-brand-blue/5' : 'border-brand-border hover:border-brand-blue hover:bg-brand-blue/5'
          )}
        >
          <input
            type="file"
            className="absolute inset-0 opacity-0 cursor-pointer z-10"
            accept=".pdf,.txt"
            onChange={handleFileUpload}
            disabled={isAnalyzing}
          />

          <div className="flex flex-col items-center space-y-4 relative z-0">
            <div
              className={cn(
                'w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-500 shadow-lg',
                isAnalyzing ? 'bg-brand-blue text-white animate-pulse' : 'bg-white text-brand-blue group-hover:scale-110 border border-brand-border'
              )}
            >
              {isAnalyzing ? <Loader2 className="w-8 h-8 animate-spin" /> : <Upload className="w-8 h-8" />}
            </div>

            <div className="space-y-1">
              <h3 className="text-[20px] font-display font-bold text-brand-blue-heading tracking-tight">
                {isAnalyzing ? 'Analyzing Your Resume...' : 'Upload Your Resume'}
              </h3>
              <p className="text-brand-muted text-[13px] font-medium max-w-[280px]">
                {uploadedFileName && !error
                  ? `Selected: ${uploadedFileName}`
                  : 'Drag and drop your PDF or TXT resume here, or click to browse.'}
              </p>
            </div>

            <div className="pt-3 flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-brand-muted">
              <div className="flex items-center gap-1.5 px-3 py-1 bg-white rounded-full border border-brand-border/50">
                <FileText className="w-3.5 h-3.5" /> PDF / TXT
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1 bg-white rounded-full border border-brand-border/50">
                <CheckCircle className="w-3.5 h-3.5" /> ATS Scored
              </div>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={handlePasteSubmit} className="w-full space-y-4 text-left">
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder="Paste your resume text (name, education, skills, projects, experience)..."
            className="w-full min-h-[180px] p-5 bg-white border border-brand-border rounded-3xl text-sm font-medium text-slate-800 outline-none focus:border-brand-blue focus:ring-4 focus:ring-brand-blue/5 resize-y"
          />
          <button
            type="submit"
            disabled={isAnalyzing || !pastedText.trim()}
            className="w-full py-3.5 bg-brand-blue hover:bg-brand-blue-dark disabled:opacity-50 text-white rounded-2xl font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all"
          >
            {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            <span>{isAnalyzing ? 'Analyzing Resume...' : 'Analyze Resume Text'}</span>
          </button>
        </form>
      )}

      {error && (
        <div className="w-full flex items-start gap-3 p-4 bg-red-50 text-red-700 rounded-2xl text-[12px] font-medium border border-red-100 shadow-sm">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div className="text-left">
            <p className="font-bold uppercase tracking-widest text-red-800 text-[10px] mb-1">Analysis Notice</p>
            <p className="leading-relaxed">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
