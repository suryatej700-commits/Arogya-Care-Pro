import { useCallback, useEffect, useState } from 'react';
import { Layout } from './components/Layout';
import { TRANSLATIONS } from './i18n/translations';
import { CropInsightsPage } from './pages/CropInsightsPage';
import { KnowledgeHubPage } from './pages/KnowledgeHubPage';
import { OverviewPage } from './pages/OverviewPage';
import { ResultPage } from './pages/ResultPage';
import { ScanCropPage } from './pages/ScanCropPage';
import { ScanHistoryPage } from './pages/ScanHistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import {
  AppRoute,
  CropType,
  FarmerProfile,
  GuidanceFeedbackOption,
  Language,
  SavedScan,
  TranslatedGuidanceFields,
} from './types/agritech';
import {
  clearAllLocalData,
  createDemoScans,
  DEFAULT_PROFILE,
  loadChecklistState,
  loadProfile,
  loadScans,
  saveChecklistState,
  saveProfile,
  saveScans,
} from './utils/storage';

const VALID_ROUTES = new Set<AppRoute>([
  'overview',
  'scan',
  'result',
  'history',
  'insights',
  'knowledge',
  'settings',
]);

const ACTIVE_SCAN_SESSION_KEY = 'arogya_care_pro_active_scan_id';

function getInitialRoute(): AppRoute {
  const hash = window.location.hash.replace('#', '') as AppRoute;
  return VALID_ROUTES.has(hash) ? hash : 'overview';
}

function getInitialActiveScan(initialScans: SavedScan[]): SavedScan | null {
  try {
    const savedId = sessionStorage.getItem(ACTIVE_SCAN_SESSION_KEY);
    if (!savedId) return null;
    return initialScans.find((s) => s.id === savedId) ?? null;
  } catch {
    return null;
  }
}

