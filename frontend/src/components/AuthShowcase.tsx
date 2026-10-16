import Brand from './Brand';
import { LiveDot } from './PulseIndicator';
import styles from './AuthView.module.css';

// The side of the sign-in and sign-up screens that says what Sonar is for,
// in the product's own forms: the pulse and the asymmetric direct bubbles.
//
// An example, and said to be one. Before signing in there is no workspace to
// count, so the pulse carries no number — "12 диалогов активны" here would be
// a figure nobody measured.

const SCENE = [
  { from: 'in', text: 'Сколько стоит курс?' },
  { from: 'out', text: 'Курс — 29 000 ₸. Ссылку на оплату отправила в директ' },
  { from: 'in', text: 'Оплатила, спасибо!' },
] as const;

export default function AuthShowcase() {
  return (
    <section className={styles.showcase} aria-labelledby="auth-showcase-title">
      <div className={styles.brand}><Brand /></div>

      <h2 id="auth-showcase-title" className={styles.headline}>Директ отвечает, пока вы снимаете</h2>

      <ol className={styles.scene} aria-label="Пример переписки с ботом">
        {/* Who is writing, as the direct shows it. Hidden from screen readers:
            each bubble below already names its sender. */}
        <li className={styles.sender} aria-hidden="true">
          <LiveDot />
          aruzhan.fit пишет в директ
        </li>
        {SCENE.map((m, i) => (
          <li key={i} className={m.from === 'in' ? styles.bubbleIn : styles.bubbleOut}>
            <span className="visually-hidden">{m.from === 'in' ? 'Подписчица: ' : 'Бот: '}</span>
            {m.text}
          </li>
        ))}
      </ol>

      <p className={styles.caption}>Бот ответил по ключевому слову за 3 секунды — ночью, пока вы спали.</p>
    </section>
  );
}
