'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { API_BASE_URL } from '@/lib/apiConfig';
import { useSession } from '@/lib/useSession';
import controls from './Controls.module.css';
import styles from './AuthView.module.css';

const MIN_PASSWORD_LENGTH = 8;

export default function SignupView() {
  const router = useRouter();
  const [session, setSession] = useSession();
  // Lazy-initialized from whatever useSession already read synchronously —
  // only genuinely "checking" if there's a stored session to verify, so the
  // no-session case never needs a setState call inside the effect below.
  const [checkingSession, setCheckingSession] = useState(() => session !== null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A stored session might be stale (expired, or the backend restarted with
  // a different SESSION_SECRET) — verify it against /api/auth/me rather
  // than trusting localStorage's mere presence.
  useEffect(() => {
    if (!checkingSession || !session) return;
    let cancelled = false;

    api
      .me({ baseUrl: API_BASE_URL, apiKey: session.sessionToken })
      .then(() => {
        if (!cancelled) router.replace('/onboarding');
      })
      .catch(() => {
        if (cancelled) return;
        setSession(null);
        setCheckingSession(false);
      });

    return () => {
      cancelled = true;
    };
  }, [checkingSession, router, session, setSession]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
      return;
    }

    if (password !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.signup({ baseUrl: API_BASE_URL }, email, password);
      const nextSession = {
        sessionToken: res.sessionToken,
        userId: res.user.id,
        userEmail: res.user.email,
        tenantId: res.tenant.id,
        tenantName: res.tenant.name,
      };
      setSession(nextSession);
      router.replace('/onboarding');
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'error' in err.body) {
        const code = (err.body as { error: string }).error;
        if (code === 'email_taken') setError('Этот email уже зарегистрирован — попробуйте войти');
        else if (code === 'invalid_email') setError('Некорректный email');
        else if (code === 'invalid_password') setError(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
        else setError('Не удалось зарегистрироваться, попробуйте ещё раз');
      } else {
        setError('Не удалось зарегистрироваться, попробуйте ещё раз');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (checkingSession || session) return null;

  return (
    <div className={styles.page}>
      <div className={styles.brand}>Sonar</div>
      <div className={styles.card}>
        <h1 className={styles.title}>Создать аккаунт</h1>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="signup-email">
              Email
            </label>
            <input
              id="signup-email"
              className={`${controls.input} ${styles.input}`}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="signup-password">
              Пароль
            </label>
            <div className={styles.passwordField}>
              <input
                id="signup-password"
                className={`${controls.input} ${styles.input}`}
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className={styles.toggleVisibility}
                onClick={() => setPasswordVisible((v) => !v)}
                tabIndex={-1}
                aria-label={passwordVisible ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className={styles.hint}>Не короче {MIN_PASSWORD_LENGTH} символов</p>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="signup-confirm-password">
              Повторите пароль
            </label>
            <div className={styles.passwordField}>
              <input
                id="signup-confirm-password"
                className={`${controls.input} ${styles.input}`}
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              <button
                type="button"
                className={styles.toggleVisibility}
                onClick={() => setPasswordVisible((v) => !v)}
                tabIndex={-1}
                aria-label={passwordVisible ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <button className={`${controls.buttonPrimary} ${styles.submit}`} type="submit" disabled={submitting}>
            {submitting ? 'Создаём...' : 'Зарегистрироваться'}
          </button>
        </form>
        <p className={styles.switchLine}>
          Уже есть аккаунт? <Link href="/login">Войти</Link>
        </p>
      </div>
    </div>
  );
}
