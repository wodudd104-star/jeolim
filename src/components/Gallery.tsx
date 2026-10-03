import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GalleryItem } from '../types';
import { compressImages } from '../lib/images';
import { syncPublicGallery, fetchPublicGallery } from '../lib/api';

const MAX_GALLERY_PHOTOS = 10;

export function getGalleryPublicUrl() {
  const url = new URL(window.location.href);
  url.search = '?gallery=view';
  return url.toString();
}

export function PublicGallery() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const remote = await fetchPublicGallery();
        if (alive && remote && Array.isArray(remote.items)) {
          setItems(remote.items);
          setNotice(String(remote.notice || ''));
        }
      } catch {
        // 서버에 데이터가 없으면 빈 화면 유지
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className='app-shell'>
      <div className='container'>
        <div className='panel public-order'>
          <header className='public-order-header'>
            <h2>절임배추 사진</h2>
          </header>
          {notice && <div className='gallery-notice-box public'>{notice}</div>}
          {items.length === 0 ? (
            <p className='empty'>등록된 사진이 없습니다.</p>
          ) : (
            <div className='gallery-grid public'>
              {items.map((item, idx) => (
                <div key={item.id} className='gallery-card'>
                  <span className='gallery-index'>{idx + 1}번</span>
                  <img className='gallery-image' src={item.image} alt={`사진 ${idx + 1}`} />
                  {item.note && <p className='gallery-public-note'>{item.note}</p>}
                </div>
              ))}
            </div>
          )}
          <p className='public-order-thanks'>이용해주셔서 감사합니다.</p>
        </div>
      </div>
    </div>
  );
}

