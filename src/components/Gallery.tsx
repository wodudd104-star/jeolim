import React, { useRef, useState } from 'react';
import { GalleryItem } from '../types';
import { load, save } from '../lib/storage';
import { compressImage, saveSafely } from '../lib/images';

const GALLERY_KEY = 'jc_gallery_v1';
const MAX_GALLERY_PHOTOS = 10;

export function loadGallery(): GalleryItem[] {
  return load(GALLERY_KEY, []);
}

export function saveGallery(items: GalleryItem[]) {
  save(GALLERY_KEY, items);
}

export default function Gallery() {
  const [items, setItems] = useState<GalleryItem[]>(() => loadGallery());
  const fileInputRef = useRef<HTMLInputElement>(null);

  function commitItems(next: GalleryItem[]) {
    setItems(next);
    if (!saveSafely((v) => saveGallery(v as GalleryItem[]), next)) {
      setItems(items);
    }
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const remaining = MAX_GALLERY_PHOTOS - items.length;
    if (remaining <= 0) {
      alert(`사진은 최대 ${MAX_GALLERY_PHOTOS}장까지 등록할 수 있습니다.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
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
      if (fileInputRef.current) fileInputRef.current.value = '';
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

  return (
    <div className='gallery-shell'>
      <header className='app-header'>
        <div>
          <p className='eyebrow'>절임배추 관리</p>
          <h1>사진 등록</h1>
        </div>
        <div className='header-actions'>
          {items.length < MAX_GALLERY_PHOTOS && (
            <button className='btn btn-primary' onClick={() => fileInputRef.current?.click()}>
              📷 사진 추가 ({items.length}/{MAX_GALLERY_PHOTOS})
            </button>
          )}
          <input
            ref={fileInputRef}
            type='file'
            accept='image/*'
            multiple
            style={{ display: 'none' }}
            onChange={handlePhotoSelect}
          />
        </div>
      </header>

      <p className='panel-hint gallery-hint'>
        사진은 선택사항이며 최대 {MAX_GALLERY_PHOTOS}장까지 등록할 수 있습니다. 각 사진 아래에
        설명이나 주의사항을 적을 수 있고, ◀ ▶ 버튼으로 순서를 변경할 수 있습니다.
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
    </div>
  );
}
