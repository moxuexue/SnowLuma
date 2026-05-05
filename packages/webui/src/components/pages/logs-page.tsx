import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import type { LogEntry } from '@/types';

interface LogsPageProps {
  fetchApi: (url: string, options?: RequestInit) => Promise<Response>;
}

const levelClass: Record<LogEntry['level'], string> = {
  debug: 'text-muted-foreground',
  info: 'text-primary',
  success: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive',
};

const LEVELS: LogEntry['level'][] = ['debug', 'info', 'success', 'warn', 'error'];

export function LogsPage({ fetchApi }: LogsPageProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [streamStatus, setStreamStatus] = useState('连接中');
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [enabledLevels, setEnabledLevels] = useState<Set<LogEntry['level']>>(new Set(LEVELS));
  const [confirmClear, setConfirmClear] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const token = useMemo(() => localStorage.getItem('snowluma_token') || '', []);

  async function loadLogs() {
    const res = await fetchApi('/api/logs?limit=500');
    if (!res.ok) return;
    const data = await res.json();
    setLogs(data.list || []);
  }

  useEffect(() => {
    loadLogs().catch(console.error);
  }, []);

  useEffect(() => {
    if (!token) return;
    const url = `/api/logs/stream?token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);
    source.onopen = () => setStreamStatus('实时');
    source.onerror = () => setStreamStatus('重连中');
    source.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data) as LogEntry | { type: string };
        if ('type' in entry) return;
        setLogs((prev) => [...prev.filter((it) => it.id !== entry.id), entry].slice(-1000));
      } catch {
        // ignore
      }
    };
    return () => source.close();
  }, [token]);

  useEffect(() => {
    if (paused) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, paused]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return logs.filter((l) => {
      if (!enabledLevels.has(l.level)) return false;
      if (!f) return true;
      return (
        l.message.toLowerCase().includes(f) ||
        l.scope.toLowerCase().includes(f) ||
        l.level.toLowerCase().includes(f)
      );
    });
  }, [logs, filter, enabledLevels]);

  const toggleLevel = (lv: LogEntry['level']) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next;
    });
  };

  return (
    <Card className="flex h-[calc(100vh-7rem)] min-h-[480px] flex-col">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            运行日志
            <Badge variant={streamStatus === '实时' ? 'success' : 'secondary'}>{streamStatus}</Badge>
          </CardTitle>
          <CardDescription>
            最近 {filtered.length} / {logs.length} 条 · 通过 SSE 推送
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="搜索消息 / 模块 / 级别"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-48"
          />
          <Button variant="outline" size="sm" onClick={() => setPaused((v) => !v)}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? '继续' : '暂停'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => loadLogs().catch(console.error)}>
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmClear(true)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" /> 清空视图
          </Button>
        </div>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-1 px-5 pb-3">
        {LEVELS.map((lv) => {
          const active = enabledLevels.has(lv);
          return (
            <button
              key={lv}
              type="button"
              onClick={() => toggleLevel(lv)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer',
                active
                  ? cn('border-transparent', levelClass[lv], 'bg-muted')
                  : 'border-border text-muted-foreground/60 line-through'
              )}
            >
              {lv.toUpperCase()}
            </button>
          );
        })}
      </div>

      <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-muted/30">
          <ScrollArea
            className="flex-1 min-h-0"
            viewportClassName="[&>div]:!block"
          >
            <div ref={viewportRef} className="font-mono text-xs">
              {filtered.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-muted-foreground">暂无日志</div>
              ) : (
                filtered.map((log) => (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.12 }}
                    className="flex gap-2 whitespace-pre-wrap px-3 py-0.5 leading-5 hover:bg-accent/30"
                  >
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {new Date(log.time).toLocaleTimeString()}
                    </span>
                    <span className={cn('w-14 shrink-0 font-semibold', levelClass[log.level])}>
                      {log.level.toUpperCase()}
                    </span>
                    <span className="w-28 shrink-0 truncate text-muted-foreground">[{log.scope}]</span>
                    <span className="break-all">{log.message}</span>
                  </motion.div>
                ))
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空当前日志视图？"
        description="此操作仅清空浏览器视图中的日志，不会影响服务端的日志缓冲区。"
        confirmText="清空"
        destructive
        onConfirm={() => setLogs([])}
      />
    </Card>
  );
}
