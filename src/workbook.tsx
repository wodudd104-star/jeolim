import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './workbook.css';

type Subject = '국어' | '수학' | '사회' | '과학' | '영어';
type Problem = { question: string; options: string[]; answer: number; explanation: string };
type Task = {
  subject: Subject;
  title: string;
  objective: string;
  minutes: number;
  questions: number;
  level: string;
  accent: string;
  problems: Problem[];
};

type RecordItem = { subject: Subject; title: string; date: string; score: number };

const subjects: Array<'전체' | Subject> = ['전체', '국어', '수학', '사회', '과학', '영어'];
const taskBank: Task[] = [
  {
    subject: '국어', title: '3. 작품을 보고 느낌을 나누어요',
    objective: '작품을 보고 떠오른 느낌과 생각을 친구들과 이야기할 수 있어요.',
    minutes: 20, questions: 3, level: '보통', accent: 'navy',
    problems: [
      { question: '시를 읽고 떠오른 느낌을 말할 때 가장 알맞은 방법은 무엇일까요?', options: ['시 속 낱말과 장면을 떠올리며 내 생각을 말해요.', '친구의 생각과 똑같이 말해요.', '시의 제목만 크게 읽어요.', '가장 긴 문장만 골라 적어요.'], answer: 0, explanation: '작품 속 표현을 바탕으로 내가 느끼고 생각한 점을 말하면 좋아요.' },
      { question: '글쓴이의 마음을 짐작할 때 도움이 되는 것은 무엇일까요?', options: ['글 속 낱말과 문장', '글자의 색깔만 보기', '문장 수 세기', '책의 크기 재기'], answer: 0, explanation: '글에 쓰인 낱말과 문장에는 글쓴이의 생각과 마음이 담겨 있어요.' },
      { question: '친구와 작품에 대한 생각을 나눌 때 알맞은 태도는 무엇일까요?', options: ['친구의 이야기를 끝까지 들어요.', '내 생각만 계속 말해요.', '친구의 생각을 무시해요.', '작품을 읽지 않고 대답해요.'], answer: 0, explanation: '서로의 생각을 존중하며 들으면 작품을 더 깊이 이해할 수 있어요.' },
    ],
  },
  {
    subject: '수학', title: '분수의 덧셈과 뺄셈',
    objective: '분모가 같은 분수의 덧셈과 뺄셈을 계산할 수 있어요.',
    minutes: 15, questions: 3, level: '도전', accent: 'red',
    problems: [
      { question: '색종이 8장 중 3장을 쓰고, 이어서 2장을 더 썼어요. 모두 몇 장을 썼을까요?', options: ['3장', '4장', '5장', '6장'], answer: 2, explanation: '3장과 2장을 더하면 모두 5장이에요. 분수로 나타내면 3/8 + 2/8 = 5/8입니다.' },
      { question: '4/9 + 2/9의 값은 얼마일까요?', options: ['2/9', '6/9', '6/18', '8/9'], answer: 1, explanation: '분모가 같으므로 분자는 더하고 분모는 그대로 써요. 4/9 + 2/9 = 6/9입니다.' },
      { question: '7/10 - 3/10의 값은 얼마일까요?', options: ['3/10', '4/10', '4/20', '10/10'], answer: 1, explanation: '분모가 같으므로 분자는 빼고 분모는 그대로 써요. 7/10 - 3/10 = 4/10입니다.' },
    ],
  },
  {
    subject: '사회', title: '우리 지역의 생활 모습',
    objective: '우리 지역의 자연환경과 생활 모습의 관계를 살펴볼 수 있어요.',
    minutes: 18, questions: 3, level: '보통', accent: 'green',
    problems: [
      { question: '사람들이 강 주변에 모여 살게 된 까닭으로 알맞은 것은 무엇일까요?', options: ['물을 얻고 농사를 짓기 편해서', '산이 하나도 없어서', '비가 전혀 내리지 않아서', '바닷물이 가까워서'], answer: 0, explanation: '강 주변에서는 생활용수와 농업용수를 얻기 쉬워 마을이 발달했어요.' },
      { question: '산지가 많은 지역에서 볼 수 있는 모습으로 알맞은 것은 무엇일까요?', options: ['높낮이가 다른 땅과 계곡', '끝없이 넓은 갯벌', '물이 항상 얼어 있는 바다', '모래만 있는 사막'], answer: 0, explanation: '산지가 많은 지역은 땅의 높낮이가 크고 계곡이 발달해 있어요.' },
      { question: '우리 지역의 모습을 알아보는 데 가장 도움이 되는 자료는 무엇일까요?', options: ['지역 지도와 사진', '다른 나라의 동화책', '요리 방법 안내서', '운동 경기 기록표'], answer: 0, explanation: '지도와 사진을 살펴보면 지역의 위치와 자연환경을 알 수 있어요.' },
    ],
  },
  {
    subject: '과학', title: '식물의 한살이 관찰하기',
    objective: '씨앗이 싹트고 자라는 모습을 순서대로 설명할 수 있어요.',
    minutes: 20, questions: 3, level: '보통', accent: 'green',
    problems: [
      { question: '씨앗이 싹트는 데 꼭 필요한 조건으로 알맞은 것은 무엇일까요?', options: ['물과 알맞은 온도', '강한 바람과 모래', '빛과 비료만', '차가운 얼음'], answer: 0, explanation: '씨앗은 물과 알맞은 온도가 있으면 싹트기 시작해요.' },
      { question: '싹이 난 식물이 자라는 모습을 바르게 관찰하는 방법은 무엇일까요?', options: ['날짜를 적고 길이를 재요.', '하루 만에 모두 뽑아 봐요.', '기억만으로 키를 짐작해요.', '물을 주지 않고 기다려요.'], answer: 0, explanation: '날짜와 길이를 기록하면 식물이 자라는 변화를 비교할 수 있어요.' },
      { question: '꽃이 핀 뒤 식물에서 볼 수 있는 변화는 무엇일까요?', options: ['열매와 씨앗이 생겨요.', '뿌리가 사라져요.', '줄기가 돌로 변해요.', '잎이 모두 흙이 돼요.'], answer: 0, explanation: '꽃이 진 뒤에는 열매가 맺히고 그 안에 새로운 씨앗이 생겨요.' },
    ],
  },
  {
    subject: '영어', title: 'What time is it?',
    objective: '시각을 묻고 답하는 짧은 표현을 읽고 말할 수 있어요.',
    minutes: 15, questions: 3, level: '쉬움', accent: 'red',
    problems: [
      { question: '“What time is it?”에 알맞은 대답은 무엇일까요?', options: ['It is three o’clock.', 'I am ten years old.', 'It is sunny today.', 'My name is Mina.'], answer: 0, explanation: '“What time is it?”은 시각을 묻는 표현이에요. “It is three o’clock.”은 3시라는 뜻이에요.' },
      { question: '“It is seven o’clock.”은 몇 시일까요?', options: ['5시', '6시', '7시', '8시'], answer: 2, explanation: 'seven은 숫자 7을 뜻해요. It is seven o’clock은 7시예요.' },
      { question: '“What time is it?”에 “It is nine o’clock.”이라고 답했어요. 시각은 언제일까요?', options: ['아홉 시', '열 시', '오후 아홉 시라고만 말함', '아홉 살'], answer: 0, explanation: '시각을 말할 때 숫자 뒤에 o’clock을 붙여요. nine o’clock은 9시입니다.' },
    ],
  },
];

