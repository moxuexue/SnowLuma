import { useCallback, useEffect, useRef, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { LoginPage } from '@/components/pages/login-page';
import { MainLayout } from '@/components/layout/main-layout';
import { OverviewPage } from '@/components/pages/overview-page';
import { ConfigPage } from '@/components/pages/config-page';
import { LogsPage } from '@/components/pages/logs-page';
import { SettingsPage } from '@/components/pages/settings-page';
import { ChangePasswordPage, type PasswordRule } from '@/components/pages/change-password-page';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { Page } from '@/components/layout/sidebar';
import type { HookProcessInfo, OneBotConfig, QQInfo, SystemInfo } from '@/types';

const TOKEN_KEY = 'snowluma_token';

function readToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

function AppInner() {
  const { pollInterval } = useTheme();
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [status, setStatus] = useState('未连接');
  const [active, setActive] = useState<Page>('overview');

  const [qqList, setQqList] = useState<QQInfo[]>([]);
  const [processList, setProcessList] = useState<HookProcessInfo[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  const [processLoadingPid, setProcessLoadingPid] = useState<number | null>(null);
  const [processUnloadingPid, setProcessUnloadingPid] = useState<number | null>(null);
  const [processRefreshingPid, setProcessRefreshingPid] = useState<number | null>(null);
  const [processActionStatus, setProcessActionStatus] = useState('');
  const [unloadFailedAlert, setUnloadFailedAlert] = useState<{ pid: number; error: string } | null>(null);
  // Tracks PIDs with an in-flight load/unload/refresh request so the UI can
  // collapse spam-clicks instead of firing a second concurrent request.
  const inflightProcessOps = useRef(new Set<number>());

  const [selectedUin, setSelectedUin] = useState<string | null>(null);
  const [config, setConfig] = useState<OneBotConfig | null>(null);
  const [saveStatus, setSaveStatus] = useState('');

  const tokenRef = useRef(readToken());

  // ---------- API helpers ----------
  const fetchApi = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> | undefined),
    };
    if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      tokenRef.current = '';
      localStorage.removeItem(TOKEN_KEY);
      setAuthed(false);
      setStatus('未授权');
    }
    return res;
  }, []);

  // ---------- Polling ----------
  const refreshQqList = useCallback(async () => {
    try {
      const res = await fetchApi('/api/qq-list');
      if (!res.ok) return;
      const data = await res.json();
      setQqList(data.list || []);
    } catch (e) {
      console.error('qq-list', e);
    }
  }, [fetchApi]);

  const refreshProcesses = useCallback(async () => {
    try {
      const res = await fetchApi('/api/processes');
      if (!res.ok) return;
      const data = await res.json();
      setProcessList(data.list || []);
    } catch (e) {
      console.error('processes', e);
    }
  }, [fetchApi]);

  const refreshSystem = useCallback(async () => {
    try {
      const res = await fetchApi('/api/system');
      if (!res.ok) return;
      const data = (await res.json()) as SystemInfo;
      setSystemInfo(data);
    } catch (e) {
      console.error('system', e);
    }
  }, [fetchApi]);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetchApi('/api/status');
      if (res.ok) {
        setAuthed(true);
        setStatus('已连接');
        return true;
      }
      setStatus('未连接');
      return false;
    } catch {
      setStatus('未连接');
      return false;
    }
  }, [fetchApi]);

  useEffect(() => {
    (async () => {
      if (tokenRef.current) {
        const ok = await checkStatus();
        if (ok) {
          // Existing session may still need to change password.
          try {
            const r = await fetchApi('/api/auth/state');
            if (r.ok) {
              const d = await r.json();
              setMustChange(!!d.mustChangePassword);
            }
          } catch { /* ignore */ }
        }
      }
      setAuthChecked(true);
    })();
  }, [checkStatus, fetchApi]);

  useEffect(() => {
    if (!authed || mustChange) return;
    if (pollInterval <= 0) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshQqList(), refreshProcesses(), refreshSystem()]);
    };
    tick();
    const interval = setInterval(tick, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [authed, mustChange, pollInterval, refreshQqList, refreshProcesses, refreshSystem]);

  // Auto-select first uin when navigating to config
  useEffect(() => {
    if (active !== 'config') return;
    if (!selectedUin && qqList.length > 0) setSelectedUin(qqList[0].uin);
  }, [active, qqList, selectedUin]);

  // Load config when selectedUin changes
  useEffect(() => {
    if (!selectedUin) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchApi(`/api/config/${encodeURIComponent(selectedUin)}`);
        if (!res.ok) return;
        const data = await res.json();
        const loaded = data?.config ?? data;
        if (cancelled) return;
        const nets = loaded?.networks ?? {};
        const legacyFormat = loaded?.messageFormat === 'string' ? 'string' : 'array';
        const legacyReport = !!loaded?.reportSelfMessage;
        const normalizeNetwork = <T extends Record<string, unknown>>(item: T) => ({
          ...item,
          messageFormat: item.messageFormat === 'string' ? 'string' : legacyFormat,
          reportSelfMessage:
            typeof item.reportSelfMessage === 'boolean' ? item.reportSelfMessage : legacyReport,
        });
        setConfig({
          networks: {
            httpServers: Array.isArray(nets.httpServers) ? nets.httpServers.map(normalizeNetwork) : [],
            httpClients: Array.isArray(nets.httpClients) ? nets.httpClients.map(normalizeNetwork) : [],
            wsServers: Array.isArray(nets.wsServers) ? nets.wsServers.map(normalizeNetwork) : [],
            wsClients: Array.isArray(nets.wsClients) ? nets.wsClients.map(normalizeNetwork) : [],
          },
          musicSignUrl: loaded?.musicSignUrl,
        });
      } catch (e) {
        console.error('load-config', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedUin, fetchApi]);

  // ---------- Actions ----------
  const handleLogin = useCallback(async (password: string) => {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { success: false, error: data.message || data.error || '令牌错误' };
      }
      const data = await res.json();
      const token = data.token as string;
      localStorage.setItem(TOKEN_KEY, token);
      tokenRef.current = token;
      setMustChange(!!data.mustChangePassword);
      const ok = await checkStatus();
      return ok ? { success: true } : { success: false, error: '校验失败' };
    } catch (e) {
      return { success: false, error: (e as Error).message || '网络错误' };
    }
  }, [checkStatus]);

  const handleLogout = useCallback(async () => {
    try { await fetchApi('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    localStorage.removeItem(TOKEN_KEY);
    tokenRef.current = '';
    setAuthed(false);
    setMustChange(false);
    setStatus('未连接');
    setQqList([]);
    setProcessList([]);
    setSystemInfo(null);
    setSelectedUin(null);
    setConfig(null);
  }, [fetchApi]);

  const handleLoadProcess = useCallback(async (pid: number) => {
    if (inflightProcessOps.current.has(pid)) return;
    inflightProcessOps.current.add(pid);
    setProcessLoadingPid(pid);
    setProcessActionStatus(`正在向进程 ${pid} 加载 SnowLuma…`);
    try {
      const res = await fetchApi(`/api/processes/${pid}/load`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || '加载失败');
      setProcessActionStatus(`已向进程 ${pid} 注入 SnowLuma，等待管道连接…`);
      await refreshProcesses();
    } catch (e) {
      setProcessActionStatus(`加载失败：${(e as Error).message}`);
    } finally {
      inflightProcessOps.current.delete(pid);
      setProcessLoadingPid(null);
      setTimeout(() => setProcessActionStatus(''), 4000);
    }
  }, [fetchApi, refreshProcesses]);

  const handleUnloadProcess = useCallback(async (pid: number) => {
    if (inflightProcessOps.current.has(pid)) return;
    inflightProcessOps.current.add(pid);
    setProcessUnloadingPid(pid);
    setProcessActionStatus(`正在从进程 ${pid} 卸载…`);
    try {
      const res = await fetchApi(`/api/processes/${pid}/unload`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || '卸载失败');
      
      // Check if unload actually failed (pipe still exists)
      if (data.process?.status === 'connecting' && data.process?.error) {
        setUnloadFailedAlert({ pid, error: data.process.error });
        setProcessActionStatus(`进程 ${pid} 卸载失败`);
      } else {
        setProcessActionStatus(`已从进程 ${pid} 卸载`);
      }
      
      await refreshProcesses();
    } catch (e) {
      setProcessActionStatus(`卸载失败：${(e as Error).message}`);
    } finally {
      inflightProcessOps.current.delete(pid);
      setProcessUnloadingPid(null);
      setTimeout(() => setProcessActionStatus(''), 4000);
    }
  }, [fetchApi, refreshProcesses]);

  const handleRefreshProcess = useCallback(async (pid: number) => {
    if (inflightProcessOps.current.has(pid)) return;
    inflightProcessOps.current.add(pid);
    setProcessRefreshingPid(pid);
    setProcessActionStatus(`正在刷新进程 ${pid} 的管道状态…`);
    try {
      const res = await fetchApi(`/api/processes/${pid}/refresh`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || '刷新失败');
      setProcessActionStatus(`已刷新进程 ${pid} 的管道状态`);
      await refreshProcesses();
    } catch (e) {
      setProcessActionStatus(`刷新失败：${(e as Error).message}`);
    } finally {
      inflightProcessOps.current.delete(pid);
      setProcessRefreshingPid(null);
      setTimeout(() => setProcessActionStatus(''), 4000);
    }
  }, [fetchApi, refreshProcesses]);

  const handleSaveConfig = useCallback(async () => {
    if (!selectedUin || !config) return;
    setSaveStatus('保存中...');
    try {
      const res = await fetchApi(`/api/config/${encodeURIComponent(selectedUin)}`, {
        method: 'POST',
        body: JSON.stringify(config),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存失败');
      setSaveStatus('保存成功');
    } catch (e) {
      setSaveStatus(`保存失败：${(e as Error).message}`);
    } finally {
      setTimeout(() => setSaveStatus(''), 3000);
    }
  }, [selectedUin, config, fetchApi]);

  // ---------- Render ----------
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        初始化中…
      </div>
    );
  }

  const checkStrength = async (password: string) => {
    const res = await fetchApi('/api/auth/check-strength', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    const data = (await res.json().catch(() => ({}))) as { rules?: PasswordRule[]; valid?: boolean };
    return { rules: data.rules ?? [], valid: !!data.valid };
  };
  const submitPwd = async (oldPassword: string, newPassword: string) => {
    const res = await fetchApi('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
    return { success: !!data.success, message: data.message };
  };

  return (
    <TooltipProvider delayDuration={150}>
      {!authed ? (
        <LoginPage onLogin={handleLogin} />
      ) : mustChange ? (
        <ChangePasswordPage
          forced
          checkStrength={checkStrength}
          submit={submitPwd}
          onSuccess={() => setMustChange(false)}
        />
      ) : (
        <MainLayout active={active} onNavigate={setActive} status={status} onLogout={handleLogout}>
          {active === 'overview' && (
            <OverviewPage
              qqList={qqList}
              status={status}
              processList={processList}
              processLoadingPid={processLoadingPid}
              processUnloadingPid={processUnloadingPid}
              processRefreshingPid={processRefreshingPid}
              processActionStatus={processActionStatus}
              systemInfo={systemInfo}
              onRefreshProcesses={refreshProcesses}
              onRefreshSystem={refreshSystem}
              onLoadProcess={handleLoadProcess}
              onUnloadProcess={handleUnloadProcess}
              onRefreshProcess={handleRefreshProcess}
            />
          )}
          {active === 'config' && (
            <ConfigPage
              qqList={qqList}
              selectedUin={selectedUin}
              config={config}
              saveStatus={saveStatus}
              onSelectAccount={setSelectedUin}
              onSave={handleSaveConfig}
              onConfigChange={setConfig}
            />
          )}
          {active === 'logs' && <LogsPage fetchApi={fetchApi} />}
          {active === 'settings' && <SettingsPage fetchApi={fetchApi} onLogout={handleLogout} />}
        </MainLayout>
      )}

      <ConfirmDialog
        open={!!unloadFailedAlert}
        onOpenChange={(open) => !open && setUnloadFailedAlert(null)}
        title="卸载失败"
        description={
          unloadFailedAlert ? (
            <>
              <p>进程 {unloadFailedAlert.pid} 的 SnowLuma DLL 卸载失败。</p>
              <p className="mt-2 text-sm">{unloadFailedAlert.error}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                系统将继续尝试重新连接该进程。如需彻底卸载，请重启 QQ 进程。
              </p>
            </>
          ) : null
        }
        confirmText="知道了"
        onConfirm={() => setUnloadFailedAlert(null)}
      />
    </TooltipProvider>
  );
}
