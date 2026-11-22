import React, { useState, useMemo } from 'react';
import { 
  JobPosting, 
  StudentUser, 
  FilterOptions, 
  CareerQuizPreferences,
  UserRole,
  Course
} from '../types';
import { INITIAL_JOBS } from '../data/mockJobs';
import { JobFilters } from './career2skill/JobFilters';
import { JobCard } from './career2skill/JobCard';
import { JobDetailModal } from './career2skill/JobDetailModal';
import { AiSkillMatcher } from './career2skill/AiSkillMatcher';
import { PoliciesAndFounderModal } from './career2skill/PoliciesAndFounderModal';
import { ChatGptCareerQuiz } from './career2skill/ChatGptCareerQuiz';
import { LandingAuthPage } from './career2skill/LandingAuthPage';
import MockInterview from './MockInterview';
import { 
  ShieldCheck, 
  Sparkles, 
  Briefcase, 
  Bot, 
  X, 
  CheckCircle2, 
  MessageSquare,
  Settings,
  LogOut
} from 'lucide-react';
import { cn } from '../lib/utils';

interface Career2SkillDashboardProps {
  currentUserProfile?: any;
  userRole?: UserRole;
  userEmail?: string;
  userName?: string;
  onUpdateProfile?: (updated: any) => void;
  userSkills?: string[];
  completedCourses?: string[];
  onNavigateToCourse?: () => void;
  onViewCourse?: (course: Course) => void;
  courses?: Course[];
  onOpenSettings?: () => void;
}