const initialRecords: RecordItem[] = [
  { subject: '수학', title: '분수의 덧셈과 뺄셈', date: '10월 2일', score: 100 },
  { subject: '국어', title: '생각을 나타내어요', date: '10월 1일', score: 92 },
  { subject: '사회', title: '우리가 살아가는 지역', date: '9월 30일', score: 88 },
];

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, React.ReactNode> = {
    book: <><path d="M12 6.5C9.7 4.8 6.1 4.4 3 5.4v13c3-.9 6.6-.5 9 1.2 2.4-1.7 6-2.1 9-1.2v-13c-3-1-6.6-.6-9 1.1Z"/><path d="M12 6.5v13"/><path d="M6.5 8.3c1.4-.1 2.7.1 3.8.7"/></>,
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></>,
    pencil: <><path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5 4 16.5Z"/><path d="m13.8 6.7 3.5 3.5"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 11.8-2L20 12M4 12l2.7 5a7 7 0 0 0 11.8-2"/></>,
    library: <><path d="M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Z"/><path d="M4 17a3 3 0 0 1 3-3h12M8 8h7M8 11h5"/></>,
    chart: <><path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 6-7"/><path d="M17 6h3v3"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1H3Z"/><path d="M16 5.5a3 3 0 0 1 0 5.8M18 14a5 5 0 0 1 3 4.5V20h-4"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="1"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    medal: <><circle cx="12" cy="8" r="5"/><path d="m8.5 12-2 9 5.5-3 5.5 3-2-9"/><path d="m12 5.5.8 1.6 1.7.2-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.2.8-1.6Z"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    trend: <><path d="m4 16 5-5 4 3 7-8"/><path d="M15 6h5v5"/></>,
  };
  return <svg {...common}>{paths[name] || paths.book}</svg>;
}

