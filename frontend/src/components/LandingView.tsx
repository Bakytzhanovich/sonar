'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';
import styles from './LandingView.module.css';

const DEMO_CYCLE_URL = '/signup';

const SIGNAL_STEPS = [
  {
    label: 'Сигнал 01',
    title: 'Бот ловит вопрос',
    body: 'Человек пишет ключевое слово — бот отвечает по вашему сценарию. В демо сообщение создаётся внутри Sonar, без подключения Instagram.',
  },
  {
    label: 'Сигнал 02',
    title: 'CRM сохраняет диалог',
    body: 'Контакт и переписка — в одной карточке. Вы отмечаете, чем человек интересовался и купил ли он.',
  },
  {
    label: 'Сигнал 03',
    title: 'Видно, что приводит к покупке',
    body: 'Sonar сравнивает темы по доле купивших и читает, о чём спрашивали именно те, кто купил.',
  },
  {
    label: 'Сигнал 04',
    title: 'Вопрос становится роликом',
    body: 'Контент-план превращает вопросы покупателей в темы роликов — с их цитатами, сценарием и днём в календаре.',
  },
];

// Status words a visitor can act on: what works now, and what waits for the
// platforms' own approval. Kept honest on purpose — the line between the two
// is the one thing this page must not blur.
const WORKS = 'Работает';
const WORKS_AFTER_META = 'Работает · Instagram после Meta';

const PRODUCT_AREAS = [
  {
    title: 'Контент-план из вопросов покупателей',
    body: 'ИИ читает, о чём спрашивали в директе те, кто купил, и предлагает темы роликов. У каждой темы — дословные цитаты покупателей, сценарий в один клик и день в недельном календаре.',
    status: WORKS,
    featured: true,
  },
  {
    title: 'ИИ-видеомонтаж',
    body: 'Загрузите запись: ИИ расшифрует речь — казахский и русский, даже вперемешку, — вырежет паузы и слова-паразиты и наложит субтитры в выбранном стиле. Монтаж можно поправить вручную.',
    status: WORKS,
  },
  {
    title: 'Автопостинг',
    body: 'Готовый ролик из монтажа — в очередь одной кнопкой. Расписание, согласование, отмена и правка. Публикация в Instagram готова и включится после проверки Meta; TikTok и YouTube — позже.',
    status: WORKS_AFTER_META,
  },
  {
    title: 'Анализ рилсов',
    body: 'Загрузите чужой удачный рилс: ИИ найдёт хук и структуру с точными секундами и перепишет сценарий под вашу нишу.',
    status: WORKS,
  },
  {
    title: 'Карусели',
    body: 'Текст слайдов пишет ИИ по одной теме. Дальше правите прямо на слайде, сохраняете стиль бренда и выгружаете PNG.',
    status: WORKS,
  },
  {
    title: 'Чат-бот и CRM',
    body: 'Сценарии ответов на визуальном холсте, карточки контактов, статусы, теги, заметки, таблица и канбан. Пока Instagram не подключён, сообщения в демо создаются внутри Sonar.',
    status: WORKS_AFTER_META,
    // Last of six: full width, so the grid closes evenly at two and at
    // three columns instead of leaving one card alone on its row.
    wide: true,
  },
];

const ROADMAP = [
  {
    title: 'Instagram по-настоящему',
    body: 'Директ и публикация в ваш аккаунт: подключение уже готово и включается после проверки нашего приложения в Meta.',
  },
  {
    title: 'TikTok и YouTube Shorts',
    body: 'Публикация в обе платформы — после их собственных проверок приложения.',
  },
  {
    title: 'Монтаж со стоковыми кадрами',
    body: 'ИИ сам подберёт кадры под ключевые моменты речи, чтобы ролик не держался на одном говорящем лице.',
  },
  {
    title: 'Тарифы и оплата',
    body: 'Подписка через платёжного провайдера с сертификацией PCI DSS — данные карт Sonar не хранит.',
  },
];

