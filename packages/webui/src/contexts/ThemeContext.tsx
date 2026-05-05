import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

export type AccentColor = 'sky' | 'blue' | 'violet' | 'rose' | 'emerald' | 'amber' | 'orange';
export type Density = 'cozy' | 'compact';

export interface AccentSpec {
  id: AccentColor;
  label: string;
  swatch: string;
  light: { primary: string; ring: string; sidebarPrimary: string; sidebarRing: string };
  dark: { primary: string; ring: string; sidebarPrimary: string; sidebarRing: string };
}

export const ACCENTS: AccentSpec[] = [
  { id: 'sky', label: '天蓝', swatch: '#38bdf8',
    light: { primary: 'oklch(68.5% 0.155 230)', ring: 'oklch(68.5% 0.155 230)', sidebarPrimary: 'oklch(68.5% 0.155 230)', sidebarRing: 'oklch(68.5% 0.155 230)' },
    dark:  { primary: 'oklch(75% 0.14 230)',    ring: 'oklch(75% 0.14 230)',    sidebarPrimary: 'oklch(75% 0.14 230)',    sidebarRing: 'oklch(75% 0.14 230)' } },
  { id: 'blue', label: '靛蓝', swatch: '#3b82f6',
    light: { primary: 'oklch(60% 0.18 258)', ring: 'oklch(60% 0.18 258)', sidebarPrimary: 'oklch(60% 0.18 258)', sidebarRing: 'oklch(60% 0.18 258)' },
    dark:  { primary: 'oklch(70% 0.16 258)', ring: 'oklch(70% 0.16 258)', sidebarPrimary: 'oklch(70% 0.16 258)', sidebarRing: 'oklch(70% 0.16 258)' } },
  { id: 'violet', label: '紫罗兰', swatch: '#8b5cf6',
    light: { primary: 'oklch(60% 0.2 290)', ring: 'oklch(60% 0.2 290)', sidebarPrimary: 'oklch(60% 0.2 290)', sidebarRing: 'oklch(60% 0.2 290)' },
    dark:  { primary: 'oklch(72% 0.17 290)', ring: 'oklch(72% 0.17 290)', sidebarPrimary: 'oklch(72% 0.17 290)', sidebarRing: 'oklch(72% 0.17 290)' } },
  { id: 'rose', label: '玫瑰', swatch: '#f43f5e',
    light: { primary: 'oklch(63% 0.21 18)', ring: 'oklch(63% 0.21 18)', sidebarPrimary: 'oklch(63% 0.21 18)', sidebarRing: 'oklch(63% 0.21 18)' },
    dark:  { primary: 'oklch(72% 0.18 18)', ring: 'oklch(72% 0.18 18)', sidebarPrimary: 'oklch(72% 0.18 18)', sidebarRing: 'oklch(72% 0.18 18)' } },
  { id: 'emerald', label: '翡翠', swatch: '#10b981',
    light: { primary: 'oklch(64% 0.16 162)', ring: 'oklch(64% 0.16 162)', sidebarPrimary: 'oklch(64% 0.16 162)', sidebarRing: 'oklch(64% 0.16 162)' },
    dark:  { primary: 'oklch(74% 0.15 162)', ring: 'oklch(74% 0.15 162)', sidebarPrimary: 'oklch(74% 0.15 162)', sidebarRing: 'oklch(74% 0.15 162)' } },
  { id: 'amber', label: '琥珀', swatch: '#f59e0b',
    light: { primary: 'oklch(72% 0.17 70)', ring: 'oklch(72% 0.17 70)', sidebarPrimary: 'oklch(72% 0.17 70)', sidebarRing: 'oklch(72% 0.17 70)' },
    dark:  { primary: 'oklch(78% 0.16 70)', ring: 'oklch(78% 0.16 70)', sidebarPrimary: 'oklch(78% 0.16 70)', sidebarRing: 'oklch(78% 0.16 70)' } },
  { id: 'orange', label: '夕橙', swatch: '#f97316',
    light: { primary: 'oklch(67% 0.2 45)', ring: 'oklch(67% 0.2 45)', sidebarPrimary: 'oklch(67% 0.2 45)', sidebarRing: 'oklch(67% 0.2 45)' },
    dark:  { primary: 'oklch(74% 0.18 45)', ring: 'oklch(74% 0.18 45)', sidebarPrimary: 'oklch(74% 0.18 45)', sidebarRing: 'oklch(74% 0.18 45)' } },
];

