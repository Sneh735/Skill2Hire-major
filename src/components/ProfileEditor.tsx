import React, { useState, useRef, useEffect } from 'react';
import { User, updateProfile } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage, OperationType, handleFirestoreError } from '../lib/firebase';
import { Camera, Phone, User as UserIcon, Loader2, Check, FileText, Clock, GraduationCap, Lock, Sparkles, Linkedin, Github, AlertCircle } from 'lucide-react';
import { cn, getAvatarUrl } from '../lib/utils';

interface ProfileEditorProps {
  user: User;
  initialData?: any;
  onUpdate?: (updatedData: any) => void;
}

const compressImageToDataUrl = (file: File, maxSize = 256, quality = 0.82): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file.'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable.'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
};

const readFileAsDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
};

const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
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

export default function ProfileEditor({ user, initialData, onUpdate }: ProfileEditorProps) {
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [profileData, setProfileData] = useState({
    displayName: initialData?.displayName || user.displayName || '',
    bio: initialData?.bio || '',
    phoneNumber: initialData?.phoneNumber || '',
    education: initialData?.education || '',
    graduationDetails: initialData?.graduationDetails || '',
    dob: initialData?.dob || '',
    enrollmentPin: initialData?.enrollmentPin || '',
    linkedin: initialData?.linkedin || '',
    github: initialData?.github || '',
    resumeUrl: initialData?.resumeUrl || '',
    experience: initialData?.experience || 0,
    keySkills: initialData?.keySkills || [],
    photoURL: initialData?.photoURL || user.photoURL || ''
  });

  const [newSkill, setNewSkill] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedResumeName, setSelectedResumeName] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const [resumeUploading, setResumeUploading] = useState(false);

  const getWordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

  useEffect(() => {
    if (initialData) {
      setProfileData(prev => ({
        ...prev,
        ...initialData,
        photoURL: initialData.photoURL ?? prev.photoURL ?? user.photoURL ?? ''
      }));
    }
  }, [initialData, user]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setSaveError('Please select a valid image file (PNG, JPG, WebP).');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setSaveError('Image size must be less than 5MB.');
      e.target.value = '';
      return;
    }
    setSaveError(null);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  };

  const handleResumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
      setSaveError('Only PDF files are allowed for resume upload.');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setSaveError('Resume size must be less than 5MB.');
      e.target.value = '';
      return;
    }
    setSaveError(null);
    setSelectedResumeName(file.name);
  };

  const addSkill = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (newSkill.trim() && !profileData.keySkills.includes(newSkill.trim())) {
      setProfileData({
        ...profileData,
        keySkills: [...profileData.keySkills, newSkill.trim()]
      });
      setNewSkill('');
    }
  };

  const removeSkill = (skill: string) => {
    setProfileData({
      ...profileData,
      keySkills: profileData.keySkills.filter((s: string) => s !== skill)
    });
  };

  const handleSave = async () => {
    setSaveError(null);
    if (getWordCount(profileData.bio) > 250) {
      setSaveError('Bio exceeds 250 words limit.');
      return;
    }

    setLoading(true);
    try {
      let finalPhotoURL = profileData.photoURL;
      let finalResumeURL = profileData.resumeUrl;

      // Fast avatar handling: resize & compress client-side so saving is instant and reliable
      if (fileInputRef.current?.files?.[0]) {
        const file = fileInputRef.current.files[0];
        setUploading(true);
        try {
          finalPhotoURL = await compressImageToDataUrl(file, 256, 0.82);
        } finally {
          setUploading(false);
        }
      }

      // Fast resume upload with 5s timeout + small-PDF fallback
      if (resumeInputRef.current?.files?.[0]) {
        const file = resumeInputRef.current.files[0];
        setResumeUploading(true);
        try {
          const storageRef = ref(storage, `users/${user.uid}/resume.pdf`);
          await withTimeout(uploadBytes(storageRef, file), 5000, 'Resume upload');
          finalResumeURL = await withTimeout(getDownloadURL(storageRef), 3000, 'Resume URL');
        } catch {
          if (file.size <= 450 * 1024) {
            finalResumeURL = await readFileAsDataUrl(file);
          } else {
            setSaveError('Resume upload took too long for files over 450KB. Other profile changes were saved.');
          }
        } finally {
          setResumeUploading(false);
        }
      }

      const updatedFields = {
        displayName: profileData.displayName,
        bio: profileData.bio,
        phoneNumber: profileData.phoneNumber,
        education: profileData.education,
        graduationDetails: profileData.graduationDetails,
        dob: profileData.dob,
        enrollmentPin: profileData.enrollmentPin,
        linkedin: profileData.linkedin,
        github: profileData.github,
        resumeUrl: finalResumeURL,
        experience: profileData.experience,
        keySkills: profileData.keySkills,
        photoURL: finalPhotoURL,
        updatedAt: new Date().toISOString()
      };

      await setDoc(doc(db, 'users', user.uid), updatedFields, { merge: true });

      if (profileData.displayName && profileData.displayName !== user.displayName) {
        updateProfile(user, { displayName: profileData.displayName }).catch(() => {});
      }

      setProfileData(prev => ({
        ...prev,
        photoURL: finalPhotoURL,
        resumeUrl: finalResumeURL
      }));
      setPreviewUrl(null);
      setSelectedResumeName(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (resumeInputRef.current) resumeInputRef.current.value = '';

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      if (onUpdate) onUpdate({ ...initialData, ...updatedFields });
    } catch (error: any) {
      console.error('Profile update error:', error);
      setSaveError(error?.message || 'Failed to save profile changes. Please try again.');
      try {
        handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
      } catch {
        // Error already surfaced inline in UI
      }
    } finally {
      setLoading(false);
      setUploading(false);
      setResumeUploading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-10">
      {saveError && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-xs font-semibold text-rose-700 flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex flex-col md:flex-row items-center gap-10 bg-brand-blue/5 p-8 rounded-[32px] border border-brand-blue/10">
        <div className="relative group shrink-0">
          <div className="w-40 h-40 rounded-full overflow-hidden border-4 border-white shadow-2xl bg-white flex items-center justify-center relative">
            <img 
              src={previewUrl || getAvatarUrl(profileData.photoURL, profileData.displayName)} 
              alt="Avatar" 
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
            {uploading && (
              <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-brand-blue animate-spin" />
              </div>
            )}
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-all gap-2">
            <button 
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="bg-brand-blue w-10 h-10 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-110 transition-transform"
              title="Upload Photo"
            >
              <Camera className="w-5 h-5" />
            </button>
            {(profileData.photoURL || previewUrl) && (
              <button 
                type="button"
                onClick={() => {
                  setProfileData({ ...profileData, photoURL: '' });
                  setPreviewUrl(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="bg-red-500 w-10 h-10 rounded-full flex items-center justify-center text-white shadow-lg hover:scale-110 transition-transform"
                title="Reset to Avatar"
              >
                <div className="font-bold text-lg leading-none mt-[-2px]">×</div>
              </button>
            )}
          </div>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            className="hidden" 
            accept="image/*"
          />
        </div>
        <div className="flex-1 space-y-2 text-center md:text-left">
          <div className="inline-block px-3 py-1 bg-brand-blue/10 rounded-lg text-[11px] font-bold text-brand-blue uppercase tracking-widest mb-2">
            Candidate ID: {user.uid.slice(0, 8).toUpperCase()}
          </div>
          <h2 className="text-[36px] font-display font-bold text-brand-blue-heading leading-tight">{profileData.displayName || 'Learner'}</h2>
          <p className="text-brand-muted font-medium italic mb-4">"{profileData.bio.slice(0, 100)}{profileData.bio.length > 100 ? '...' : ''}"</p>
          
          <div className="flex flex-wrap justify-center md:justify-start gap-4">
            {profileData.linkedin && (
              <a href={profileData.linkedin.startsWith('http') ? profileData.linkedin : `https://${profileData.linkedin}`} target="_blank" rel="noopener noreferrer" className="p-2.5 bg-white rounded-xl border border-brand-border text-[#0077b5] hover:shadow-md transition-all hover:-translate-y-0.5">
                <Linkedin className="w-5 h-5" />
              </a>
            )}
            {profileData.github && (
              <a href={profileData.github.startsWith('http') ? profileData.github : `https://${profileData.github}`} target="_blank" rel="noopener noreferrer" className="p-2.5 bg-white rounded-xl border border-brand-border text-[#333] hover:shadow-md transition-all hover:-translate-y-0.5">
                <Github className="w-5 h-5" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        {/* Personal Details */}
        <div className="space-y-8">
          <h3 className="text-[14px] font-bold uppercase tracking-widest text-brand-blue-heading border-b border-brand-blue/10 pb-3">Personal Profile</h3>
          
          <div className="space-y-2">
            <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest flex items-center gap-2">
              <UserIcon className="w-3.5 h-3.5 text-brand-blue" />
              Full Name
            </label>
            <input 
              type="text" 
              value={profileData.displayName}
              onChange={(e) => setProfileData({ ...profileData, displayName: e.target.value })}
              className="w-full px-5 py-4 bg-brand-cream/30 border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue focus:ring-4 focus:ring-brand-blue/5 outline-none transition-all"
              placeholder="Your full name"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-brand-blue" />
              Resume Documentation
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button 
                type="button"
                onClick={() => resumeInputRef.current?.click()}
                className="px-6 py-3.5 bg-white border border-brand-border rounded-xl font-bold text-[11px] uppercase tracking-widest hover:border-brand-blue transition-all flex items-center gap-2 shadow-sm"
              >
                {resumeUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <FileText className="w-3.5 h-3.5"/>}
                {profileData.resumeUrl ? 'Update Document' : 'Upload PDF'}
              </button>
              {selectedResumeName && (
                <span className="text-[11px] font-semibold text-emerald-700 truncate max-w-[180px]">
                  Selected: {selectedResumeName}
                </span>
              )}
              {profileData.resumeUrl && !selectedResumeName && (
                <a 
                  href={profileData.resumeUrl} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="text-[11px] font-bold text-brand-blue hover:underline"
                >
                  View Current
                </a>
              )}
            </div>
            <input 
              type="file" 
              ref={resumeInputRef}
              onChange={handleResumeChange}
              className="hidden" 
              accept=".pdf"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-brand-blue" />
              Primary Contact
            </label>
            <input 
              type="tel" 
              value={profileData.phoneNumber}
              onChange={(e) => setProfileData({ ...profileData, phoneNumber: e.target.value })}
              className="w-full px-5 py-4 bg-brand-cream/30 border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue focus:ring-4 focus:ring-brand-blue/5 outline-none transition-all"
              placeholder="+91 98765 43210"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-brand-blue" />
              Experience Level (Years)
            </label>
            <input 
              type="number" 
              value={profileData.experience}
              onChange={(e) => setProfileData({ ...profileData, experience: parseInt(e.target.value) || 0 })}
              className="w-full px-5 py-4 bg-brand-cream/30 border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue focus:ring-4 focus:ring-brand-blue/5 outline-none transition-all"
              placeholder="0"
              min="0"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest flex items-center gap-2">
              <Lock className="w-3.5 h-3.5 text-brand-blue" />
              Course Enrollment Security PIN
            </label>
            <div className="relative">
              <input 
                type={showPin ? "text" : "password"} 
                value={profileData.enrollmentPin}
                onChange={(e) => setProfileData({ ...profileData, enrollmentPin: e.target.value })}
                className="w-full px-5 py-4 bg-brand-cream/30 border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue focus:ring-4 focus:ring-brand-blue/5 outline-none transition-all text-center tracking-[0.5em]"
                placeholder="••••••"
                maxLength={6}
              />
              <button 
                type="button"
                onClick={() => setShowPin(!showPin)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-brand-muted hover:text-brand-blue transition-colors px-2 py-1 text-[10px] font-bold"
              >
                {showPin ? 'HIDE' : 'SHOW'}
              </button>
            </div>
            <p className="text-[11px] font-medium text-brand-muted pl-1 italic">Used for curriculum authentication.</p>
          </div>
        </div>

        {/* Professional & Skills */}
        <div className="space-y-8">
          <h3 className="text-[14px] font-bold uppercase tracking-widest text-brand-blue-heading border-b border-brand-blue/10 pb-3">Expertise & Network</h3>
          
          <div className="space-y-2">
            <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest flex items-center gap-2">
              <GraduationCap className="w-3.5 h-3.5 text-brand-blue" />
              Academic Background
            </label>
            <input 
              type="text" 
              value={profileData.graduationDetails}
              onChange={(e) => setProfileData({ ...profileData, graduationDetails: e.target.value })}
              className="w-full px-5 py-4 bg-brand-cream/30 border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue focus:ring-4 focus:ring-brand-blue/5 outline-none transition-all"
              placeholder="B.Tech Computer Science, 2026"
            />
          </div>

          <div className="space-y-4">
            <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-brand-blue" />
              Core Competencies
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {profileData.keySkills.map((skill: string) => (
                <span key={skill} className="bg-brand-blue/10 text-brand-blue px-3 py-2 rounded-xl text-[11px] font-bold uppercase tracking-tight flex items-center gap-2 border border-brand-blue/20">
                  {skill}
                  <button type="button" onClick={() => removeSkill(skill)} className="hover:text-red-500 transition-colors text-lg leading-none">×</button>
                </span>
              ))}
              {profileData.keySkills.length === 0 && (
                <p className="text-[12px] text-brand-muted italic">No competencies added yet.</p>
              )}
            </div>
            <form onSubmit={addSkill} className="relative">
              <input 
                type="text" 
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                className="w-full px-5 py-4 bg-white border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue outline-none transition-all"
                placeholder="Add skill (e.g. React, UX Design)"
              />
              <button 
                type="submit"
                className="absolute right-2 top-1/2 -translate-y-1/2 bg-brand-blue text-white w-10 h-10 rounded-xl flex items-center justify-center hover:bg-brand-blue-dark transition-all shadow-md"
              >
                +
              </button>
            </form>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="text-[11px] font-bold text-brand-ink uppercase tracking-widest pl-1 flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-brand-blue" /> Professional Summary
              </label>
              <span className={cn(
                "text-[10px] font-bold",
                getWordCount(profileData.bio) > 250 ? "text-red-500" : "text-brand-muted"
              )}>
                {getWordCount(profileData.bio)}/250 Words
              </span>
            </div>
            <textarea 
              value={profileData.bio}
              onChange={(e) => setProfileData({ ...profileData, bio: e.target.value })}
              className="w-full px-5 py-4 bg-brand-cream/30 border border-brand-border rounded-2xl font-bold text-[14px] focus:border-brand-blue outline-none transition-all min-h-[160px] resize-none leading-relaxed"
              placeholder="Write a short summary about your skills and career goals..."
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-10 border-t border-brand-border/40">
        <button 
          type="button"
          onClick={handleSave}
          disabled={loading}
          className={cn(
            "px-12 py-5 rounded-full font-bold text-[15px] transition-all flex items-center gap-3",
            saveSuccess 
              ? "bg-emerald-500 text-white shadow-xl shadow-emerald-100" 
              : "bg-brand-blue text-white shadow-[0_20px_40px_-10px_rgba(26,110,245,0.4)] hover:bg-brand-blue-dark hover:scale-[1.05] active:scale-[0.98] disabled:opacity-50"
          )}
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Saving Changes...
            </>
          ) : saveSuccess ? (
            <>
              <Check className="w-5 h-5" />
              Profile Updated
            </>
          ) : (
            'Save Profile Changes'
          )}
        </button>
      </div>
    </div>
  );
}
