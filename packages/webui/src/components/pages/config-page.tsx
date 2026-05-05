import { useState } from 'react';
import { motion } from 'motion/react';
import { MousePointerClick, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import type {
  HttpPostEndpoint,
  HttpServerEndpoint,
  OneBotConfig,
  QQInfo,
  WsClientEndpoint,
  WsServerEndpoint,
} from '@/types';

interface ConfigPageProps {
  qqList: QQInfo[];
  selectedUin: string | null;
  config: OneBotConfig | null;
  saveStatus: string;
  onSelectAccount: (uin: string) => void;
  onSave: () => Promise<void> | void;
  onConfigChange: (config: OneBotConfig) => void;
}

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
}: {
  label: string;
  value: string | number | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'number' | 'url';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label>{label}</Label>
      <Input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

interface SectionProps {
  title: string;
  description?: string;
  onAdd?: () => void;
  children: React.ReactNode;
  count?: number;
}

function Section({ title, description, onAdd, children, count }: SectionProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">{title}</CardTitle>
            {typeof count === 'number' && <Badge variant="secondary">{count}</Badge>}
          </div>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {onAdd && (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="size-3.5" /> 添加
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">{children}</CardContent>
    </Card>
  );
}

function EndpointRow({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="flex flex-col gap-3 rounded-lg border bg-card/40 p-3 sm:flex-row sm:items-end"
    >
      <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end">{children}</div>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="删除"
          className="self-end text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </motion.div>
  );
}

export function ConfigPage({
  qqList,
  selectedUin,
  config,
  saveStatus,
  onSelectAccount,
  onSave,
  onConfigChange,
}: ConfigPageProps) {
  const [confirmSave, setConfirmSave] = useState(false);

  const update = (next: OneBotConfig) => onConfigChange(next);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Account list */}
      <Card className="lg:sticky lg:top-2 lg:self-start">
        <CardHeader>
          <CardTitle className="text-sm">在线连接</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {qqList.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无在线会话</p>
          ) : (
            <ScrollArea className="max-h-[60vh]" viewportClassName="[&>div]:!block">
              <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
                {qqList.map((q) => {
                  const isActive = selectedUin === q.uin;
                  return (
                    <motion.button
                      key={q.uin}
                      type="button"
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => onSelectAccount(q.uin)}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors cursor-pointer',
                        isActive ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-accent/40'
                      )}
                    >
                      <Avatar size={28}>
                        <AvatarImage src={qqAvatarUrl(q.uin)} alt={q.nickname || q.uin} />
                        <AvatarFallback>{(q.nickname || q.uin).slice(0, 2)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn('truncate text-sm font-medium', isActive ? 'text-primary' : 'text-foreground')}
                        >
                          {q.nickname}
                        </div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground tabular-nums">{q.uin}</div>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Editor */}
      <div className="min-w-0">
        {!selectedUin ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground">
            <MousePointerClick className="size-7" strokeWidth={1.5} />
            <p className="text-sm">请在左栏选择会话以配置通信节点</p>
          </div>
        ) : !config ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Header */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-semibold tracking-tight">OneBot 协议端点</h2>
                <code className="mt-0.5 block font-mono text-xs text-muted-foreground tabular-nums">UIN {selectedUin}</code>
              </div>
              <div className="flex items-center gap-2">
                {saveStatus && (
                  <span
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                      saveStatus === '保存成功' && 'border-success/30 bg-success/10 text-success',
                      saveStatus === '保存中...' && 'border-border bg-muted text-muted-foreground',
                      saveStatus !== '保存成功' && saveStatus !== '保存中...' && 'border-destructive/30 bg-destructive/10 text-destructive'
                    )}
                  >
                    {saveStatus}
                  </span>
                )}
                <Button onClick={() => setConfirmSave(true)} size="sm">
                  <Save className="size-3.5" /> 保存设定
                </Button>
              </div>
            </div>

            {/* HTTP Servers */}
            <Section
              title="HTTP 服务监听"
              description="开放 HTTP API，OneBot 客户端可主动发起请求"
              count={config.httpServers.length}
              onAdd={() => update({ ...config, httpServers: [...config.httpServers, { port: 3000, host: '0.0.0.0', path: '/' }] })}
            >
              {config.httpServers.length === 0 ? (
                <EmptyHint label="暂无 HTTP 服务" />
              ) : (
                config.httpServers.map((s, idx) => (
                  <EndpointRow
                    key={idx}
                    onRemove={() => update({ ...config, httpServers: config.httpServers.filter((_, i) => i !== idx) })}
                  >
                    <Field
                      label="端口"
                      type="number"
                      value={s.port}
                      onChange={(v) =>
                        update({
                          ...config,
                          httpServers: config.httpServers.map((it, i) => (i === idx ? { ...it, port: Number(v) || undefined } : it)) as HttpServerEndpoint[],
                        })
                      }
                      className="sm:w-32"
                    />
                    <Field
                      label="授权 Token"
                      placeholder="不填则无密码"
                      value={s.accessToken}
                      onChange={(v) =>
                        update({
                          ...config,
                          httpServers: config.httpServers.map((it, i) => (i === idx ? { ...it, accessToken: v || undefined } : it)),
                        })
                      }
                      className="flex-1"
                    />
                  </EndpointRow>
                ))
              )}
            </Section>

            {/* HTTP Post */}
            <Section
              title="HTTP Post 推送"
              description="向远端 URL 主动推送事件"
              count={config.httpPostEndpoints.length}
              onAdd={() => update({ ...config, httpPostEndpoints: [...config.httpPostEndpoints, { url: 'http://127.0.0.1:5700' }] })}
            >
              {config.httpPostEndpoints.length === 0 ? (
                <EmptyHint label="暂无 HTTP 推送目标" />
              ) : (
                config.httpPostEndpoints.map((s, idx) => (
                  <EndpointRow
                    key={idx}
                    onRemove={() =>
                      update({ ...config, httpPostEndpoints: config.httpPostEndpoints.filter((_, i) => i !== idx) })
                    }
                  >
                    <Field
                      label="目标 URL"
                      type="url"
                      placeholder="http://..."
                      value={s.url}
                      onChange={(v) =>
                        update({
                          ...config,
                          httpPostEndpoints: config.httpPostEndpoints.map((it, i) => (i === idx ? { ...it, url: v } : it)) as HttpPostEndpoint[],
                        })
                      }
                      className="flex-1"
                    />
                    <Field
                      label="授权 Token"
                      placeholder="可选"
                      value={s.accessToken}
                      onChange={(v) =>
                        update({
                          ...config,
                          httpPostEndpoints: config.httpPostEndpoints.map((it, i) => (i === idx ? { ...it, accessToken: v || undefined } : it)),
                        })
                      }
                      className="sm:w-64"
                    />
                  </EndpointRow>
                ))
              )}
            </Section>

            {/* WS Servers */}
            <Section
              title="WebSocket 服务监听"
              description="开放 WS 服务，客户端可建立持久连接"
              count={config.wsServers.length}
              onAdd={() => update({ ...config, wsServers: [...config.wsServers, { port: 3001, host: '0.0.0.0', path: '/' }] })}
            >
              {config.wsServers.length === 0 ? (
                <EmptyHint label="暂无 WS 服务" />
              ) : (
                config.wsServers.map((s, idx) => (
                  <EndpointRow
                    key={idx}
                    onRemove={() => update({ ...config, wsServers: config.wsServers.filter((_, i) => i !== idx) })}
                  >
                    <Field
                      label="端口"
                      type="number"
                      value={s.port}
                      onChange={(v) =>
                        update({
                          ...config,
                          wsServers: config.wsServers.map((it, i) => (i === idx ? { ...it, port: Number(v) || undefined } : it)) as WsServerEndpoint[],
                        })
                      }
                      className="sm:w-32"
                    />
                    <Field
                      label="授权 Token"
                      placeholder="不填则无密码"
                      value={s.accessToken}
                      onChange={(v) =>
                        update({
                          ...config,
                          wsServers: config.wsServers.map((it, i) => (i === idx ? { ...it, accessToken: v || undefined } : it)),
                        })
                      }
                      className="flex-1"
                    />
                  </EndpointRow>
                ))
              )}
            </Section>

            {/* WS Clients */}
            <Section
              title="WebSocket 反向连出"
              description="主动连接到外部 WS 服务器（reverse-ws）"
              count={config.wsClients.length}
              onAdd={() =>
                update({
                  ...config,
                  wsClients: [...config.wsClients, { url: 'ws://127.0.0.1:8080/ws', reconnectIntervalMs: 5000 }],
                })
              }
            >
              {config.wsClients.length === 0 ? (
                <EmptyHint label="暂无反向 WS 客户端" />
              ) : (
                config.wsClients.map((c, idx) => (
                  <EndpointRow
                    key={idx}
                    onRemove={() => update({ ...config, wsClients: config.wsClients.filter((_, i) => i !== idx) })}
                  >
                    <Field
                      label="目标 URL"
                      type="url"
                      placeholder="ws://..."
                      value={c.url}
                      onChange={(v) =>
                        update({
                          ...config,
                          wsClients: config.wsClients.map((it, i) => (i === idx ? { ...it, url: v } : it)) as WsClientEndpoint[],
                        })
                      }
                      className="flex-1"
                    />
                    <Field
                      label="授权 Token"
                      placeholder="可选"
                      value={c.accessToken}
                      onChange={(v) =>
                        update({
                          ...config,
                          wsClients: config.wsClients.map((it, i) => (i === idx ? { ...it, accessToken: v || undefined } : it)),
                        })
                      }
                      className="sm:w-64"
                    />
                  </EndpointRow>
                ))
              )}
            </Section>

            <Section title="音乐签名 URL" description="用于生成音乐卡片签名（可选）">
              <Field
                label="签名服务地址"
                type="url"
                placeholder="留空则不启用"
                value={config.musicSignUrl}
                onChange={(v) => update({ ...config, musicSignUrl: v || undefined })}
              />
            </Section>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmSave}
        onOpenChange={setConfirmSave}
        title="保存配置变更？"
        description={`即将把当前修改保存到 UIN ${selectedUin ?? ''} 的配置文件，并尝试热重载该会话。`}
        confirmText="保存"
        onConfirm={onSave}
      />
    </div>
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">{label}</div>
  );
}