export const RADIUS_OPTIONS = [
  { value: 0.375, label: '紧凑' },
  { value: 0.5, label: '默认' },
  { value: 0.75, label: '舒适' },
  { value: 1.0, label: '圆润' },
] as const;

export const POLL_INTERVAL_OPTIONS = [
  { value: 1000, label: '1 秒（实时）' },
  { value: 3000, label: '3 秒（默认）' },
  { value: 5000, label: '5 秒（节能）' },
  { value: 10000, label: '10 秒（省电）' },
  { value: 0, label: '已暂停' },
] as const;

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  accent: AccentColor;
  setAccent: (a: AccentColor) => void;
  radius: number;
  setRadius: (r: number) => void;
  density: Density;
  setDensity: (d: Density) => void;
  pollInterval: number;
  setPollInterval: (ms: number) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const LS = {
  mode: 'snowluma_theme',
  accent: 'snowluma_accent',
  radius: 'snowluma_radius',
  density: 'snowluma_density',
  poll: 'snowluma_poll_interval',
};

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readAccent(): AccentColor {
  const v = localStorage.getItem(LS.accent);
  if (v && ACCENTS.some((a) => a.id === v)) return v as AccentColor;
  return 'sky';
}
function readRadius(): number {
  const v = Number(localStorage.getItem(LS.radius));
  if (Number.isFinite(v) && v > 0 && v <= 2) return v;
  return 0.75;
}
function readDensity(): Density {
  return localStorage.getItem(LS.density) === 'compact' ? 'compact' : 'cozy';
}
function readPoll(): number {
  const raw = localStorage.getItem(LS.poll);
  if (raw === null) return 3000;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0 && v <= 60_000) return v;
  return 3000;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(LS.mode) as ThemeMode | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    return 'system';
  });
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);
  const [accent, setAccentState] = useState<AccentColor>(readAccent);
  const [radius, setRadiusState] = useState<number>(readRadius);
  const [density, setDensityState] = useState<Density>(readDensity);
  const [pollInterval, setPollIntervalState] = useState<number>(readPoll);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'system' ? systemTheme : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(resolved);
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved;
  }, [resolved]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);

  useEffect(() => {
    const styleId = 'snowluma-theme-overrides';
    let el = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = styleId;
      document.head.appendChild(el);
    }
    const spec = ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0];
    el.textContent = `
:root {
  --radius: ${radius}rem;
  --primary: ${spec.light.primary};
  --ring: ${spec.light.ring};
  --sidebar-primary: ${spec.light.sidebarPrimary};
  --sidebar-ring: ${spec.light.sidebarRing};
}
.dark {
  --primary: ${spec.dark.primary};
  --ring: ${spec.dark.ring};
  --sidebar-primary: ${spec.dark.sidebarPrimary};
  --sidebar-ring: ${spec.dark.sidebarRing};
}
`.trim();
  }, [accent, radius]);

  const setMode = (m: ThemeMode) => { setModeState(m); localStorage.setItem(LS.mode, m); };
  const setAccent = (a: AccentColor) => { setAccentState(a); localStorage.setItem(LS.accent, a); };
  const setRadius = (r: number) => { setRadiusState(r); localStorage.setItem(LS.radius, String(r)); };
  const setDensity = (d: Density) => { setDensityState(d); localStorage.setItem(LS.density, d); };
  const setPollInterval = (ms: number) => { setPollIntervalState(ms); localStorage.setItem(LS.poll, String(ms)); };

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode, accent, setAccent, radius, setRadius, density, setDensity, pollInterval, setPollInterval }),
    [mode, resolved, accent, radius, density, pollInterval],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