const FAQ = [
  {
    question: 'Что уже работает?',
    answer:
      'ИИ-видеомонтаж, анализ рилсов, карусели, контент-план из вопросов покупателей и очередь публикаций. Чат-бот и CRM работают на демо-сообщениях, пока не подключён Instagram.',
  },
  {
    question: 'Можно подключить реальный Instagram или TikTok?',
    answer:
      'Instagram — сразу после того, как Meta одобрит наше приложение: подключение аккаунта и публикация уже готовы. TikTok и YouTube — следующими, у каждой платформы своя проверка.',
  },
  {
    question: 'Sonar анализирует рилсы с помощью ИИ?',
    answer:
      'Да. Загрузите файл рилса — ИИ расшифрует речь, найдёт хук и структуру с точными секундами и перепишет сценарий под вашу нишу. Ссылки Sonar не скачивает: вы загружаете сам файл.',
  },
  {
    question: 'Откуда контент-план берёт темы?',
    answer:
      'Из ваших же переписок: ИИ читает, о чём спрашивали купившие, и у каждой темы показывает их дословные цитаты. Тему без настоящей цитаты Sonar не покажет. Телефоны, почты и ники вырезаются до отправки текста в ИИ.',
  },
  {
    question: 'Автопостинг уже работает?',
    answer:
      'Очередь, расписание, согласование, отмена и правка постов работают, а ролик из монтажа ставится в очередь одной кнопкой. Публикация в Instagram включится после одобрения Meta, TikTok и YouTube — позже.',
  },
  {
    question: 'Можно зарегистрироваться и начать самостоятельно?',
    answer:
      'Да. После регистрации по email первый запуск проведёт через четыре шага: демо-пространство, проверку сценария, демо-диалог в CRM и сигнал для контент-плана. Соцсети при этом подключать не нужно.',
  },
  {
    question: 'Демо отправляет сообщения реальным людям?',
    answer:
      'Нет. В демо входящие и исходящие сообщения создаются и хранятся только внутри Sonar, чтобы показать контакт и историю в CRM. Внешние сообщения, комментарии и публикации не создаются.',
  },
  {
    question: 'Сколько стоит Sonar?',
    answer:
      'Для демо карта не нужна: подписка не оформляется и списаний нет. Тарифы коммерческой версии объявим отдельно.',
  },
];

