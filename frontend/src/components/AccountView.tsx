'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { API_BASE_URL } from '@/lib/apiConfig';
import { useLogout } from '@/lib/useLogout';
import { useSession } from '@/lib/useSession';
import PageHeader from './PageHeader';
import TabBar from './TabBar';
import controls from './Controls.module.css';
import styles from './AccountView.module.css';

// The customer's own right to erasure (Kazakhstan's personal data law). Two
// locks on one irreversible button: the password, because a session left open
// on a shared laptop must not be enough, and a typed word, because a password
// manager fills the first lock without the person reading anything.
const CONFIRM_WORD = 'УДАЛИТЬ';

const ERASED = [
  'бот, триггеры и все переписки в директе',
  'CRM: контакты, теги, заметки',
  'рилсы, карусели, контент-план и календарь',
  'видео: исходники, готовые монтажи и расшифровки речи',
  'запланированные посты и подключённые аккаунты Instagram',
  'участники команды и сам вход',
];

export default function AccountView() {
  const [session] = useSession();
  const logout = useLogout();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ready = password.length > 0 && confirm.trim().toUpperCase() === CONFIRM_WORD && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteAccount({ baseUrl: API_BASE_URL }, password);
      // The server has already cleared the cookie; this clears what the
      // browser kept beside it and leaves for the login screen.
      await logout();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? (err.message.includes('пароль') ? 'Неверный пароль' : 'Удалить аккаунт может только его владелец')
          : 'Не получилось удалить — попробуйте ещё раз через минуту'
      );
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader section="Настройки" title="Аккаунт" current="/account" />

      <main className={styles.main}>
        {!session ? (
          <p className={styles.muted}>
            <Link href="/login">Войдите</Link>, чтобы управлять аккаунтом.
          </p>
        ) : (
          <>
            <section className={styles.card}>
              <h1 className={styles.heading}>Аккаунт</h1>
              <dl className={styles.facts}>
                <dt>Почта</dt>
                <dd>{session.userEmail}</dd>
                {/* A workspace made at signup is named after the email; the
                    same line twice says nothing. */}
                {session.tenantName !== session.userEmail && (
                  <>
                    <dt>Рабочее пространство</dt>
                    <dd>{session.tenantName}</dd>
                  </>
                )}
              </dl>
              <p className={styles.muted}>
                <Link href="/privacy" className={styles.link}>Как мы обращаемся с данными</Link>
              </p>
            </section>

            <section className={`${styles.card} ${styles.danger}`} aria-labelledby="erase-title">
              <h2 id="erase-title" className={styles.dangerTitle}>Удалить аккаунт</h2>
              <p>Удаляется всё рабочее пространство, без возможности восстановить:</p>
              <ul className={styles.list}>
                {ERASED.map((item) => <li key={item}>{item}</li>)}
              </ul>
              <p className={styles.muted}>
                Посты, уже опубликованные в Instagram, останутся в Instagram — удалить их можно только там.
              </p>

              <form className={styles.form} onSubmit={onSubmit}>
                <label className={styles.field}>
                  <span>Пароль</span>
                  <input
                    className={controls.input}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span>Напишите «{CONFIRM_WORD}»</span>
                  <input
                    className={controls.input}
                    autoComplete="off"
                    spellCheck={false}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
                {error && <p className={styles.error} role="alert">{error}</p>}
                <button type="submit" className={styles.eraseButton} disabled={!ready}>
                  {busy ? 'Удаляем…' : 'Удалить аккаунт навсегда'}
                </button>
              </form>
            </section>
          </>
        )}
      </main>

      <TabBar current="/account" />
    </div>
  );
}
