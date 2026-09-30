import React, { useEffect, useRef, useState } from 'react';
import { GalleryItem } from '../types';
import { load, save } from '../lib/storage';
import { compressImage, saveSafely } from '../lib/images';
import { syncPublicGallery, fetchPublicGallery } from '../lib/api';

const GALLERY_KEY = 'jc_gallery_v1';
const GALLERY_NOTICE_KEY = 'jc_gallery_notice_v1';
const MAX_GALLERY_PHOTOS = 10;

export function getGalleryPublicUrl() {
  const url = new URL(window.location.href);
  url.search = '?gallery=view';
  return url.toString();
}

export function loadGallery(): GalleryItem[] {
  return load(GALLERY_KEY, []);
}

export function saveGallery(items: GalleryItem[]) {
  save(GALLERY_KEY, items);
}

export function loadGalleryNotice(): string {
  return load(GALLERY_NOTICE_KEY, '');
}

export function saveGalleryNotice(notice: string) {
  save(GALLERY_NOTICE_KEY, notice);
}

export function PublicGallery() {
  const [items, setItems] = useState<GalleryItem[]>(() => loadGallery());
  const [notice, setNotice] = useState(() => loadGalleryNotice());

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
        // 로컬 데이터 유지
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

export default function Gallery() {
  const [items, setItems] = useState<GalleryItem[]>(() => loadGallery());
  const [notice, setNotice] = useState(() => loadGalleryNotice());
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState('');
  const [generating, setGenerating] = useState(false);

  function commitItems(next: GalleryItem[]) {
    setItems(next);
    if (!saveSafely((v) => saveGallery(v as GalleryItem[]), next)) {
      setItems(items);
    }
  }

  function commitNotice(next: string) {
    setNotice(next);
    saveGalleryNotice(next);
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
      const compressed = await Promise.all(targets.map((f) => compressImage(f)));
      const newItems: GalleryItem[] = compressed.map((image) => ({
        id: crypto.randomUUID(),
        image,
        note: '',
      }));
      commitItems([...items, ...newItems]);
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

  // 완료 버튼: 서버에 사진+유의사항을 저장하고 공개 URL 생성
  async function finalizeGallery() {
    if (items.length === 0) {
      alert('등록된 사진이 없습니다. 사진을 먼저 추가해주세요.');
      return;
    }
    setGenerating(true);
    try {
      await syncPublicGallery(items, notice);
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
        주문별 완료 사진과 분리된 공용 사진입니다. 사진은 선택사항이며 최대 {MAX_GALLERY_PHOTOS}장까지 등록할 수 있습니다. 각 사진 아래에
        설명이나 주의사항을 적을 수 있고, ◀ ▶ 버튼으로 순서를 변경할 수 있습니다. 등록이 끝나면
        맨 아래 [완료] 버튼을 눌러 URL을 생성하세요.
      </p>

      {items.length === 0 ? (
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
          placeholder='유의사항을 입력하세요 (선택). 완료 후 공개 화면 맨 위에 표시됩니다.'
        />
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