export default function Gallery({ refreshSignal }: { refreshSignal?: number }) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');

  // 아직 서버에 저장하지 않은 로컬 수정이 있으면 다른 기기 변경을 받아들이지 않음
  const dirtyRef = useRef(false);
  const stateRef = useRef({ items, notice });
  useEffect(() => {
    stateRef.current = { items, notice };
  }, [items, notice]);
  const saveTimerRef = useRef<number | null>(null);

  // 서버에서 사진/공지 불러오기 (서버가 항상 최종 기준)
  const reloadFromServer = useCallback(async () => {
    if (dirtyRef.current) return; // 저장 대기 중인 로컬 수정 보호
    try {
      const remote = await fetchPublicGallery();
      if (remote && Array.isArray(remote.items)) {
        setItems(remote.items);
        setNotice(String(remote.notice || ''));
      }
    } catch {
      // 서버 오류 시 현재 화면 유지
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reloadFromServer();
  }, [reloadFromServer]);

  // 다른 기기에서 사진/공지가 저장되면(SSE) 실시간으로 서버 값 반영
  React.useEffect(() => {
    if (refreshSignal === undefined) return;
    void reloadFromServer();
  }, [refreshSignal, reloadFromServer]);

  // 즉시 서버 저장
  const saveNow = useCallback(async (): Promise<boolean> => {
    const cur = stateRef.current;
    setSaveState('saving');
    setSaveError('');
    try {
      await syncPublicGallery(cur.items, cur.notice);
      dirtyRef.current = false;
      setSaveState('saved');
      return true;
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : '서버 저장에 실패했습니다.');
      return false;
    }
  }, []);

  // 변경 내용은 잠시 모았다가 서버에 저장 (네트워크 과다 요청 방지)
  const scheduleSave = useCallback(
    (delay = 800) => {
      dirtyRef.current = true;
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void saveNow();
      }, delay);
    },
    [saveNow]
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  function commitItems(next: GalleryItem[]) {
    setItems(next);
    scheduleSave(800);
  }

  function commitNotice(next: string) {
    setNotice(next);
    scheduleSave(1200); // 타이핑 중에는 좀 더 대기
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const remaining = MAX_GALLERY_PHOTOS - items.length;
    if (remaining <= 0) {
      alert(`사진은 최대 ${MAX_GALLERY_PHOTOS}장까지 등록할 수 있습니다.`);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    const targets = files.slice(0, remaining);
    if (files.length > remaining) {
      alert(`최대 ${MAX_GALLERY_PHOTOS}장까지 가능하여 ${remaining}장만 추가됩니다.`);
    }
    try {
      // 한 장씩 순차 처리 (스마트폰에서 동시 처리 시 메모리 부족으로 실패하는 것 방지)
      const { images, errors } = await compressImages(targets);
      if (images.length > 0) {
        const newItems: GalleryItem[] = images.map((image) => ({
          id: crypto.randomUUID(),
          image,
          note: '',
        }));
        commitItems([...items, ...newItems]);
      }
      if (errors.length > 0) {
        alert(`일부 사진을 등록하지 못했습니다.\n${errors.join('\n')}`);
      }
    } catch (err: any) {
      alert(err.message || '이미지를 처리하는 중 오류가 발생했습니다.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function updateNote(id: string, note: string) {
    commitItems(items.map((it) => (it.id === id ? { ...it, note } : it)));
  }

  function removeItem(id: string) {
    if (!confirm('이 사진을 삭제할까요?')) return;
    commitItems(items.filter((it) => it.id !== id));
  }

  function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    commitItems(next);
  }

  // 완료 버튼: 서버에 확정 저장하고 공개 URL 생성
  async function finalizeGallery() {
    if (items.length === 0) {
      alert('등록된 사진이 없습니다. 사진을 먼저 추가해주세요.');
      return;
    }
    setGenerating(true);
    try {
      const ok = await saveNow();
      if (!ok) {
        alert(saveError || '서버 저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
        return;
      }
      const url = getGalleryPublicUrl();
      setGeneratedUrl(url);
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // 클립보드 실패 시 URL 표시만
      }
    } catch (err: any) {
      alert(err?.message || 'URL 생성에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setGenerating(false);
    }
  }

  async function copyUrl() {
    const url = generatedUrl || getGalleryPublicUrl();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('아래 URL을 복사해주세요.', url);
    }
  }

  return (
    <div className='gallery-shell'>
      <header className='app-header'>
        <div>
          <p className='eyebrow'>절임배추 관리</p>
          <h1>사진 등록</h1>
        </div>
        <div className='header-actions'>
          {items.length < MAX_GALLERY_PHOTOS && (
            <button className='btn btn-primary' onClick={() => inputRef.current?.click()}>
              📷 사진 추가 ({items.length}/{MAX_GALLERY_PHOTOS})
            </button>
          )}
          <input
            ref={inputRef}
            type='file'
            accept='image/*'
            multiple
            style={{ display: 'none' }}
            onChange={handlePhotoSelect}
          />
        </div>
      </header>

      <p className='panel-hint gallery-hint'>
        사진은 서버에 자동 저장되어 모든 기기에서 실시간으로 함께 보입니다 (최대 {MAX_GALLERY_PHOTOS}장). 각 사진 아래에
        설명이나 주의사항을 적을 수 있고, ◀ ▶ 버튼으로 순서를 변경할 수 있습니다. 등록이 끝나면
        맨 아래 [완료] 버튼을 눌러 공개 URL을 생성하세요.
      </p>

      {!loaded ? (
        <div className='empty'>사진을 불러오는 중...</div>
      ) : items.length === 0 ? (
        <div className='empty'>등록된 사진이 없습니다. 위 버튼으로 사진을 추가하세요.</div>
      ) : (
        <div className='gallery-grid'>
          {items.map((item, idx) => (
            <div key={item.id} className='gallery-card'>
              <div className='gallery-order'>
                <span className='gallery-index'>{idx + 1}번</span>
                <div className='gallery-order-actions'>
                  <button
                    className='btn icon small'
                    onClick={() => moveItem(idx, -1)}
                    disabled={idx === 0}
                    title='앞으로'
                  >
                    ◀
                  </button>
                  <button
                    className='btn icon small'
                    onClick={() => moveItem(idx, 1)}
                    disabled={idx === items.length - 1}
                    title='뒤로'
                  >
                    ▶
                  </button>
                  <button
                    className='btn icon small danger'
                    onClick={() => removeItem(item.id)}
                    title='삭제'
                  >
                    ✕
                  </button>
                </div>
              </div>
              <img className='gallery-image' src={item.image} alt={`등록 사진 ${idx + 1}`} />
              <textarea
                className='input gallery-note'
                rows={3}
                value={item.note}
                onChange={(e) => updateNote(item.id, e.target.value)}
                placeholder='설명이나 주의사항을 입력하세요 (선택)'
              />
            </div>
          ))}
        </div>
      )}

      <div className='gallery-notice-section'>
        <label className='gallery-notice-label'>⚠️ 유의사항</label>
        <textarea
          className='input gallery-notice-textarea'
          rows={4}
          value={notice}
          onChange={(e) => commitNotice(e.target.value)}
          placeholder='유의사항을 입력하세요 (선택). 공개 화면 맨 위에 표시됩니다.'
        />
      </div>

      <div className='gallery-save-status' aria-live='polite'>
        {saveState === 'saving' && <span className='gallery-save-saving'>서버 저장 중...</span>}
        {saveState === 'saved' && <span className='gallery-save-saved'>✓ 서버에 저장되었습니다 (모든 기기 연동)</span>}
        {saveState === 'error' && (
          <span className='gallery-save-error'>⚠ 저장 실패: {saveError} — [완료] 버튼으로 다시 시도해주세요.</span>
        )}
      </div>

      <div className='gallery-final'>
        <button
          className='btn btn-primary gallery-final-btn'
          onClick={finalizeGallery}
          disabled={generating}
        >
          {generating ? 'URL 생성 중...' : '✅ 완료 (URL 생성)'}
        </button>
        {generatedUrl && (
          <div className='gallery-url-box'>
            <p className='gallery-url-label'>
              공개 URL이 생성되었습니다. 아래 버튼으로 복사하여 전달하세요.
            </p>
            <div className='gallery-url-row'>
              <input className='input gallery-url-input' readOnly value={generatedUrl} />
              <button className='btn btn-primary' onClick={copyUrl}>
                {copied ? '✓ 복사됨' : 'URL 복사'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
