'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';
import styles from './LandingView.module.css';

const DEMO_CYCLE_URL = '/signup';

const SIGNAL_STEPS = [
  {
    label: 'Сигнал 01',
    title: 'Сценарий ловит намерение',
    body: 'Ключевое слово запускает опубликованный внутри Sonar сценарий. В демо входящее событие создаётся внутри продукта, без webhook соцсети.',
  },
  {
    label: 'Сигнал 02',
    title: 'CRM сохраняет диалог',
    body: 'Демо-контакт и переписка появляются в одной карточке. На следующем шаге пользователь сам назначает тег сегмента и статус лида.',
  },
  {
    label: 'Сигнал 03',
    title: 'Разметка становится сигналом',
    body: 'Sonar сравнивает теги по доле контактов со статусом «Клиент». Это прозрачный rule-based приоритет, а не статистический прогноз.',
  },
  {
    label: 'Сигнал 04',
    title: 'Тема получает приоритет',
    body: 'Контент-план поднимает темы, связанные с CRM-сигналами, показывает размер выборки и проверяет наличие готового сценария по нише.',
  },
];

const PRODUCT_AREAS = [
  {
    title: 'Контент-план на данных CRM',
    body: 'Ранжирует теги по доле клиентов, показывает размер выборки и проверяет наличие сценариев по нише. Это правило приоритета, не прогноз спроса.',
    status: 'MVP · объяснение пока шаблонное',
    featured: true,
  },
  {
    title: 'Конструктор чат-бота',
    body: 'Триггеры, узлы сообщений, версии, публикация и тестовый режим на визуальном канвасе.',
    status: 'MVP · внешний канал симулируется',
  },
  {
    title: 'CRM и база аудитории',
    body: 'Карточки подписчиков, статусы лидов, теги, заметки, история сообщений, фильтры, таблица и Kanban.',
    status: 'MVP',
  },
  {
    title: 'Анализ рилсов',
    body: 'Интерфейс разбора, библиотека и структура ролика готовы. Настоящий анализ видео и AI-генерация пока заменены демо-логикой.',
    status: 'ПРОТОТИП',
  },
  {
    title: 'Карусели',
    body: 'Есть брендовые пресеты, редактируемый канвас, сохранение текста и экспорт слайдов в PNG. Генерация текста демонстрационная.',
    status: 'ПРОТОТИП',
  },
  {
    title: 'Очередь публикаций',
    body: 'Планирование, согласование, статусы, обработка ошибок и уведомления собраны. Официальные API соцсетей ещё не подключены.',
    status: 'ПРОТОТИП',
  },
  {
    title: 'Видеомонтаж',
    body: 'Выбор шаблона, очередь задач, прогресс и статусы рендера реализованы. Загрузка файлов и настоящий движок рендера впереди.',
    status: 'ПРОТОТИП',
  },
];

const ROADMAP = [
  {
    title: 'Живые интеграции',
    body: 'OAuth, входящие webhooks и официальные API публикации социальных платформ.',
  },
  {
    title: 'Настоящий AI-пайплайн',
    body: 'Разбор и транскрибация видео, адаптация сценариев и генерация текста каруселей.',
  },
  {
    title: 'Единый путь контента',
    body: 'Передача сценария, карусели или видео в очередь публикаций без повторного ручного ввода.',
  },
  {
    title: 'Production-инфраструктура',
    body: 'Billing, файловое хранилище и надёжные фоновые очереди для коммерческого запуска.',
  },
];

