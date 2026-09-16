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

export default function LoginView() {
  const router = useRouter();
  const [session, setSession] = useSession();
  // Lazy-initialized from whatever useSession already read synchronously —
  // only genuinely "checking" if there's a stored session to verify, so the
  // no-session case never needs a setState call inside the effect below.
  const [checkingSession, setCheckingSession] = useState(() => session !== null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!checkingSession || !session) return;
    let cancelled = false;

    api
      .me({ baseUrl: API_BASE_URL })
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
    setSubmitting(true);
    try {
      const res = await api.login({ baseUrl: API_BASE_URL }, email, password);
      const nextSession = {
        userId: res.user.id,
        userEmail: res.user.email,
        tenantId: res.tenant.id,
        tenantName: res.tenant.name,
      };
      setSession(nextSession);
      router.replace('/onboarding');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Неверный email или пароль');
      } else {
        setError('Не удалось войти, попробуйте ещё раз');
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
        <h1 className={styles.title}>Войти</h1>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-email">
              Email
            </label>
            <input
              id="login-email"
              className={`${controls.input} ${styles.input}`}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-password">
              Пароль
            </label>
            <div className={styles.passwordField}>
              <input
                id="login-password"
                className={`${controls.input} ${styles.input}`}
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="current-password"
                required
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
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <button className={`${controls.buttonPrimary} ${styles.submit}`} type="submit" disabled={submitting}>
            {submitting ? 'Входим...' : 'Войти'}
          </button>
        </form>
        <p className={styles.switchLine}>
          Ещё нет аккаунта? <Link href="/signup">Зарегистрироваться</Link>
        </p>
      </div>
    </div>
  );
}
