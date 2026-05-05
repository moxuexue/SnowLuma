import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Eye, EyeOff, KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

export interface PasswordRule {
  id: string;
  label: string;
  ok: boolean;
}

interface ChangePasswordPageProps {
  /** When true, this is the forced first-time change flow. */
  forced?: boolean;
  /** Heading shown above the form. */
  title?: string;
  /** Subheading. */
  description?: string;
  /** Sends `{ password }` and returns the rule list + valid flag. */
  checkStrength: (password: string) => Promise<{ rules: PasswordRule[]; valid: boolean }>;
  /** Sends `{ oldPassword, newPassword }`. Returns success or error message. */
  submit: (oldPassword: string, newPassword: string) => Promise<{ success: boolean; message?: string }>;
  /** Called after a successful submit. */
  onSuccess: () => void;
  /** Called when user cancels (only available when not forced). */
  onCancel?: () => void;
}

export function ChangePasswordPage({
  forced = false,
  title,
  description,
  checkStrength,
  submit,
  onSuccess,
  onCancel,
}: ChangePasswordPageProps) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [rules, setRules] = useState<PasswordRule[]>([]);
  const [valid, setValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const confirmMatches = newPassword.length > 0 && newPassword === confirmPassword;
  const canSubmit =
    !submitting && oldPassword.length > 0 && valid && confirmMatches && oldPassword !== newPassword;

  // Debounce the strength check so we don't slam the API on every keystroke.
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const res = await checkStrength(newPassword);
        if (cancelled) return;
        setRules(res.rules);
        setValid(res.valid);
      } catch {
        /* ignore – the form will just stay disabled */
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [newPassword, checkStrength]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await submit(oldPassword, newPassword);
      if (res.success) {
        onSuccess();
      } else {
        setError(res.message || '修改失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const computedTitle = title ?? (forced ? '请先设置新的访问密码' : '修改访问密码');
  const computedDescription =
    description ??
    (forced
      ? '为了保护你的实例，必须将首次启动生成的临时密码替换为符合下列要求的强密码。'
      : '设置一个全新的强密码后，其他会话将被立即下线，需要重新登录。');

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-8">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% 0%, color-mix(in oklab, var(--primary) 18%, transparent) 0%, transparent 70%)',
        }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -left-24 top-24 size-72 rounded-full bg-primary/15 blur-3xl"
        animate={{ scale: [1, 1.08, 1] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-lg"
      >
        <Card className="border-primary/15 shadow-xl">
          <CardContent className="p-7 sm:p-9">
            <div className="flex items-start gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                {forced ? (
                  <ShieldAlert className="size-6 text-primary" />
                ) : (
                  <KeyRound className="size-6 text-primary" />
                )}
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">{computedTitle}</h1>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{computedDescription}</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="old">当前密码</Label>
                <div className="relative">
                  <Input
                    id="old"
                    type={showOld ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="输入当前访问密码"
                    className="h-10 pr-10 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOld((v) => !v)}
                    aria-label={showOld ? '隐藏密码' : '显示密码'}
                    tabIndex={-1}
                    className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {showOld ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new">新密码</Label>
                <div className="relative">
                  <Input
                    id="new"
                    type={showNew ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="设置新的强密码"
                    className="h-10 pr-10 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    aria-label={showNew ? '隐藏密码' : '显示密码'}
                    tabIndex={-1}
                    className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm">确认新密码</Label>
                <Input
                  id="confirm"
                  type={showNew ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入新密码"
                  className="h-10 text-sm"
                />
                {confirmPassword.length > 0 && !confirmMatches && (
                  <span className="text-[11px] text-destructive">两次输入的密码不一致</span>
                )}
              </div>

              <RuleList rules={rules} />

              <AnimatePresence>
                {error && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="rounded-md bg-destructive/10 px-3 py-2 text-center text-xs text-destructive"
                  >
                    {error}
                  </motion.p>
                )}
              </AnimatePresence>

              <div className="flex items-center gap-2">
                {!forced && onCancel && (
                  <Button type="button" variant="ghost" onClick={onCancel} className="h-10">
                    取消
                  </Button>
                )}
                <Button type="submit" disabled={!canSubmit} className="ml-auto h-10">
                  {submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> 提交中…
                    </>
                  ) : (
                    '保存新密码'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

function RuleList({ rules }: { rules: PasswordRule[] }) {
  // Initial empty state: show a placeholder set so the user knows the rules
  // exist even before any input.
  const display = useMemo<PasswordRule[]>(() => {
    if (rules.length > 0) return rules;
    return [
      { id: 'length', label: '长度不少于 10 位', ok: false },
      { id: 'lower', label: '至少包含一个小写字母', ok: false },
      { id: 'upper', label: '至少包含一个大写字母', ok: false },
      { id: 'special', label: '至少包含一个特殊字符', ok: false },
      { id: 'no-space', label: '不得包含空格', ok: false },
    ];
  }, [rules]);

  return (
    <ul className="grid gap-1.5 rounded-lg border bg-muted/30 p-3">
      {display.map((rule) => (
        <li key={rule.id} className="flex items-center gap-2">
          <motion.span
            initial={false}
            animate={{
              backgroundColor: rule.ok ? 'color-mix(in oklab, var(--primary) 20%, transparent)' : 'transparent',
              borderColor: rule.ok ? 'var(--primary)' : 'var(--border)',
              scale: rule.ok ? [1, 1.18, 1] : 1,
            }}
            transition={{ duration: 0.25 }}
            className={cn(
              'flex size-4 items-center justify-center rounded-full border',
            )}
          >
            <AnimatePresence>
              {rule.ok && (
                <motion.span
                  key="check"
                  initial={{ opacity: 0, scale: 0.4 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.4 }}
                  transition={{ duration: 0.18 }}
                >
                  <Check className="size-3 text-primary" strokeWidth={3} />
                </motion.span>
              )}
            </AnimatePresence>
          </motion.span>
          <motion.span
            initial={false}
            animate={{ color: rule.ok ? 'var(--foreground)' : 'var(--muted-foreground)' }}
            transition={{ duration: 0.2 }}
            className="text-xs"
          >
            {rule.label}
          </motion.span>
        </li>
      ))}
    </ul>
  );
}