const FAQ = [
  {
    question: 'Что уже работает end-to-end?',
    answer:
      'В демонстрационном режиме можно собрать и опубликовать сценарий бота, проверить триггер, сохранить демо-контакт и переписку в CRM, вручную назначить тег и статус, а затем увидеть rule-based рейтинг тем в контент-плане. Внешнее событие соцсети симулируется.',
  },
  {
    question: 'Можно подключить реальный Instagram или TikTok?',
    answer:
      'Нет. Текущий демо-цикл не запрашивает OAuth и не подключает социальный аккаунт. Входящее событие создаётся внутри Sonar; официальные API платформ относятся к следующему этапу.',
  },
  {
    question: 'Sonar уже анализирует рилсы с помощью AI?',
    answer:
      'Не в текущей сборке. Интерфейс, библиотека и структура данных готовы, но анализ видео и генерация адаптированного сценария пока работают на демонстрационной логике.',
  },
  {
    question: 'Что настоящее в контент-плане?',
    answer:
      'Ранжирование использует данные текущей CRM: теги, количество контактов, статусы лидов и наличие сценариев по соответствующей нише. Результат показывает rule-based приоритет и размер выборки, а не статистически надёжный прогноз. Текст объяснения создаётся шаблоном, а не LLM.',
  },
  {
    question: 'Автопостинг уже работает?',
    answer:
      'Очередь, расписание, согласование, статусы и уведомления работают в прототипе. Отправка публикаций в официальные API соцсетей пока симулируется.',
  },
  {
    question: 'Можно зарегистрироваться и начать самостоятельно?',
    answer:
      'Да. После регистрации по email onboarding проводит через четыре шага: демо-пространство, проверку сценария, демо-диалог в CRM и сигнал для контент-плана. Социальные аккаунты при этом не подключаются.',
  },
  {
    question: 'Демо отправляет сообщения реальным людям?',
    answer:
      'Нет. Входящее и исходящее сообщения симулируются и сохраняются только внутри Sonar, чтобы показать контакт и историю в CRM. Внешние DM, комментарии и публикации не создаются.',
  },
  {
    question: 'Сколько стоит Sonar?',
    answer:
      'Для демо карта не нужна: подписка не оформляется и списаний нет. Публичный тариф коммерческой версии пока не зафиксирован.',
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
            <a href="#roadmap">Roadmap</a>
            <a href="#faq">FAQ</a>
          </nav>

          <a className={`${styles.button} ${styles.buttonCompact}`} href={DEMO_CYCLE_URL}>
            Пройти демо-цикл
          </a>
        </div>
      </header>

      <main id="main-content">
        <section className={`${styles.section} ${styles.heroSection}`} id="top" aria-labelledby="hero-title">
          <div className={`${styles.container} ${styles.heroGrid}`}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>SONAR · РАННИЙ MVP</p>
              <h1 id="hero-title" className={styles.heroTitle}>
                Превращайте вопросы аудитории в сделки — и темы для следующего контента.
              </h1>
              <p className={styles.heroLead}>
                Sonar связывает сценарии чат-бота, CRM и контент-приоритеты в одну цепочку. Уже можно проверить путь от ключевого слова до карточки лида и рекомендации по сегменту.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.button} href={DEMO_CYCLE_URL}>
                  Пройти демо-цикл
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
                  src="/hero-content-plan.png"
                  width={692}
                  height={300}
                  sizes="(max-width: 959px) calc(100vw - 40px), 540px"
                  preload
                  alt="Контент-план Sonar с приоритетом сегментов на основе данных CRM"
                />
                <figcaption>
                  Демо-данные в текущем MVP: процент — доля контактов со статусом «Клиент» внутри тега, а не прогноз спроса.
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
                <span>Рабочий MVP и интерфейсные прототипы отмечены отдельно.</span>
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
              <h2 id="proof-title" className={styles.sectionTitle}>Что можно проверить в текущем MVP</h2>
              <p className={styles.sectionLead}>
                Скрин CRM ниже сделан на демо-данных текущей сборки. Рядом — точный маршрут, который доступен после регистрации.
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
                    src="/hero-crm.png"
                    width={900}
                    height={420}
                    sizes="(max-width: 719px) calc(100vw - 40px), (max-width: 1199px) calc(50vw - 40px), 556px"
                    alt="CRM Sonar с карточкой подписчика и историей переписки"
                  />
                </div>
                <figcaption>
                  <strong>CRM · демо-данные.</strong> Контакт, ручной статус и история симулированной переписки внутри Sonar.
                </figcaption>
              </figure>

              <ol className={styles.proofSteps} aria-label="Четыре шага демо-цикла">
                <li>
                  <span>01</span>
                  <div><strong>Создать демо-сценарий</strong><p>Ключевое слово и ответ сохраняются в отдельном тестовом пространстве.</p></div>
                </li>
                <li>
                  <span>02</span>
                  <div><strong>Проверить без записи</strong><p>Dry-run запускает сценарий, но не создаёт контакт и сообщения в CRM.</p></div>
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
                Отделяем то, что можно проверить в текущем MVP, от интерфейсов следующего слоя. Без внутренней нумерации модулей и обещаний раньше времени.
              </p>
            </div>

            <ul className={styles.areaGrid}>
              {PRODUCT_AREAS.map((area) => (
                <li
                  key={area.title}
                  className={`${styles.areaCard} ${area.featured ? styles.areaCardFeatured : ''}`}
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
              <p className={styles.eyebrow}>ROADMAP</p>
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
                  Ценность Sonar не в количестве генераторов. Важно, чтобы рекомендацию можно было объяснить: какой это сегмент, сколько в нём подписчиков и клиентов, есть ли уже сценарий по теме.
                </p>
                <p>
                  Поэтому на лендинге отдельно показаны рабочий MVP, прототипы и следующий этап — AI должен ускорять работу, а не скрывать отсутствие данных.
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
                  Пройдите четыре шага от триггера до рекомендации по контенту и отдельно оцените, какие части продукта пока находятся в прототипе.
                </p>
              </div>
              <div className={styles.closingAction}>
                <a className={styles.button} href={DEMO_CYCLE_URL}>Пройти демо-цикл</a>
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
        </div>
      </footer>
    </div>
  );
}