export default function LandingView() {
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const page = pageRef.current;
    if (!page || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches || typeof IntersectionObserver === 'undefined') return;

    const blocks = page.querySelectorAll<HTMLElement>('[data-scroll-reveal]');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add(styles.revealed);
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' },
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
        <div className={`${styles.container} ${styles.headerInner}`}>
          <a className={styles.brand} href="#top" aria-label="Sonar — в начало страницы">
            <span className={styles.brandMark} aria-hidden="true" />
            Sonar
          </a>

          <nav className={styles.nav} aria-label="Навигация по лендингу">
            <a href="#how">Как работает</a>
            <a href="#inside">Что внутри</a>
            <a href="#roadmap">Планы</a>
            <a href="#faq">FAQ</a>
          </nav>

          {/* Outside the nav on purpose: the nav collapses on a phone, and a
              returning customer had no way in short of typing /login. */}
          <a className={styles.loginLink} href="/login">
            Войти
          </a>
          <a className={`${styles.button} ${styles.buttonCompact}`} href={DEMO_CYCLE_URL}>
            Попробовать демо
          </a>
        </div>
      </header>

      <main id="main-content">
        <section className={`${styles.section} ${styles.heroSection}`} id="top" aria-labelledby="hero-title">
          <div className={`${styles.container} ${styles.heroGrid}`}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>SONAR · РАННИЙ ДОСТУП</p>
              <h1 id="hero-title" className={styles.heroTitle}>
                Превращайте вопросы аудитории в сделки — и темы для следующего контента.
              </h1>
              <p className={styles.heroLead}>
                Чат-бот, CRM, ИИ-монтаж и автопостинг в одном месте — и контент-план, который строится из вопросов ваших покупателей.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.button} href={DEMO_CYCLE_URL}>
                  Попробовать демо
                </a>
                <a className={styles.textLink} href="#how">
                  Как это работает <span aria-hidden="true">↓</span>
                </a>
              </div>
              <p className={styles.heroNote}>
                <strong>4 шага после регистрации по email.</strong> Только демо-данные, без подключения соцсетей, карты и автоматической подписки.
              </p>
            </div>

            <div className={styles.heroVisual}>
              <ol className={styles.signalLoop} aria-label="Цикл данных Sonar">
                <li><span className={styles.signalDot} aria-hidden="true" />Диалог</li>
                <li>CRM</li>
                <li>Сегмент</li>
                <li>Контент <span className={styles.loopReturn} aria-hidden="true">↺</span></li>
              </ol>
              <figure className={styles.productFigure}>
                <div className={styles.windowBar} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <Image
                  className={styles.productImage}
                  src="/landing-topic.png"
                  width={592}
                  height={261}
                  sizes="(max-width: 959px) calc(100vw - 40px), 540px"
                  preload
                  alt="Темы роликов в контент-плане Sonar, у каждой — цитата покупателя из директа"
                />
                <figcaption>
                  Темы роликов из вопросов покупателей: у каждой — их дословная цитата. Пример на демо-данных.
                </figcaption>
              </figure>
            </div>
          </div>

          <ul className={`${styles.container} ${styles.trustStrip}`} aria-label="Условия демо">
            <li>
              <span className={styles.trustDot} aria-hidden="true" />
              <div>
                <strong>Только внутри Sonar</strong>
                <span>Демо не отправляет сообщения реальным людям или в соцсети.</span>
              </div>
            </li>
            <li>
              <span className={styles.trustDot} aria-hidden="true" />
              <div>
                <strong>Без карты и списаний</strong>
                <span>Платёжного шага и автоматической подписки нет.</span>
              </div>
            </li>
            <li>
              <span className={styles.trustDot} aria-hidden="true" />
              <div>
                <strong>Честные статусы</strong>
                <span>Что работает, а что ждёт подключения соцсетей, — отмечено отдельно.</span>
              </div>
            </li>
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="difference-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>ГЛАВНОЕ ОТЛИЧИЕ</p>
              <h2 id="difference-title" className={styles.sectionTitle}>
                Просмотры показывают внимание. CRM — кто становится клиентом.
              </h2>
              <p className={styles.sectionLead}>
                Контент и продажи часто живут в разных инструментах. Sonar возвращает ручную CRM-разметку в контент-план: зафиксированный сигнал становится не отчётом, а следующим действием.
              </p>
            </div>

            <div className={styles.questionGrid}>
              <article className={styles.questionCard}>
                <p className={styles.questionLabel}>Автоматизация</p>
                <h3>Кто написал?</h3>
                <p>Ловит ключевое слово и запускает сценарий ответа.</p>
              </article>
              <article className={styles.questionCard}>
                <p className={styles.questionLabel}>CRM</p>
                <h3>Кто стал клиентом?</h3>
                <p>Сохраняет контекст; пользователь назначает тег сегмента и статус лида.</p>
              </article>
              <article className={`${styles.questionCard} ${styles.questionCardAccent}`}>
                <p className={styles.questionLabel}>Sonar</p>
                <h3>Какую тему взять следующей?</h3>
                <p>Связывает результат продаж с приоритетом контента.</p>
              </article>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.surfaceSection}`} id="how" aria-labelledby="how-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>ДИАЛОГ → CRM → СЕГМЕНТ → ТЕМА</p>
              <h2 id="how-title" className={styles.sectionTitle}>Как сигнал проходит через Sonar</h2>
            </div>

            <div className={styles.workflowGrid}>
              <ol className={styles.workflowList}>
                {SIGNAL_STEPS.map((step) => (
                  <li key={step.label} className={styles.workflowItem}>
                    <span className={styles.workflowIndex}>{step.label}</span>
                    <div>
                      <h3>{step.title}</h3>
                      <p>{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>

              <figure className={styles.demoFigure}>
                <div className={styles.demoHeader}>
                  <span className={styles.demoAvatar} aria-hidden="true">A</span>
                  <div>
                    <strong>Демонстрационный сценарий</strong>
                    <span>ключевое слово: «план»</span>
                  </div>
                </div>
                <div className={styles.demoMessages}>
                  <p className={styles.messageIncoming}>Хочу план запуска</p>
                  <p className={styles.messageOutgoing}>Отправлю чек-лист. Подскажите, вы запускаете курс или консультацию?</p>
                  <div className={styles.crmSignal}>
                    <span>CRM</span>
                    <strong>Контакт и переписка сохранены</strong>
                    <span>Тег и статус задаёт пользователь</span>
                  </div>
                </div>
                <figcaption>Демо-диалог сохраняется автоматически; тег и статус пользователь назначает на следующем шаге в CRM.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="proof-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>ПРОВЕРЯЕМО ПРОДУКТОМ</p>
              <h2 id="proof-title" className={styles.sectionTitle}>Что можно проверить сразу после регистрации</h2>
              <p className={styles.sectionLead}>
                CRM на демо-данных, как она выглядит у вас. Рядом — четыре шага первого запуска.
              </p>
            </div>

            <div className={styles.proofGrid}>
              <figure className={styles.productFigure}>
                <div className={styles.windowBar} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className={styles.imageStage}>
                  <Image
                    className={styles.productImage}
                    src="/landing-crm.png"
                    width={1280}
                    height={640}
                    sizes="(max-width: 719px) calc(100vw - 40px), (max-width: 1199px) calc(50vw - 40px), 556px"
                    alt="CRM Sonar с карточкой подписчика и историей переписки"
                  />
                </div>
                <figcaption>
                  <strong>CRM · демо-данные.</strong> Контакт, статус, теги и вся переписка — в одной карточке.
                </figcaption>
              </figure>

              <ol className={styles.proofSteps} aria-label="Четыре шага первого запуска">
                <li>
                  <span>01</span>
                  <div><strong>Создать демо-сценарий</strong><p>Ключевое слово и ответ сохраняются в отдельном тестовом пространстве.</p></div>
                </li>
                <li>
                  <span>02</span>
                  <div><strong>Проверить без записи</strong><p>Тестовый запуск проверяет сценарий, ничего не записывая в CRM.</p></div>
                </li>
                <li>
                  <span>03</span>
                  <div><strong>Открыть демо-диалог</strong><p>Один тестовый контакт и его переписка сохраняются внутри CRM.</p></div>
                </li>
                <li>
                  <span>04</span>
                  <div><strong>Назначить сегмент</strong><p>После ручного тега и статуса контент-план показывает объяснимый приоритет.</p></div>
                </li>
              </ol>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.insideSection}`} id="inside" aria-labelledby="inside-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>ЧТО ВНУТРИ</p>
              <h2 id="inside-title" className={styles.sectionTitle}>Рабочий цикл — с честными статусами</h2>
              <p className={styles.sectionLead}>
                Что работает уже сейчас, а что включится после подключения соцсетей. Без обещаний раньше времени.
              </p>
            </div>

            <ul className={styles.areaGrid}>
              {PRODUCT_AREAS.map((area) => (
                <li
                  key={area.title}
                  className={`${styles.areaCard} ${'featured' in area && area.featured ? styles.areaCardFeatured : ''} ${'wide' in area && area.wide ? styles.areaCardWide : ''}`}
                  data-scroll-reveal
                >
                  <span className={styles.statusLabel}>{area.status}</span>
                  <h3>{area.title}</h3>
                  <p>{area.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="principle-title">
          <div className={styles.container}>
            <div className={styles.principleGrid}>
              <div>
                <p className={styles.eyebrow}>НЕ НАБОР ГЕНЕРАТОРОВ</p>
                <h2 id="principle-title" className={styles.sectionTitle}>Главный модуль Sonar — связь между модулями</h2>
              </div>
              <div className={styles.principleCopy}>
                <p>Бот может ответить. CRM может сохранить контакт. Генератор может предложить текст.</p>
                <p>Идея Sonar — связать эти действия так, чтобы вопросы подписчиков и статусы лидов влияли на следующую тему в работе.</p>
                <p className={styles.formula}>Диалог → CRM → сегмент → приоритет темы</p>
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.surfaceSection}`} id="roadmap" aria-labelledby="roadmap-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>ПЛАНЫ</p>
              <h2 id="roadmap-title" className={styles.sectionTitle}>Что нужно подключить до production-версии</h2>
              <p className={styles.sectionLead}>Без выдуманных дат и процентов готовности — только следующий проверяемый слой продукта.</p>
            </div>

            <ol className={styles.roadmapList}>
              {ROADMAP.map((item, index) => (
                <li key={item.title}>
                  <span className={styles.roadmapNumber}>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="trust-principle-title">
          <div className={styles.container}>
            <div className={styles.trustPrincipleBlock} data-scroll-reveal>
              <div className={styles.trustPrincipleCopy}>
                <p className={styles.eyebrow}>ПРИНЦИП SONAR</p>
                <h2 id="trust-principle-title" className={styles.sectionTitle}>Меньше магии — больше проверяемой связи</h2>
                <p>
                  Ценность Sonar не в количестве генераторов. Важно, чтобы рекомендацию можно было проверить: для какой аудитории тема, сколько из неё купили и что именно они спрашивали.
                </p>
                <p>
                  Поэтому рядом с каждой темой — дословные цитаты ваших покупателей. ИИ ускоряет работу, а не придумывает за вас.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.faqSection}`} id="faq" aria-labelledby="faq-title" data-scroll-reveal>
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>FAQ</p>
              <h2 id="faq-title" className={styles.sectionTitle}>Частые вопросы о текущей сборке</h2>
            </div>

            <div className={styles.faqList}>
              {FAQ.map((item) => (
                <details key={item.question} className={styles.faqItem}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.closingSection}`} aria-labelledby="closing-title">
          <div className={styles.container}>
            <div className={styles.closingPanel}>
              <div>
                <p className={styles.eyebrow}>ДЕМО-ЦИКЛ</p>
                <h2 id="closing-title" className={styles.sectionTitle}>Посмотрите, как сигнал превращается в рабочий процесс</h2>
                <p>
                  Четыре шага — и вы увидите, как вопрос подписчика превращается в тему для следующего ролика.
                </p>
              </div>
              <div className={styles.closingAction}>
                <a className={styles.button} href={DEMO_CYCLE_URL}>Попробовать демо</a>
                <span>Регистрация по email · демо-данные · без карты и подключения соцсетей.</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerInner}`}>
          <a className={styles.brand} href="#top" aria-label="Sonar — в начало страницы">
            <span className={styles.brandMark} aria-hidden="true" />
            Sonar
          </a>
          <p>Чат-бот, CRM и контент-план в одной цепочке данных.</p>
          <a href="#inside">Текущий статус продукта</a>
          <a href="/privacy">Конфиденциальность</a>
        </div>
      </footer>
    </div>
  );
}