export default function Career2SkillDashboard({
  currentUserProfile,
  userRole = 'student',
  userEmail = '',
  userName = 'Learner',
  onUpdateProfile,
  userSkills = ['JavaScript', 'React', 'Python', 'SQL'],
  completedCourses = [],
  onNavigateToCourse,
  onViewCourse,
  courses = [],
  onOpenSettings
}: Career2SkillDashboardProps) {
  const sessionKey = `career2skill_session_${currentUserProfile?.uid || userEmail || 'guest'}`;

  const [career2SkillUser, setCareer2SkillUser] = useState<StudentUser | null>(() => {
    try {
      const saved = sessionStorage.getItem(sessionKey);
      return saved ? (JSON.parse(saved) as StudentUser) : null;
    } catch {
      return null;
    }
  });

  // Active student profile (merged with Career2Skill login details)
  const activeStudent: StudentUser = useMemo(() => {
    if (career2SkillUser) {
      return {
        ...career2SkillUser,
        skills: currentUserProfile?.keySkills?.length ? currentUserProfile.keySkills : career2SkillUser.skills,
        role: userRole
      };
    }
    return {
      id: currentUserProfile?.uid || 'user-1',
      name: currentUserProfile?.displayName || userName || 'Learner',
      email: currentUserProfile?.email || userEmail || '',
      college: currentUserProfile?.education || 'Engineering Institute',
      branch: (currentUserProfile?.graduationDetails?.includes('AIDS') ? 'AIDS' : 
              currentUserProfile?.graduationDetails?.includes('IT') ? 'IT' : 
              currentUserProfile?.graduationDetails?.includes('EC') ? 'EC' : 
              currentUserProfile?.graduationDetails?.includes('Data') ? 'Data Science' : 'CSE'),
      graduationYear: currentUserProfile?.dob || '2026',
      skills: currentUserProfile?.keySkills?.length ? currentUserProfile.keySkills : ['JavaScript', 'React', 'Python', 'SQL'],
      role: userRole
    };
  }, [career2SkillUser, currentUserProfile, userRole, userEmail, userName]);

  const [currentTab, setCurrentTab] = useState<'quiz' | 'skill-match' | 'mock-interview' | 'jobs'>('quiz');
  const jobs = INITIAL_JOBS;
  const [selectedJob, setSelectedJob] = useState<JobPosting | null>(null);
  const [isPoliciesModalOpen, setIsPoliciesModalOpen] = useState(false);
  const [policiesModalTab, setPoliciesModalTab] = useState<'policies' | 'founder'>('policies');
  const [quizPreferences, setQuizPreferences] = useState<CareerQuizPreferences | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Filter State
  const [filters, setFilters] = useState<FilterOptions>({
    searchQuery: '',
    roleType: 'All',
    opportunityType: 'All',
    location: 'All Locations',
    selectedBranch: 'All',
    certificateOnly: false,
    minVacancies: 0,
  });

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const handleApplyIndeed = (job: JobPosting) => {
    window.open(job.indeedUrl, '_blank', 'noopener,noreferrer');
    showToast(`Redirecting to Indeed for ${job.title} at ${job.company}`);
  };

  const openPolicies = (tab: 'policies' | 'founder' = 'policies') => {
    setPoliciesModalTab(tab);
    setIsPoliciesModalOpen(true);
  };

  const handleQuizComplete = (prefs: CareerQuizPreferences) => {
    setQuizPreferences(prefs);
    setFilters((prev) => ({
      ...prev,
      roleType: prefs.roleType,
      opportunityType: prefs.opportunityType,
      location: prefs.location,
      certificateOnly: prefs.certificateRequired,
      selectedBranch: activeStudent.branch,
    }));
    setCurrentTab('jobs');
    showToast('Dashboard filtered based on your quiz answers!');
  };

  const handleClearQuizPreferences = () => {
    setQuizPreferences(null);
    setFilters({
      searchQuery: '',
      roleType: 'All',
      opportunityType: 'All',
      location: 'All Locations',
      selectedBranch: 'All',
      certificateOnly: false,
      minVacancies: 0,
    });
    showToast('Reset to all verified fresher roles.');
  };

  const handleCareer2SkillLogin = (loggedUser: StudentUser) => {
    setCareer2SkillUser(loggedUser);
    try {
      sessionStorage.setItem(sessionKey, JSON.stringify(loggedUser));
    } catch {
      // ignore storage errors
    }
    setCurrentTab('quiz');
    showToast(`Welcome to Career2Skill, ${loggedUser.name}!`);
  };

  const handleCareer2SkillLogout = () => {
    setCareer2SkillUser(null);
    try {
      sessionStorage.removeItem(sessionKey);
    } catch {
      // ignore storage errors
    }
  };

  // Filtered Jobs Computation
  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (filters.searchQuery.trim()) {
        const q = filters.searchQuery.toLowerCase();
        const matchesTitle = job.title.toLowerCase().includes(q);
        const matchesCompany = job.company.toLowerCase().includes(q);
        const matchesSkills = job.keySkills.some((s) => s.toLowerCase().includes(q));
        const matchesDesc = job.description.toLowerCase().includes(q);
        if (!matchesTitle && !matchesCompany && !matchesSkills && !matchesDesc) {
          return false;
        }
      }
      if (filters.roleType !== 'All' && job.roleType !== filters.roleType) return false;
      if (filters.opportunityType !== 'All' && job.opportunityType !== filters.opportunityType) return false;
      if (filters.location !== 'All Locations' && !job.location.toLowerCase().includes(filters.location.toLowerCase())) return false;
      if (filters.selectedBranch !== 'All' && !job.targetBranches.includes(filters.selectedBranch)) return false;
      if (filters.certificateOnly && !job.hasCertificateOfCompletion) return false;
      return true;
    });
  }, [jobs, filters]);

  if (!career2SkillUser) {
    return (
      <div className="space-y-6">
        <LandingAuthPage
          embedded
          initialName={currentUserProfile?.displayName || userName}
          initialEmail={currentUserProfile?.email || userEmail}
          onLoginSuccess={handleCareer2SkillLogin}
          onOpenPoliciesModal={() => openPolicies('policies')}
        />
        <PoliciesAndFounderModal
          isOpen={isPoliciesModalOpen}
          onClose={() => setIsPoliciesModalOpen(false)}
          defaultTab={policiesModalTab}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-slate-900 text-white text-xs px-4 py-3 rounded-xl shadow-xl flex items-center gap-2 border border-slate-700 animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top Hero Banner */}
      <div className="bg-gradient-to-r from-indigo-700 via-blue-700 to-indigo-900 rounded-[32px] p-8 md:p-10 text-white relative overflow-hidden shadow-xl shadow-indigo-600/10">
        <div className="absolute right-0 top-0 bottom-0 w-96 bg-white/5 rounded-full blur-3xl pointer-events-none" />
        
        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="space-y-3 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-white/10 rounded-full text-xs font-bold uppercase tracking-wider backdrop-blur-md">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-300" />
              <span className="text-sky-200">Career2Skill · 100% Genuine Fresher & PPO Portal</span>
            </div>
            
            <h1 className="text-3xl md:text-4xl font-display font-extrabold tracking-tight text-sky-300">
              {userRole === 'employee' ? 'Employer & Recruiter Portal' : 'Career2Skill'}
            </h1>
            
            <p className="text-white/85 text-sm md:text-base leading-relaxed font-medium">
              {userRole === 'employee' 
                ? 'Post corporate internships with PPO, recruit validated pre-final & final year talent, and manage campus placements.'
                : 'Direct Indeed-verified jobs, internship-to-PPO conversions, AI resume match checks, and genuine company email verifications.'
              }
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">

            <button
              onClick={() => setCurrentTab('quiz')}
              className="px-5 py-3.5 bg-indigo-500/30 hover:bg-indigo-500/40 text-white border border-white/20 rounded-2xl font-bold text-xs uppercase tracking-wider backdrop-blur-md flex items-center gap-2 transition-all active:scale-95"
            >
              <Bot className="w-4 h-4 text-amber-300" />
              <span>Career Quiz</span>
            </button>

            <button
              onClick={handleCareer2SkillLogout}
              className="px-4 py-3.5 bg-white/10 hover:bg-white/20 text-white border border-white/20 rounded-2xl font-bold text-xs uppercase tracking-wider backdrop-blur-md flex items-center gap-2 transition-all active:scale-95"
              title="Sign out of Career2Skill Portal"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>

        {/* Quick Highlights Strip */}
        <div className="mt-8 pt-6 border-t border-white/15 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <div className="text-2xl font-extrabold font-display">{jobs.length}+</div>
            <div className="text-xs text-white/70">Genuine Fresher Openings</div>
          </div>
          <div>
            <div className="text-2xl font-extrabold font-display">₹45k/mo</div>
            <div className="text-xs text-white/70">Avg. PPO Stipend</div>
          </div>
          <div>
            <div className="text-2xl font-extrabold font-display">100% Free</div>
            <div className="text-xs text-white/70">Zero Placement Fees</div>
          </div>
          <div>
            <div className="text-2xl font-extrabold font-display">5 Branches</div>
            <div className="text-xs text-white/70">CSE · AIDS · IT · EC · DS</div>
          </div>
        </div>
      </div>

      {/* Internal Sub-Nav Tabs */}
      <div className="flex flex-wrap items-center gap-2 bg-white p-2.5 rounded-2xl border border-brand-border/60 shadow-sm">
        {[
          { id: 'quiz', label: '1. Career Quiz', icon: Bot },
          { id: 'skill-match', label: '2. Job Skill Match', icon: Sparkles },
          { id: 'mock-interview', label: '3. Mock Interview Prep', icon: MessageSquare },
          { id: 'jobs', label: 'Verified Openings', icon: Briefcase }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setCurrentTab(tab.id as any)}
            className={cn(
              "flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-xs tracking-tight transition-all",
              currentTab === tab.id
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-200"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            )}
          >
            <tab.icon className="w-4 h-4" />
            <span>{tab.label}</span>
          </button>
        ))}

        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="ml-auto flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-xs tracking-tight text-slate-600 hover:text-indigo-700 hover:bg-indigo-50 transition-all"
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>
        )}
      </div>

      {/* Tab 1: Jobs List */}
      {currentTab === 'jobs' && (
        <div className="space-y-6">
          {/* Quiz Preference Banner */}
          {quizPreferences && (
            <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-indigo-600 text-white rounded-xl shrink-0">
                  <Bot className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-indigo-950 flex items-center gap-2">
                    <span>Quiz Recommendations Applied</span>
                    <span className="text-[10px] bg-indigo-200/80 text-indigo-800 px-2 py-0.5 rounded-full font-mono">
                      {activeStudent.branch} Stream
                    </span>
                  </div>
                  <div className="text-xs text-indigo-800 mt-0.5">
                    Filtered for: <strong>{quizPreferences.roleType}</strong> roles ·{' '}
                    <strong>{quizPreferences.opportunityType}</strong> ·{' '}
                    <strong>{quizPreferences.location}</strong>
                    {quizPreferences.certificateRequired && ' · Certificate Required'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setCurrentTab('quiz')}
                  className="text-xs font-bold text-indigo-700 hover:text-indigo-900 bg-white px-3.5 py-1.5 rounded-xl border border-indigo-200 transition-colors shadow-2xs"
                >
                  Tweak Quiz
                </button>
                <button
                  onClick={handleClearQuizPreferences}
                  className="text-xs text-slate-500 hover:text-slate-800 p-1.5 transition-colors"
                  title="Clear quiz filters and show all"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Structured Job Filters */}
          <JobFilters
            filters={filters}
            setFilters={setFilters}
            totalJobsCount={jobs.length}
            filteredJobsCount={filteredJobs.length}
          />

          {/* Listings Grid */}
          {filteredJobs.length === 0 ? (
            <div className="bg-white rounded-3xl border border-slate-200 p-12 text-center max-w-lg mx-auto shadow-2xs my-8">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
                <Briefcase className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-slate-900 mb-1">
                No Verified Roles Match This Specific Combination
              </h3>
              <p className="text-xs text-slate-500 mb-4 leading-relaxed">
                Try broadening your location, opportunity type, or resetting filters.
              </p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={handleClearQuizPreferences}
                  className="px-4 py-2 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-xl transition-colors"
                >
                  Reset All Filters
                </button>
                <button
                  onClick={() => setCurrentTab('quiz')}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-colors"
                >
                  Retake Quiz
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {filteredJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onSelect={(j) => setSelectedJob(j)}
                  onApplyIndeed={handleApplyIndeed}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Job Skill Match */}
      {currentTab === 'skill-match' && (
        <AiSkillMatcher
          jobs={jobs}
          onSelectJob={(j) => setSelectedJob(j)}
          defaultSkills={userSkills}
        />
      )}

      {/* Tab 1: Career Quiz */}
      {currentTab === 'quiz' && (
        <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold text-indigo-400 uppercase tracking-wider">
                <Bot className="w-4 h-4 text-amber-300" />
                <span>Conversational Career Profiler</span>
              </div>
              <h2 className="text-lg font-bold mt-1">Career Quiz</h2>
            </div>
            <button
              onClick={() => setCurrentTab('skill-match')}
              className="text-xs text-slate-400 hover:text-white underline font-semibold"
            >
              Go to Job Skill Match
            </button>
          </div>
          <ChatGptCareerQuiz
            currentUser={activeStudent}
            onQuizComplete={handleQuizComplete}
            onSkip={() => setCurrentTab('skill-match')}
          />
        </div>
      )}

      {/* Tab 3: Mock Interview Prep */}
      {currentTab === 'mock-interview' && (
        <div className="space-y-6">
          <MockInterview />
        </div>
      )}

      {/* Modals */}
      {selectedJob && (
        <JobDetailModal
          job={selectedJob}
          currentUser={activeStudent}
          onClose={() => setSelectedJob(null)}
          onOpenAuth={() => {}}
        />
      )}

      <PoliciesAndFounderModal
        isOpen={isPoliciesModalOpen}
        onClose={() => setIsPoliciesModalOpen(false)}
        defaultTab={policiesModalTab}
      />
    </div>
  );
}
