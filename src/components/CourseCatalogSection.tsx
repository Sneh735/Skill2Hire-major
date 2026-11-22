import React, { useState, useMemo } from 'react';
import { Course } from '../types';
import { CourseCard } from './CourseCard';
import { generateCustomCourse } from '../services/ai';
import { 
  Search, 
  Sparkles, 
  Layers, 
  CheckCircle, 
  Loader2, 
  X, 
  BookOpen, 
  Laptop,
  Palette,
  ShieldCheck,
  AlertCircle
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';

interface CourseCatalogSectionProps {
  courses: Course[];
  enrollments: Record<string, { progress: number; status: string }>;
  completedCourses: string[];
  onEnroll: (courseId: string) => void;
  onComplete: (courseId: string, score: number) => void;
  onView: (course: Course) => void;
  userName: string;
  onAddCustomCourse: (course: Course) => void;
  isEmployee?: boolean;
}

export default function CourseCatalogSection({
  courses,
  enrollments,
  completedCourses,
  onEnroll,
  onComplete,
  onView,
  userName,
  onAddCustomCourse,
}: CourseCatalogSectionProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'All' | 'Technical' | 'Non-Technical'>('All');
  const [selectedDomain, setSelectedDomain] = useState<string>('All');
  
  // AI Generator Modal State
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [aiCategory, setAiCategory] = useState<'Technical' | 'Non-Technical'>('Technical');
  const [aiDifficulty, setAiDifficulty] = useState<'Beginner' | 'Intermediate' | 'Advanced'>('Beginner');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationSuccess, setGenerationSuccess] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Available unique domains from current courses
  const domains = useMemo(() => {
    const list = Array.from(new Set(courses.map(c => c.domain)));
    return ['All', ...list];
  }, [courses]);

  // Filtered Courses
  const filteredCourses = useMemo(() => {
    return courses.filter(course => {
      if (selectedCategory !== 'All' && course.category && course.category !== selectedCategory) {
        return false;
      }
      if (selectedDomain !== 'All' && course.domain !== selectedDomain) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = course.title.toLowerCase().includes(q);
        const matchesDesc = course.description.toLowerCase().includes(q);
        const matchesDomain = course.domain.toLowerCase().includes(q);
        return matchesTitle || matchesDesc || matchesDomain;
      }
      return true;
    });
  }, [courses, selectedCategory, selectedDomain, searchQuery]);

  const handleGenerateAiCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiTopic.trim() || isGenerating) return;

    setIsGenerating(true);
    setGenerationSuccess(null);
    setGenerationError(null);

    try {
      const newCourse = await generateCustomCourse(aiTopic.trim(), aiCategory, aiDifficulty);
      onAddCustomCourse(newCourse);
      setGenerationSuccess(`Your course "${newCourse.title}" is ready with 15 practice questions!`);
      setTimeout(() => {
        setIsAiModalOpen(false);
        setAiTopic('');
        setGenerationSuccess(null);
      }, 1800);
    } catch (err: any) {
      console.error(err);
      setGenerationError(err?.message || 'Could not create your course right now. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Top Light Banner & Actions Bar */}
      <div className="bg-gradient-to-br from-blue-50 via-sky-50/80 to-indigo-50/70 rounded-[32px] p-8 md:p-10 border border-blue-200/70 relative overflow-hidden shadow-sm">
        <div className="absolute right-0 top-0 bottom-0 w-96 bg-white/60 rounded-full blur-3xl pointer-events-none" />
        
        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="space-y-2.5 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 bg-white/90 text-brand-blue border border-blue-200/70 rounded-full text-xs font-semibold shadow-2xs">
              <Sparkles className="w-3.5 h-3.5 text-brand-blue" />
              <span>Easy Beginner-Friendly Learning</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-sans font-bold tracking-tight text-brand-blue-heading">
              AI Customize Course
            </h1>
            <p className="text-slate-600 text-sm md:text-base leading-relaxed font-normal">
              Pick any course below or type a topic you want to learn. Our AI creates simple lessons and a practice quiz so beginners can learn step by step and earn a certificate.
            </p>
          </div>

          {/* Action Button (Add Custom Topic removed) */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              onClick={() => {
                setGenerationError(null);
                setIsAiModalOpen(true);
              }}
              className="px-6 py-3.5 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-2xl font-semibold text-sm shadow-md shadow-blue-500/20 flex items-center gap-2 transition-all active:scale-95"
            >
              <Sparkles className="w-4 h-4" />
              <span>Create Course with AI</span>
            </button>
          </div>
        </div>

        {/* Beginner-Friendly Highlights */}
        <div className="mt-8 pt-6 border-t border-blue-200/60 grid grid-cols-2 sm:grid-cols-4 gap-4 relative z-10">
          <div className="bg-white/80 rounded-2xl p-4 border border-blue-100">
            <div className="text-xl font-bold text-brand-blue-heading">{courses.length} Courses</div>
            <div className="text-xs text-slate-600 mt-0.5">Ready to learn anytime</div>
          </div>
          <div className="bg-white/80 rounded-2xl p-4 border border-blue-100">
            <div className="text-xl font-bold text-brand-blue-heading">15 Questions</div>
            <div className="text-xs text-slate-600 mt-0.5">Simple practice quiz</div>
          </div>
          <div className="bg-white/80 rounded-2xl p-4 border border-blue-100">
            <div className="text-xl font-bold text-brand-blue-heading">Free Certificate</div>
            <div className="text-xs text-slate-600 mt-0.5">Download after passing</div>
          </div>
          <div className="bg-white/80 rounded-2xl p-4 border border-blue-100">
            <div className="text-xl font-bold text-brand-blue-heading">Beginner First</div>
            <div className="text-xs text-slate-600 mt-0.5">Clear, easy explanations</div>
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="bg-white p-6 rounded-3xl border border-brand-border/60 shadow-sm space-y-5">
        <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
          {/* Search Box */}
          <div className="relative w-full md:w-96">
            <Search className="w-4 h-4 text-brand-muted absolute left-4 top-1/2 -translate-y-1/2" />
            <input 
              type="text" 
              placeholder="Search courses like HTML, Python, React..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-3 bg-brand-cream/40 border border-brand-border rounded-2xl text-sm font-normal text-slate-700 outline-none focus:border-brand-blue focus:bg-white transition-all"
            />
          </div>

          {/* Major Category Segmented Tabs */}
          <div className="flex bg-slate-50 p-1.5 rounded-2xl border border-slate-200/80 w-full md:w-auto">
            {[
              { id: 'All', label: 'All Courses', icon: Layers },
              { id: 'Technical', label: 'Tech & Coding', icon: Laptop },
              { id: 'Non-Technical', label: 'Business & Design', icon: Palette },
            ].map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id as any)}
                className={cn(
                  "flex-1 md:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-xs transition-all",
                  selectedCategory === cat.id
                    ? "bg-white text-brand-blue shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                )}
              >
                <cat.icon className="w-3.5 h-3.5" />
                <span>{cat.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: Sub-domain Pill Chips */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider shrink-0 mr-1">Topic:</span>
          {domains.map((domain) => (
            <button
              key={domain}
              onClick={() => setSelectedDomain(domain)}
              className={cn(
                "px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all shrink-0 border",
                selectedDomain === domain
                  ? "bg-blue-50 border-brand-blue/40 text-brand-blue shadow-2xs"
                  : "bg-white border-brand-border text-slate-600 hover:border-brand-blue/30"
              )}
            >
              {domain}
            </button>
          ))}
        </div>
      </div>

      {/* Course Grid */}
      {filteredCourses.length === 0 ? (
        <div className="bg-white rounded-3xl border border-brand-border p-16 text-center max-w-lg mx-auto shadow-sm space-y-4">
          <BookOpen className="w-12 h-12 text-blue-300 mx-auto" />
          <h3 className="text-lg font-semibold text-brand-blue-heading">No matching course found</h3>
          <p className="text-sm text-slate-600 leading-relaxed">
            Want to learn "{searchQuery || 'this topic'}"? Let our AI build an easy beginner course for you in seconds!
          </p>
          <button
            onClick={() => {
              setAiTopic(searchQuery || '');
              setGenerationError(null);
              setIsAiModalOpen(true);
            }}
            className="px-6 py-3 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-2xl font-semibold text-xs inline-flex items-center gap-2 shadow-sm"
          >
            <Sparkles className="w-4 h-4" />
            <span>Create "{searchQuery || 'New Course'}" with AI</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredCourses.map(course => (
            <div key={course.id} className="relative flex flex-col justify-between">
              {/* Category indicator pill */}
              <div className="absolute top-4 right-4 z-10">
                <span className={cn(
                  "px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-xs",
                  course.category === 'Non-Technical'
                    ? "bg-purple-50 text-purple-700 border border-purple-200"
                    : "bg-blue-50 text-blue-700 border border-blue-200"
                )}>
                  {course.category || 'Technical'}
                </span>
              </div>

              <CourseCard 
                course={course} 
                isEnrolled={!!enrollments[course.id]}
                isCompleted={completedCourses.includes(course.id)}
                progress={enrollments[course.id]?.progress || 0}
                onEnroll={onEnroll}
                onComplete={onComplete}
                onView={onView}
                userName={userName}
              />
            </div>
          ))}
        </div>
      )}

      {/* Modal: Generate AI Course (Light & Beginner-Friendly) */}
      <AnimatePresence>
        {isAiModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white w-full max-w-lg p-8 rounded-[32px] shadow-2xl border border-blue-100 relative"
            >
              <button
                onClick={() => !isGenerating && setIsAiModalOpen(false)}
                className="absolute top-6 right-6 p-2 text-slate-400 hover:text-slate-700 rounded-xl"
              >
                <X className="w-5 h-5" />
              </button>

              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-brand-blue" />
                </div>
                <div>
                  <h3 className="font-sans font-bold text-xl text-brand-blue-heading leading-tight">
                    Create Your Custom Course
                  </h3>
                  <p className="text-xs text-slate-500 font-normal mt-0.5">
                    Type any subject in simple words — great for beginners.
                  </p>
                </div>
              </div>

              {generationSuccess ? (
                <div className="p-6 bg-emerald-50 border border-emerald-200 rounded-2xl text-center space-y-3">
                  <CheckCircle className="w-8 h-8 text-emerald-600 mx-auto" />
                  <p className="text-sm font-semibold text-emerald-800">{generationSuccess}</p>
                </div>
              ) : (
                <form onSubmit={handleGenerateAiCourse} className="space-y-5">
                  {generationError && (
                    <div className="p-3.5 bg-red-50 border border-red-200 rounded-2xl text-xs text-red-700 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                      <span>{generationError}</span>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-600 block">
                      What do you want to learn?
                    </label>
                    <input 
                      type="text" 
                      placeholder="e.g., Python Basics, HTML & CSS, Excel, Public Speaking"
                      value={aiTopic}
                      onChange={(e) => setAiTopic(e.target.value)}
                      required
                      disabled={isGenerating}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-normal text-slate-700 outline-none focus:border-brand-blue focus:bg-white transition-all"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-600 block">
                        Category
                      </label>
                      <select
                        value={aiCategory}
                        onChange={(e) => setAiCategory(e.target.value as any)}
                        disabled={isGenerating}
                        className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-semibold text-slate-700 outline-none focus:border-brand-blue"
                      >
                        <option value="Technical">Tech & Coding</option>
                        <option value="Non-Technical">Business & Design</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-600 block">
                        Skill Level
                      </label>
                      <select
                        value={aiDifficulty}
                        onChange={(e) => setAiDifficulty(e.target.value as any)}
                        disabled={isGenerating}
                        className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-semibold text-slate-700 outline-none focus:border-brand-blue"
                      >
                        <option value="Beginner">Beginner (Easy)</option>
                        <option value="Intermediate">Intermediate</option>
                        <option value="Advanced">Advanced</option>
                      </select>
                    </div>
                  </div>

                  <div className="p-4 bg-blue-50/70 border border-blue-100 rounded-2xl text-xs text-slate-700 space-y-1">
                    <div className="font-semibold flex items-center gap-1.5 text-brand-blue-heading">
                      <ShieldCheck className="w-4 h-4 text-brand-blue" />
                      <span>What you will get:</span>
                    </div>
                    <p className="text-[12px] text-slate-600 leading-relaxed">
                      Simple step-by-step study notes and 15 practice quiz questions. Score 80% or higher to download your certificate.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={!aiTopic.trim() || isGenerating}
                    className="w-full py-3.5 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-2xl font-semibold text-sm shadow-md shadow-blue-500/20 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Building your lessons & quiz...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        <span>Create My Course</span>
                      </>
                    )}
                  </button>
                </form>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
