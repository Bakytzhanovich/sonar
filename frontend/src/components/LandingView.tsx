'use client';

import { useEffect, useRef } from 'react';
import { LANDING_FAQ as FAQ } from './landingContent';
import styles from './LandingView.module.css';

// The public landing. Written for a blogger deciding in five seconds what this
// is: the headline names the three jobs (the direct, reels, what to film), the
// phone shows the whole loop playing, and every block below is one step of it
// in the order a blogger lives it. Two things are labelled as waiting for
// Meta's review — the Instagram bot and auto-posting — because on the live
// site they work in the demo only, and promising otherwise is the one thing
// this page must not do. No prices or user counts until there are real ones.

const SIGNUP_URL = '/signup';
const LOGIN_URL = '/login';


export default function LandingView() {
  const pageRef = useRef<HTMLDivElement>(null);

  // Blocks rise into view as they are scrolled to. Done here rather than with
  // CSS scroll timelines, which Safari — half of the phones this page is read
  // on — does not run. Nothing is hidden for a visitor who asked for less
  // motion, or whose browser has no observer: the class is only ever added.
  useEffect(() => {
    const page = pageRef.current;
    if (!page || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches || typeof IntersectionObserver === 'undefined') return;

    const blocks = page.querySelectorAll<HTMLElement>('[data-reveal]');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add(styles.revealed);
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    blocks.forEach((block) => {
      block.classList.add(styles.revealPending);
      observer.observe(block);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.page} ref={pageRef} lang="ru">
      <a className={styles.skipLink} href="#main-content">
        Перейти к содержанию
      </a>

      <header className={styles.header}>
        <div className={`${styles.wrap} ${styles.headerInner}`}>
          <a className={styles.brand} href="#top" aria-label="Sonar — в начало страницы">
            <span className={styles.brandMark} aria-hidden="true">
              <span className={styles.brandDot} />
              <span className={styles.brandRing} />
            </span>
            Sonar
          </a>
          <nav className={styles.nav} aria-label="Разделы страницы">
            <a href="#features">Возможности</a>
            <a href="#how">Как начать</a>
            <a href="#faq">Вопросы</a>
          </nav>
          {/* Outside the nav on purpose: the nav collapses on a phone, and a
              returning customer had no way in short of typing /login. */}
          <a className={styles.loginLink} href={LOGIN_URL}>
            Войти
          </a>
          <a className={`${styles.button} ${styles.buttonCompact}`} href={SIGNUP_URL}>
            Попробовать
          </a>
        </div>
      </header>

      <main id="main-content">
        <section className={`${styles.wrap} ${styles.hero}`} id="top" aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <span className={`${styles.chip} ${styles.rise}`}>Для блогеров и экспертов в Instagram</span>
            <h1 id="hero-title" className={`${styles.heroTitle} ${styles.rise} ${styles.d1}`}>
              Отвечайте в директ, монтируйте рилсы и решайте, о чём снимать — в одном сервисе для Instagram
            </h1>
            <p className={`${styles.heroLead} ${styles.rise} ${styles.d2}`}>
              Бот отвечает подписчикам, Sonar находит темы в вопросах тех, кто купил, монтирует ролик с субтитрами и
              ставит его в расписание.
            </p>
            <div className={`${styles.heroActions} ${styles.rise} ${styles.d3}`}>
              <a className={styles.button} href={SIGNUP_URL}>
                Попробовать бесплатно
              </a>
              <a className={styles.buttonGhost} href="#how">
                Как начать
              </a>
            </div>
            <ul className={`${styles.heroFacts} ${styles.rise} ${styles.d4}`}>
              <li>Понимает казахский и русский — даже вперемешку</li>
              <li>Демо без карты и без подключения соцсетей</li>
            </ul>
          </div>

          <PhoneLoop />
        </section>

        <section className={styles.wrap} aria-label="Что заменяет Sonar" data-reveal>
          <div className={styles.replaces}>
            <div>
              <span>Вместо монтажёра</span>
              <strong>рилс за минуты</strong>
            </div>
            <div>
              <span>Вместо менеджера в директе</span>
              <strong>ответ за секунды</strong>
            </div>
            <div>
              <span>Вместо контент-стратега</span>
              <strong>темы от покупателей</strong>
            </div>
            <div className={styles.replacesSonar}>
              <span>Sonar</span>
              <strong>всё в одном месте</strong>
            </div>
          </div>
        </section>

        <section id="features" className={`${styles.wrap} ${styles.features}`} aria-label="Возможности">
          <article className={styles.feature} data-reveal>
            <div className={`${styles.card} ${styles.demo}`} aria-hidden="true">
              <div className={styles.chatHead}>
                <span className={styles.avatar}>А</span>
                <span>
                  <strong>Айгерим</strong>
                  <small>написала под рилсом «план»</small>
                </span>
              </div>
              <span className={`${styles.bubbleIn} ${styles.loop1}`}>план</span>
              <span className={`${styles.bubbleOut} ${styles.loop2}`}>Держите чек-лист! Подскажите, вы запускаете курс или консультацию?</span>
              <span className={`${styles.bubbleIn} ${styles.loop3}`}>Курс. А можно в рассрочку через Kaspi?</span>
            </div>
            <div className={styles.featureCopy}>
              <span className={styles.chip}>
                Чат-бот и CRM <em className={styles.soon}>Instagram — после одобрения Meta</em>
              </span>
              <h2>Бот отвечает в директ, пока вы снимаете</h2>
              <p>Человек пишет слово под рилсом — бот присылает обещанное и задаёт вопрос. Все диалоги и покупки — в одной CRM.</p>
              <ul className={styles.ticks}>
                <li>Ответ по ключевому слову за секунды</li>
                <li>Карточка каждого человека: переписка, теги, купил или нет</li>
                <li>Напоминает ответить, пока Instagram ещё разрешает написать</li>
              </ul>
            </div>
          </article>

          <article className={styles.feature} data-reveal>
            <div className={styles.featureCopy}>
              <span className={`${styles.chip} ${styles.chipAccent}`}>Контент-план</span>
              <h2>О чём снимать — подскажут те, кто у вас купил</h2>
              <p>
                Sonar читает директ и находит, о чём спрашивали именно покупатели — не все подписчики. Каждая тема ролика —
                с их дословными словами, чтобы вы отвечали на настоящий вопрос.
              </p>
              <ul className={styles.ticks}>
                <li>Отделяет вопросы купивших от остальных</li>
                <li>Тема без цитаты покупателя не попадёт в план</li>
                <li>Сценарий ролика — в один клик</li>
              </ul>
            </div>
            <div className={`${styles.card} ${styles.demo}`} aria-hidden="true">
              <small className={styles.demoLabel}>Спрашивали купившие</small>
              <span className={styles.bubbleIn}>подойдёт ли курс, если болит спина после родов?</span>
              <span className={styles.bubbleIn}>у меня диастаз, мне можно?</span>
              <span className={styles.arrowDown}>↓</span>
              <div className={styles.topicCard}>
                <small>Тема для ролика</small>
                <strong>Можно ли заниматься йогой с больной спиной после родов</strong>
              </div>
            </div>
          </article>

          <article className={styles.feature} data-reveal>
            <div className={`${styles.card} ${styles.demo}`} aria-hidden="true">
              <div className={styles.timelineHead}>
                <small>Ваша запись</small>
                <small>паузы исчезают</small>
              </div>
              <div className={styles.timeline}>
                <span style={{ flex: 3 }} />
                <i />
                <span style={{ flex: 2 }} />
                <i />
                <span style={{ flex: 4 }} />
                <i />
                <span style={{ flex: 2 }} />
              </div>
              <div className={styles.timelineHead}>
                <small>1:42 исходник</small>
                <strong>0:58 готовый ролик</strong>
              </div>
            </div>
            <div className={styles.featureCopy}>
              <span className={styles.chip}>ИИ-монтаж</span>
              <h2>Загрузите запись — получите готовый рилс</h2>
              <p>Без таймлайна и монтажёра. Sonar слушает речь и делает то, на что обычно уходит вечер.</p>
              <ul className={styles.ticks}>
                <li>Вырезает паузы, «эээ» и вздохи</li>
                <li>Вжигает субтитры с подсветкой слова, которое звучит</li>
                <li>Понимает казахский, русский и речь вперемешку</li>
                <li>Вертикаль для Reels, квадрат, горизонталь — без чёрных полос</li>
              </ul>
            </div>
          </article>

          <article className={styles.feature} data-reveal>
            <div className={styles.featureCopy}>
              <span className={styles.chip}>
                Автопостинг <em className={styles.soon}>после одобрения Meta</em>
              </span>
              <h2>Ролик выйдет сам — в нужный день и час</h2>
              <p>Поставьте готовый рилс в расписание и занимайтесь своими делами. Sonar опубликует его и напишет, когда пост вышел.</p>
              <ul className={styles.ticks}>
                <li>Календарь публикаций на неделю вперёд</li>
                <li>Согласование: пост не выйдет, пока его не одобрят — удобно агентствам</li>
                <li>Бережёт аккаунт: не публикует слишком часто и следит за лимитами Instagram</li>
              </ul>
            </div>
            <div className={`${styles.card} ${styles.demo}`} aria-hidden="true">
              <div className={styles.timelineHead}>
                <small>Эта неделя</small>
                <small>Instagram</small>
              </div>
              <div className={styles.week}>
                {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => (
                  <small key={d}>{d}</small>
                ))}
              </div>
              <div className={styles.week}>
                <span />
                <span className={styles.weekQuiet}>19:00</span>
                <span />
                <span />
                <span className={styles.weekPost}>19:00 рилс</span>
                <span />
                <span />
              </div>
              <div className={styles.postRow}>
                «Йога после родов: можно?» <small>пятница, 19:00 · запланирован</small>
              </div>
            </div>
          </article>

          <div className={styles.more} data-reveal>
            <h2 className={styles.sectionTitle}>Ещё в Sonar</h2>
            <div className={styles.moreGrid}>
              <div className={styles.card}>
                <strong>Разбор чужих рилсов</strong>
                <p>Загрузите ролик, который хорошо зашёл: Sonar покажет хук и структуру и перепишет сценарий под вашу нишу.</p>
              </div>
              <div className={styles.card}>
                <strong>Карусели одним запросом</strong>
                <p>Напишите тему — получите готовые слайды в цветах вашего бренда.</p>
              </div>
              <div className={styles.card}>
                <strong>Уведомления на телефон</strong>
                <p>Ролик готов, пост вышел, кто-то ждёт ответа — узнаете сразу.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="how" className={`${styles.wrap} ${styles.how}`} aria-labelledby="how-title" data-reveal>
          <h2 id="how-title" className={styles.sectionTitle}>
            Как начать
          </h2>
          <ol className={styles.steps}>
            <li className={styles.card}>
              <span className={styles.stepNo}>1</span>
              <strong>Зарегистрируйтесь</strong>
              <p>По email, без карты. Первый запуск проведёт по шагам на демо-данных.</p>
            </li>
            <li className={styles.card}>
              <span className={styles.stepNo}>2</span>
              <strong>Загрузите видео</strong>
              <p>Выберите стиль субтитров и посмотрите результат прямо на кадре — до монтажа.</p>
            </li>
            <li className={styles.card}>
              <span className={styles.stepNo}>3</span>
              <strong>Заберите ролик</strong>
              <p>Скачайте готовый рилс или поставьте в расписание.</p>
            </li>
          </ol>
        </section>

        <section id="faq" className={`${styles.wrap} ${styles.faq}`} aria-labelledby="faq-title" data-reveal>
          <h2 id="faq-title" className={styles.sectionTitle}>
            Вопросы
          </h2>
          {FAQ.map((item) => (
            <details key={item.question} className={styles.card}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </section>

        <section className={styles.wrap} aria-labelledby="closing-title" data-reveal>
          <div className={styles.closing}>
            <h2 id="closing-title" className={styles.sectionTitle}>
              Директ, ролики и публикации — в одном месте
            </h2>
            <p>Попробуйте бесплатно: загрузите запись с телефона и получите готовый рилс с субтитрами.</p>
            <a className={styles.button} href={SIGNUP_URL}>
              Попробовать бесплатно
            </a>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.wrap} ${styles.footerInner}`}>
          <strong>Sonar</strong>
          <a href="/privacy">Конфиденциальность</a>
          <a href={LOGIN_URL}>Войти</a>
        </div>
      </footer>
    </div>
  );
}

/** The whole loop in one phone, a scene every three seconds. Decorative —
 *  the same story is told in words right next to it. */
function PhoneLoop() {
  return (
    <div className={`${styles.phoneWrap} ${styles.rise} ${styles.d2}`} aria-hidden="true">
      <div className={styles.phone}>
        <div className={styles.scene}>
          <div className={styles.chatHead}>
            <span className={styles.avatar}>А</span>
            <strong>Айгерим</strong>
          </div>
          <span className={styles.bubbleIn}>план</span>
          <span className={styles.bubbleOut}>Держите чек-лист! Вы запускаете курс или консультацию?</span>
          <span className={styles.bubbleIn}>Курс. А если болит спина после родов — подойдёт?</span>
          <small className={styles.sceneCaption}>1 · Бот ответил в директ</small>
        </div>

        <div className={`${styles.scene} ${styles.s2}`}>
          <small className={styles.demoLabel}>Спрашивали купившие</small>
          <span className={styles.bubbleIn}>подойдёт ли курс, если болит спина после родов?</span>
          <span className={styles.bubbleIn}>у меня диастаз, мне можно?</span>
          <div className={styles.topicCard}>
            <small>Тема для ролика</small>
            <strong>Йога с больной спиной после родов — можно ли?</strong>
          </div>
          <small className={styles.sceneCaption}>2 · Тема из вопросов покупателей</small>
        </div>

        <div className={`${styles.scene} ${styles.s3} ${styles.reel}`}>
          <span className={styles.reelBody} />
          <span className={styles.reelHead} />
          <span className={styles.reelBand}>Йога после родов: можно?</span>
          <span className={styles.reelWords}>
            <b>каждая</b>
            <b>твоя</b>
            <b>история</b>
          </span>
          <small className={styles.sceneCaptionLight}>3 · Рилс смонтирован с субтитрами</small>
        </div>

        <div className={`${styles.scene} ${styles.s4}`}>
          <small className={styles.demoLabel}>Публикации на неделе</small>
          <div className={styles.week}>
            {['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => (
              <small key={d}>{d}</small>
            ))}
          </div>
          <div className={`${styles.week} ${styles.weekTall}`}>
            <span />
            <span />
            <span className={styles.weekPostPlain} />
            <span />
            <span className={styles.weekPostPlain} />
            <span />
            <span />
          </div>
          <div className={styles.postRow}>
            Йога после родов: можно? <small>пятница, 19:00 · запланирован</small>
          </div>
          <small className={styles.sceneCaption}>4 · Выйдет по расписанию</small>
        </div>
      </div>
      <div className={styles.sceneDots}>
        <span />
        <span className={styles.s2} />
        <span className={styles.s3} />
        <span className={styles.s4} />
      </div>
    </div>
  );
}