function getStoredRecords() {
  try {
    const value = localStorage.getItem('barunsam-records');
    return value ? (JSON.parse(value) as RecordItem[]) : initialRecords;
  } catch {
    return initialRecords;
  }
}

function App() {
  const [mode, setMode] = useState<'student' | 'parent'>('student');
  const [nav, setNav] = useState('홈');
  const [subject, setSubject] = useState<'전체' | Subject>('전체');
  const [taskIndex, setTaskIndex] = useState(0);
  const [exercise, setExercise] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [problemIndex, setProblemIndex] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [records, setRecords] = useState<RecordItem[]>(getStoredRecords);
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState('10월 학습 습관 만들기 안내');
  const [noticeDraft, setNoticeDraft] = useState(notice);
  const [noteSaved, setNoteSaved] = useState(false);
  const task = taskBank[taskIndex];
  const problem = task.problems[problemIndex];
  const dateLabel = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const completed = Math.max(12, records.length + 9);
  const percentage = Math.min(100, Math.round((completed / 20) * 100));
  const activeTasks = useMemo(() => subject === '전체' ? taskBank : taskBank.filter((item) => item.subject === subject), [subject]);
  const latestRecords = showAll ? records : records.slice(0, 3);

  useEffect(() => {
    localStorage.setItem('barunsam-records', JSON.stringify(records));
  }, [records]);

  function selectSubject(value: '전체' | Subject) {
    setSubject(value);
    if (value === '전체') {
      setTaskIndex(0);
    } else {
      const found = taskBank.findIndex((item) => item.subject === value);
      if (found >= 0) setTaskIndex(found);
    }
  }

  function finishExercise() {
    if (!checked || selectedAnswer === null) return;
    const totalCorrect = correctCount + (selectedAnswer === problem.answer ? 1 : 0);
    if (problemIndex < task.problems.length - 1) {
      setCorrectCount(totalCorrect);
      setProblemIndex((current) => current + 1);
      setSelectedAnswer(null);
      setChecked(false);
      return;
    }
    const score = Math.round((totalCorrect / task.problems.length) * 100);
    const entry: RecordItem = { subject: task.subject, title: task.title, date: dateLabel, score };
    setRecords((current) => [entry, ...current]);
    setExercise(false);
    setProblemIndex(0);
    setCorrectCount(0);
    setSelectedAnswer(null);
    setChecked(false);
    setNav('홈');
  }

  function openExercise() {
    setProblemIndex(0);
    setCorrectCount(0);
    setSelectedAnswer(null);
    setChecked(false);
    setExercise(true);
  }

  function renderTaskCard(item: Task, index: number, compact = false) {
    return <button className={`assignment-row ${compact ? 'assignment-row-compact' : ''}`} key={`${item.subject}-${item.title}`} onClick={() => { setTaskIndex(index); setSubject(item.subject); setNav('학습'); }}>
      <span className={`subject-mark ${item.accent}`}>{item.subject.slice(0, 1)}</span>
      <span className="assignment-copy"><strong>{item.title}</strong><small>{item.questions}문항 · {item.minutes}분 · {item.level}</small></span>
      <span className="assignment-action"><Icon name="arrow" size={18} /></span>
    </button>;
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => { setNav('홈'); setMode('student'); }} aria-label="바른쌤 홈">
        <span className="brand-symbol"><Icon name="book" size={34} /><i /></span>
        <span className="brand-name">바른쌤</span><span className="brand-sub">초등 학습</span>
      </button>
      <nav className="main-nav" aria-label="주요 메뉴">
        {['홈', '학습', '복습', '도서관', '나의 기록'].map((item) => <button key={item} className={nav === item ? 'active' : ''} onClick={() => setNav(item)}>{item}</button>)}
      </nav>
      <div className="topbar-tools">
        <div className="mode-switch" role="group" aria-label="모드 선택">
          <button className={mode === 'parent' ? 'selected' : ''} onClick={() => { setMode('parent'); setNav('홈'); }}><Icon name="users" size={17} /> 학부모 모드</button>
          <button className={mode === 'student' ? 'selected' : ''} onClick={() => { setMode('student'); setNav('홈'); }}><Icon name="book" size={17} /> 학생 모드</button>
        </div>
        <button className="profile-button" aria-label="김하윤 학생 프로필"><span className="profile-name">김하윤</span><span>4학년 2반</span></button>
      </div>
    </header>

    {mode === 'student' ? <main className="student-page">
      <div className="student-topline"><span>{dateLabel}</span><button className="schedule-button" onClick={() => setNav('나의 기록')}>학습 일정 <Icon name="calendar" size={19} /></button></div>
      <section className="student-hero" aria-labelledby="page-title">
        <div className="hero-intro">
          <p className="eyebrow">BARUNSSAM LEARNING NOTE</p>
          <h1 id="page-title">오늘의<br />학습</h1>
          <p className="greeting">김하윤 학생, 오늘도<br />차근차근 실력을 쌓아가요!</p>
          <blockquote><span>오늘의 한 줄</span><p>작은 노력이 모여<br />큰 성취가 됩니다.</p><cite>— 윌리엄 제임스 —</cite></blockquote>
        </div>
        <div className="hero-workspace">
          <div className="subject-tabs" role="tablist" aria-label="과목 선택">
            {subjects.map((item) => <button key={item} role="tab" aria-selected={subject === item} className={subject === item ? 'active' : ''} onClick={() => selectSubject(item)}>{item}</button>)}
          </div>
          <div className="featured-assignment">
            <div className="assignment-details">
              <span className="task-kicker">오늘의 과제</span>
              <p className="featured-subject">{task.subject}</p>
              <h2>{task.title}</h2>
              <h3>학습 목표</h3>
              <p className="objective">{task.objective}</p>
              <div className="task-meta">
                <div><Icon name="clock" size={25} /><span>예상 시간<strong>{task.minutes}분</strong></span></div>
                <div><Icon name="book" size={25} /><span>문항 수<strong>{task.questions}문항</strong></span></div>
                <div><Icon name="medal" size={25} /><span>난이도<strong>{task.level}</strong></span></div>
              </div>
            </div>
            <div className="paper-stage" aria-label="문제 미리보기">
              <div className="paper-sheet paper-sheet-back"><span className="paper-number">2</span><span className="paper-line" /><span className="paper-line short" /><span className="paper-line" /><span className="paper-line mid" /></div>
              <div className="paper-sheet paper-sheet-front">
                <div className="paper-top"><span>{task.subject}　4-1</span><b>1</b></div>
                <p className="paper-question">1　{task.problems[0].question}</p>
                <div className="reading-box"><strong>{task.subject} 생각 열기</strong><p>{task.problems[0].explanation}</p><span className="leaf-ornament" aria-hidden="true"><svg viewBox="0 0 56 64" fill="none"><path d="M24 60c0-18 8-35 22-49M27 48C18 37 9 37 4 39c4 9 11 13 23 9ZM33 38c1-11 9-17 19-17-2 11-8 18-19 17ZM20 57c-3-8-9-11-17-10 3 8 8 12 17 10Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"/><path d="M45 11V4m-5 9-5-4m13 3 5-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/></svg></span></div>
                <div className="paper-answer"><b>1</b><span>알맞은 답을 골라 표시해 보세요.</span></div>
                <div className="paper-choices"><span>① 생각해 보기</span><span>② 천천히 읽기</span></div>
              </div>
              <button className="start-button" onClick={openExercise}>학습 시작 <Icon name="arrow" size={22} /></button>
            </div>
          </div>
        </div>
      </section>

      {nav === '홈' ? <section className="student-bottom-grid">
        <article className="info-panel goal-panel">
          <div className="panel-heading"><h2>이번 주 학습 목표</h2><button onClick={() => setNav('나의 기록')}>자세히 보기 <Icon name="arrow" size={15} /></button></div>
          <div className="goal-content"><div className="progress-ring" style={{ '--progress': `${percentage}%` } as React.CSSProperties}><div><strong>{percentage}%</strong><span>달성</span></div></div><div className="goal-stats"><p>전체 20개 중 {completed}개 완료</p><div className="progress-track"><span style={{ width: `${percentage}%` }} /></div><div className="goal-foot"><span>남은 과제　{Math.max(0, 20 - completed)}개</span><span>예상 완료일　10월 10일 (토)</span></div></div></div>
        </article>
        <article className="info-panel recent-panel">
          <div className="panel-heading"><h2>최근 학습 기록</h2><button onClick={() => setShowAll((value) => !value)}>{showAll ? '접기' : '더보기'} <Icon name="arrow" size={15} /></button></div>
          <div className="record-list">{latestRecords.map((record, index) => <div className="record-row" key={`${record.title}-${index}`}><span className={`subject-mark ${record.subject === '국어' || record.subject === '영어' ? 'red' : record.subject === '사회' || record.subject === '과학' ? 'green' : 'blue'}`}>{record.subject.slice(0, 1)}</span><strong>{record.title}</strong><time>{record.date}</time><span className="score-pill">{record.score}점</span></div>)}</div>
        </article>
        <article className="info-panel notice-panel">
          <div className="panel-heading"><h2>공지사항</h2><button onClick={() => setNoticeDraft(notice)}>더보기 <Icon name="arrow" size={15} /></button></div>
          <ul><li><span>{notice}</span><time>10/03</time></li><li><span>시스템 점검 안내 (10/08 새벽)</span><time>10/02</time></li><li><span>신규 도서관 도서 추가 안내</span><time>10/01</time></li></ul>
        </article>
      </section> : <section className="student-list-section"><div className="section-title"><div><p className="eyebrow">MY STUDY</p><h2>{nav === '학습' ? '오늘의 학습' : nav === '복습' ? '다시 풀어보기' : nav === '도서관' ? '배움 도서관' : '나의 학습 기록'}</h2></div><span>{activeTasks.length}개의 학습 자료</span></div>{nav === '나의 기록' ? <div className="large-record-list">{records.map((record, index) => <div className="record-row" key={`${record.title}-${index}`}><span className="subject-mark navy">{record.subject.slice(0, 1)}</span><strong>{record.title}</strong><time>{record.date}</time><span className="score-pill">{record.score}점</span></div>)}</div> : <div className="assignment-list">{activeTasks.map((item) => renderTaskCard(item, taskBank.indexOf(item)))}</div>}</section>}
    </main> : <main className="parent-page">
      <div className="parent-welcome"><div><p className="eyebrow">PARENT'S DESK</p><h1>하윤이의 배움을<br />함께 응원해 주세요.</h1><p>오늘도 한 걸음씩 자라고 있어요. 이번 주 학습 흐름을 확인해 보세요.</p></div><div className="child-select"><span>학습자</span><strong>김하윤　4학년 2반</strong><span className="child-avatar">김</span></div></div>
      <section className="parent-overview">
        <article className="parent-stat"><span>이번 주 학습 시간</span><strong>3시간 40분</strong><small><Icon name="trend" size={16} /> 지난주보다 25분 늘었어요</small></article>
        <article className="parent-stat"><span>완료한 문제</span><strong>{completed}<em> / 20문제</em></strong><small>이번 주 목표의 {percentage}%를 달성했어요</small></article>
        <article className="parent-stat"><span>평균 정답률</span><strong>93<em>점</em></strong><small>꾸준한 복습이 큰 도움이 되고 있어요</small></article>
      </section>
      <section className="parent-content-grid">
        <article className="parent-card weekly-card"><div className="panel-heading"><div><p className="eyebrow">WEEKLY REPORT</p><h2>과목별 학습 현황</h2></div><span>이번 주</span></div><div className="subject-progress-list">{subjects.slice(1).map((item, index) => <div className="subject-progress" key={item}><div><span className={`subject-mark ${['navy', 'red', 'blue', 'green', 'navy'][index]}`}>{item.slice(0, 1)}</span><strong>{item}</strong><span>{[4, 3, 2, 2, 1][index]}개 완료</span></div><div className="progress-track"><span style={{ width: `${[82, 64, 54, 42, 38][index]}%` }} /></div></div>)}</div></article>
        <article className="parent-card assignment-manager"><div className="panel-heading"><div><p className="eyebrow">ASSIGNMENT</p><h2>오늘의 학습 과제</h2></div><button className="text-action" onClick={() => { setMode('student'); setNav('학습'); }}>과제 보기 <Icon name="arrow" size={15} /></button></div><p className="parent-task-title">{task.title}</p><p className="parent-task-sub">{task.subject} · {task.questions}문항 · 약 {task.minutes}분</p><div className="assignment-manager-foot"><span><Icon name="check" size={17} /> 오늘 할 과제 1개</span><button className="outline-button" onClick={() => { setMode('student'); setNav('학습'); }}>학습 살펴보기</button></div></article>
        <article className="parent-card parent-records"><div className="panel-heading"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>최근 학습 기록</h2></div><button className="text-action" onClick={() => setShowAll((value) => !value)}>{showAll ? '접기' : '전체 보기'} <Icon name="arrow" size={15} /></button></div><div className="record-list">{latestRecords.slice(0, 4).map((record, index) => <div className="record-row" key={`parent-${record.title}-${index}`}><span className={`subject-mark ${record.subject === '국어' || record.subject === '영어' ? 'red' : 'blue'}`}>{record.subject.slice(0, 1)}</span><strong>{record.title}</strong><time>{record.date}</time><span className="score-pill">{record.score}점</span></div>)}</div></article>
        <article className="parent-card note-card"><div className="panel-heading"><div><p className="eyebrow">A NOTE FOR TODAY</p><h2>오늘의 응원 한마디</h2></div><Icon name="bell" size={20} /></div><p className="note-quote">“작은 노력이 모여<br />큰 성취가 됩니다.”</p><label className="note-label" htmlFor="parent-note">하윤이에게 전할 말을 적어 주세요</label><div className="note-form"><input id="parent-note" value={noticeDraft} onChange={(event) => { setNoticeDraft(event.target.value); setNoteSaved(false); }} /><button onClick={() => { setNotice(noticeDraft); setNoteSaved(true); }}>저장</button></div>{noteSaved && <span className="saved-note"><Icon name="check" size={14} /> 응원 한마디를 저장했어요.</span>}</article>
      </section>
    </main>}

    <footer className="site-footer"><div><span>바른쌤 초등 학습</span><a href="#guide">이용 안내</a><a href="#privacy">개인정보처리방침</a><span>고객센터 02-1234-5678 (평일 09:00~18:00)</span></div><span>© Barunsam. All rights reserved.</span></footer>

    {exercise && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExercise(false); }}><section className="exercise-modal" role="dialog" aria-modal="true" aria-labelledby="exercise-title"><header className="exercise-header"><span className={`subject-mark ${task.accent}`}>{task.subject.slice(0, 1)}</span><div><p>{task.subject} 학습 · {problemIndex + 1} / {task.problems.length}문항</p><h2 id="exercise-title">{task.title}</h2></div><button className="icon-button" aria-label="닫기" onClick={() => setExercise(false)}><Icon name="close" /></button></header><div className="exercise-progress"><span style={{ width: `${((problemIndex + (checked ? 1 : selectedAnswer === null ? 0.22 : 0.45)) / task.problems.length) * 100}%` }} /></div><div className="exercise-body"><p className="question-label">문제 {problemIndex + 1}</p><h3>{problem.question}</h3><div className="answer-options">{problem.options.map((option, index) => <button key={option} className={`${selectedAnswer === index ? 'chosen' : ''} ${checked && index === problem.answer ? 'correct' : ''} ${checked && selectedAnswer === index && index !== problem.answer ? 'incorrect' : ''}`} onClick={() => !checked && setSelectedAnswer(index)}><span>{index + 1}</span>{option}{checked && index === problem.answer && <Icon name="check" size={19} />}</button>)}</div>{checked && <div className={`answer-feedback ${selectedAnswer === problem.answer ? 'right' : 'wrong'}`}><strong>{selectedAnswer === problem.answer ? '정답이에요!' : '아쉽지만 다시 생각해 봐요.'}</strong><p>{problem.explanation}</p></div>}</div><footer className="exercise-footer"><span><Icon name="clock" size={17} /> 천천히 생각해도 괜찮아요.</span>{checked ? <button className="primary-button" onClick={finishExercise}>{problemIndex === task.problems.length - 1 ? '학습 마치기' : '다음 문제'} <Icon name="arrow" size={18} /></button> : <button className="primary-button" disabled={selectedAnswer === null} onClick={() => setChecked(true)}>정답 확인 <Icon name="arrow" size={18} /></button>}</footer></section></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