export default function App() {
  const [profile, setProfile] = useState<FarmerProfile>(() => loadProfile());
  const [scans, setScans] = useState<SavedScan[]>(() => loadScans());
  const [checklistState, setChecklistState] = useState<Record<string, boolean>>(() =>
    loadChecklistState()
  );
  const [activeRoute, setActiveRoute] = useState<AppRoute>(() => getInitialRoute());
  const [preselectedCrop, setPreselectedCrop] = useState<CropType | undefined>(undefined);
  const [activeScan, setActiveScan] = useState<SavedScan | null>(() =>
    getInitialActiveScan(loadScans())
  );

  const t = TRANSLATIONS[profile.language];

  useEffect(() => {
    document.documentElement.lang = profile.language;
  }, [profile.language]);

  useEffect(() => {
    const onHashChange = () => {
      const next = getInitialRoute();
      setActiveRoute(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (route: AppRoute, cropToPreselect?: CropType) => {
    if (cropToPreselect) {
      setPreselectedCrop(cropToPreselect);
    } else if (route !== 'scan') {
      setPreselectedCrop(undefined);
    }
    setActiveRoute(route);
    if (window.location.hash !== `#${route}`) {
      window.location.hash = route;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleUpdateProfile = useCallback((updated: FarmerProfile) => {
    setProfile(updated);
    saveProfile(updated);
  }, []);

  const handleLanguageChange = useCallback((language: Language) => {
    setProfile((prev) => {
      if (prev.language === language) return prev;
      const next = { ...prev, language };
      saveProfile(next);
      return next;
    });
  }, []);

  const handleUpdateName = useCallback((name: string) => {
    setProfile((prev) => {
      const next = { ...prev, name };
      saveProfile(next);
      return next;
    });
  }, []);

  const handleAnalysisComplete = (draftScan: SavedScan) => {
    setActiveScan(draftScan);
    try {
      sessionStorage.setItem(ACTIVE_SCAN_SESSION_KEY, draftScan.id);
    } catch {
      // ignore sessionStorage failure
    }
    navigate('result');
  };

  const handleSaveScan = (scanToSave: SavedScan) => {
    setScans((prev) => {
      if (prev.some((s) => s.id === scanToSave.id)) return prev;
      const next = [scanToSave, ...prev];
      saveScans(next);
      return next;
    });
    try {
      sessionStorage.setItem(ACTIVE_SCAN_SESSION_KEY, scanToSave.id);
    } catch {
      // ignore sessionStorage failure
    }
  };

  const handleCacheTranslation = useCallback(
    (scanId: string, targetLanguage: Language, translated: TranslatedGuidanceFields) => {
      setActiveScan((prev) => {
        if (!prev || prev.id !== scanId) return prev;
        return {
          ...prev,
          translations: {
            ...(prev.translations ?? {}),
            [targetLanguage]: translated,
          },
        };
      });

      setScans((prev) => {
        let modified = false;
        const next = prev.map((s) => {
          if (s.id !== scanId) return s;
          modified = true;
          return {
            ...s,
            translations: {
              ...(s.translations ?? {}),
              [targetLanguage]: translated,
            },
          };
        });
        if (modified) saveScans(next);
        return next;
      });
    },
    []
  );

  const handleSaveFeedback = (scanId: string, feedback: GuidanceFeedbackOption) => {
    let updatedScanSnapshot: SavedScan | null = null;

    setActiveScan((prev) => {
      if (!prev || prev.id !== scanId) return prev;
      updatedScanSnapshot = { ...prev, feedback };
      return updatedScanSnapshot;
    });

    setScans((prev) => {
      const exists = prev.some((s) => s.id === scanId);
      let next: SavedScan[];
      if (exists) {
        next = prev.map((s) => (s.id === scanId ? { ...s, feedback } : s));
      } else if (updatedScanSnapshot) {
        next = [updatedScanSnapshot, ...prev];
      } else {
        return prev;
      }
      saveScans(next);
      return next;
    });
  };

  const handleSelectSavedScan = (scan: SavedScan) => {
    setActiveScan(scan);
    try {
      sessionStorage.setItem(ACTIVE_SCAN_SESSION_KEY, scan.id);
    } catch {
      // ignore sessionStorage failure
    }
    navigate('result');
  };

  const handleDeleteScan = (id: string) => {
    setScans((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveScans(next);
      return next;
    });
    if (activeScan?.id === id) {
      setActiveScan(null);
      try {
        sessionStorage.removeItem(ACTIVE_SCAN_SESSION_KEY);
      } catch {
        // ignore sessionStorage failure
      }
    }
  };

  const handleToggleChecklist = (id: string) => {
    setChecklistState((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveChecklistState(next);
      return next;
    });
  };

  const handleLoadDemoData = () => {
    const demo = createDemoScans();
    setScans(demo);
    saveScans(demo);
  };

  const handleResetAllData = () => {
    clearAllLocalData();
    try {
      sessionStorage.removeItem(ACTIVE_SCAN_SESSION_KEY);
    } catch {
      // ignore sessionStorage failure
    }
    setProfile(DEFAULT_PROFILE);
    setScans([]);
    setChecklistState({});
    setActiveScan(null);
  };

  const isActiveScanSaved = Boolean(activeScan && scans.some((s) => s.id === activeScan.id));

  return (
    <Layout
      activeRoute={activeRoute}
      onNavigate={navigate}
      profile={profile}
      onLanguageChange={handleLanguageChange}
      t={t}
    >
      {activeRoute === 'overview' ? (
        <OverviewPage
          profile={profile}
          onUpdateName={handleUpdateName}
          scans={scans}
          onNavigate={navigate}
          onSelectScan={handleSelectSavedScan}
          onLoadDemoData={handleLoadDemoData}
          t={t}
        />
      ) : null}

      {activeRoute === 'scan' ? (
        <ScanCropPage
          language={profile.language}
          t={t}
          initialCrop={preselectedCrop}
          onAnalysisComplete={handleAnalysisComplete}
          onNavigate={navigate}
        />
      ) : null}

      {activeRoute === 'result' ? (
        <ResultPage
          scan={activeScan}
          isSaved={isActiveScanSaved}
          language={profile.language}
          t={t}
          onSaveScan={handleSaveScan}
          onCacheTranslation={handleCacheTranslation}
          onSaveFeedback={handleSaveFeedback}
          onNavigate={navigate}
        />
      ) : null}

      {activeRoute === 'history' ? (
        <ScanHistoryPage
          scans={scans}
          language={profile.language}
          t={t}
          onSelectScan={handleSelectSavedScan}
          onDeleteScan={handleDeleteScan}
          onNavigate={navigate}
        />
      ) : null}

      {activeRoute === 'insights' ? (
        <CropInsightsPage
          scans={scans}
          language={profile.language}
          checklistState={checklistState}
          onToggleChecklist={handleToggleChecklist}
          onNavigate={navigate}
          t={t}
        />
      ) : null}

      {activeRoute === 'knowledge' ? (
        <KnowledgeHubPage language={profile.language} t={t} />
      ) : null}

      {activeRoute === 'settings' ? (
        <SettingsPage
          profile={profile}
          onSaveProfile={handleUpdateProfile}
          onResetAllData={handleResetAllData}
          t={t}
        />
      ) : null}
    </Layout>
  );
}
